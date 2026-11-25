"""실행 명령 추적(services/command_trace.py) — 관리자 "로그 보기" 에 실제로 나간 명령이 먼저 남는지."""
import base64
import json
import subprocess
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.security import create_access_token, hash_password
from app.database import Base, SessionLocal, engine
from app.models.user import User
from app.services import command_trace as ct
from app.services.sse import stream_async_job


# DB 사용자 — 미들웨어는 토큰 role 이 admin 이어도 DB 의 현재 역할을 다시 본다.
_USERS = {"ct-admin": "admin", "ct-operator": "operator", "ct-viewer": "viewer",
          "ct-demoted": "operator", "ct-inactive": "admin"}


@pytest.fixture(scope="module", autouse=True)
def _db_users():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        for name, role in _USERS.items():
            u = db.query(User).filter(User.username == name).first()
            if u is None:
                u = User(username=name, hashed_password=hash_password("x" * 12))
                db.add(u)
            u.role, u.is_active = role, name != "ct-inactive"
        db.commit()
        yield
        db.query(User).filter(User.username.in_(list(_USERS))).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
        ct.forget_user()


def _auth(role: str, user: str | None = None) -> dict:
    name = user or f"ct-{role}"
    return {"Authorization": f"Bearer {create_access_token(subject=name, role=role)}"}


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

    # operator · 토큰 없음 · 강등됐는데 옛 admin 토큰 · 비활성 admin · DB 에 없는 사용자 — 모두 명령을 받지 못한다.
    for headers in (_auth("operator"), {}, _auth("admin", "ct-demoted"), _auth("admin", "ct-inactive"),
                    _auth("admin", "ct-nobody")):
        r = client.post("/run", headers=headers)
        assert r.status_code == 200 and r.json()["admin"] is False
        assert ct.HEADER not in r.headers


def test_role_change_takes_effect_immediately():
    client = TestClient(_app())
    headers = _auth("admin")
    assert ct.HEADER in client.post("/run", headers=headers).headers  # 캐시에 관리자로 올라감
    db = SessionLocal()
    try:
        db.query(User).filter(User.username == "ct-admin").update({"role": "operator"})
        db.commit()
        assert ct.HEADER in client.post("/run", headers=headers).headers  # 캐시(10초) 안에서는 그대로
        ct.forget_user("ct-admin")  # 역할 변경 API 가 부르는 것
        r = client.post("/run", headers=headers)
        assert ct.HEADER not in r.headers and r.json()["admin"] is False
    finally:
        db.query(User).filter(User.username == "ct-admin").update({"role": "admin"})
        db.commit()
        db.close()
        ct.forget_user()


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
