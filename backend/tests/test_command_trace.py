"""실행 명령 추적(services/command_trace.py) — 관리자 "로그 보기" 에 실제로 나간 명령이 먼저 남는지."""
import base64
import json
import subprocess
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.security import create_access_token
from app.services import command_trace as ct
from app.services.sse import stream_async_job


def _auth(role: str) -> dict:
    return {"Authorization": f"Bearer {create_access_token(subject=f'u-{role}', role=role)}"}


def _decode_header(raw: str) -> list[str]:
    return json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode())


# ── 마스킹·포맷 ──────────────────────────────────────────────────────────────

def test_mask_hides_secrets_but_keeps_normal_words():
    cases = {
        "sshpass -p hunter2 ssh x": "sshpass -p *** ssh x",
        "mysql --password=pw -u root": "mysql --password=*** -u root",
        "mysql --password pw -u root": "mysql --password *** -u root",
        'curl -H "Authorization: Bearer abc.def" https://x': 'curl -H "Authorization: Bearer ***" https://x',
        "git clone https://u:tok@host/r": "git clone https://u:***@host/r",
        "export TOKEN=abc; ls": "export TOKEN=***; ls",
        '-e {"ansible_password": "s3cr3t", "x": 1}': '-e {"ansible_password": ***, "x": 1}',
        "kubectl --kubeconfig /tmp/k/a get nodes": "kubectl --kubeconfig <kubeconfig> get nodes",
        # 비밀 단어가 들어가도 값을 받는 꼴이 아니면 그대로 둔다.
        "kubectl get secret -n kube-system": "kubectl get secret -n kube-system",
        "kubeadm token create": "kubeadm token create",
        "etcdctl --key=/etc/k.key endpoint status": "etcdctl --key=/etc/k.key endpoint status",
    }
    for raw, want in cases.items():
        assert ct.mask(raw) == want, raw


def test_format_command_shortens_heredoc_and_quotes_argv():
    body = "\n".join(str(i) for i in range(30))
    line = ct.format_command("ssh", "root@h:22", f"tee /etc/x <<'EOF'\n{body}\nEOF")
    assert line.startswith("$ [ssh root@h:22] tee /etc/x <<'EOF'")
    assert "줄 생략" in line and "\n29" not in line
    assert ct.format_command("local", "kubectl", ["kubectl", "get", "po", "-l", "a b"]) == \
        "$ [local kubectl] kubectl get po -l 'a b'"


# ── sink·감사 훅·스레드 ───────────────────────────────────────────────────────

def test_subprocess_audit_hook_records_only_when_bound():
    ct.install()
    got: list[str] = []
    subprocess.run([sys.executable, "-c", "pass"], check=True)  # sink 없음 → 기록 없음
    with ct.bind(got.append):
        subprocess.run([sys.executable, "-c", "print(1)"], capture_output=True, check=True)
    subprocess.run([sys.executable, "-c", "pass"], check=True)
    assert len(got) == 1
    assert got[0].startswith("$ [local python") and "print(1)" in got[0]


def test_context_executor_carries_sink_into_threads():
    got: list[str] = []
    with ct.bind(got.append):
        with ct.ContextThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda i: ct.record("ssh", f"h{i}", "uptime"), range(3)))
    assert sorted(got) == [f"$ [ssh h{i}] uptime" for i in range(3)]


def test_exec_ssh_records_command_before_connecting():
    from app.services.ssh_runner import SSHTarget, _exec_ssh

    got: list[str] = []
    with ct.bind(got.append):
        r = _exec_ssh(SSHTarget(host="127.0.0.1", port=1, username="root", password="pw"),
                      "sysctl -e vm.swappiness", connect_timeout=1, exec_timeout=1)
    assert r.status != "ok"  # 접속은 실패해도 무엇을 날리려 했는지는 남는다
    assert got == ["$ [ssh root@127.0.0.1:1] sysctl -e vm.swappiness"]


def test_filter_log_lines_hides_cmd_for_non_admin():
    lines = [["t", "info", "a"], ["t", "cmd", "$ [ssh h] ls"], {"level": "cmd", "message": "x"},
             "[10:00:00] CMD $ [ssh h] ls", "[10:00:01] 완료"]
    assert ct.filter_log_lines(lines, True) == lines
    assert ct.filter_log_lines(lines, False) == [["t", "info", "a"], "[10:00:01] 완료"]
    assert ct.visible_lines(lines) == [["t", "info", "a"], "[10:00:01] 완료"]  # 요청 밖 = 비관리자


def test_encode_header_caps_size():
    raw = ct.encode_header([f"$ [ssh h] {'x' * 1500} {i}" for i in range(100)])
    assert raw is not None and len(raw) <= ct.MAX_HEADER_BYTES
    items = _decode_header(raw.decode())
    assert items[-1].startswith("…")
    assert ct.encode_header([]) is None


# ── 미들웨어(단건 요청)·SSE ───────────────────────────────────────────────────

def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(ct.CommandTraceMiddleware)

    @app.post("/run")
    def run_sync():  # sync 라우트 — anyio 스레드풀로 컨텍스트가 넘어가야 한다
        ct.record("ssh", "root@n1:22", "systemctl restart kubelet")
        return {"ok": True, "admin": ct.viewer_is_admin()}

    @app.post("/stream")
    async def run_stream():
        async def job(_sdb, emit):
            ct.record("ssh", "root@n1:22", "cat /etc/hosts")
            emit({"type": "log", "level": "info", "ts": "t", "message": "done"})
            return {"ok": True}

        return stream_async_job(job, name="t")

    return app


def test_middleware_returns_commands_header_for_admin_only():
    client = TestClient(_app())
    r = client.post("/run", headers=_auth("admin"))
    assert r.status_code == 200 and r.json()["admin"] is True
    assert _decode_header(r.headers[ct.HEADER]) == ["$ [ssh root@n1:22] systemctl restart kubelet"]

    for headers in (_auth("operator"), {}):
        r = client.post("/run", headers=headers)
        assert r.status_code == 200 and r.json()["admin"] is False
        assert ct.HEADER not in r.headers


def _events(body: str) -> list[dict]:
    return [json.loads(ln[5:]) for ln in body.splitlines() if ln.startswith("data:")]


def test_stream_emits_cmd_events_for_admin_only():
    client = TestClient(_app())
    evts = _events(client.post("/stream", headers=_auth("admin")).text)
    assert evts[0] == {**evts[0], "type": "log", "level": "cmd", "message": "$ [ssh root@n1:22] cat /etc/hosts"}
    assert evts[-1]["type"] == "result"

    evts = _events(client.post("/stream", headers=_auth("viewer")).text)
    assert all(e.get("level") != "cmd" for e in evts)
    assert [e["type"] for e in evts] == ["log", "result"]
