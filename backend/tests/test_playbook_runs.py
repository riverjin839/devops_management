"""플레이북 백그라운드 실행 — 실시간 로그(R1) · 취소(R2).

- executor: stderr 의 ``PEP_EVENT`` 줄을 실행 중에 넘기고, 취소 요청이면 프로세스 그룹을 끊는다.
- service: 진행 줄을 ``PlaybookRun.log_lines`` 에 쌓고, 취소는 판정이 아니라 플레이북 상태·최신
  스냅샷을 그대로 둔다.
- router: 시작(202 + run_id) · 진행 조회(since) · 중복 실행 409 · 취소 · 사라진 실행 마감.
"""
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi import HTTPException  # noqa: E402

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models import Cluster, Playbook, PlaybookRun  # noqa: E402
from app.models.user import User  # noqa: E402
from app.routers import playbooks as playbooks_router  # noqa: E402
from app.schemas.playbook import PlaybookRunRequest  # noqa: E402
from app.services import playbook_executor, playbook_service  # noqa: E402
from app.services.cluster_access import ClusterScope  # noqa: E402
from app.services.playbook_executor import PlaybookResult  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def playbook(db):
    cluster = Cluster(name=f"pbrun-{uuid.uuid4().hex[:8]}", api_endpoint="https://10.0.0.1:6443")
    db.add(cluster)
    db.commit()
    pb = Playbook(
        cluster_id=cluster.id, name="점검", playbook_path="/tmp/site.yml",
        status="healthy", last_result={"message": "이전 결과"},
    )
    db.add(pb)
    db.commit()
    yield pb
    db.rollback()
    db.query(PlaybookRun).filter(PlaybookRun.playbook_id == pb.id).delete()
    db.delete(pb)
    db.delete(cluster)
    db.commit()


@pytest.fixture
def admin():
    return User(id=uuid.uuid4(), username="admin-test", role="admin")


# ── executor ────────────────────────────────────────────────────────────────


def test_streaming_forwards_events_and_keeps_json_stdout():
    script = (
        "import sys, json, time\n"
        "sys.stderr.write('PEP_EVENT ' + json.dumps({'level': 'info', 'message': 'TASK [ping]'}) + '\\n'); sys.stderr.flush()\n"
        "sys.stderr.write('[WARNING]: noisy\\n'); sys.stderr.flush()\n"
        "print(json.dumps({'stats': {}}))\n"
    )
    events = []
    result, outcome = playbook_executor._run_streaming(
        [sys.executable, "-c", script], dict(os.environ), 30, lambda lv, msg: events.append((lv, msg)), None,
    )
    assert outcome == "done"
    assert ("info", "TASK [ping]") in events
    assert ("warn", "[WARNING]: noisy") in events
    assert json.loads(result.stdout) == {"stats": {}}
    assert "PEP_EVENT" not in result.stderr  # 이벤트 줄은 원문 stderr 에서 뺀다


def test_streaming_cancel_kills_process_quickly():
    t0 = time.monotonic()
    calls = {"n": 0}

    def should_cancel():
        calls["n"] += 1
        return calls["n"] >= 2

    _result, outcome = playbook_executor._run_streaming(
        [sys.executable, "-c", "import time; time.sleep(60)"], dict(os.environ), 120, None, should_cancel,
    )
    assert outcome == "cancelled"
    assert time.monotonic() - t0 < 15


def test_streaming_timeout():
    _result, outcome = playbook_executor._run_streaming(
        [sys.executable, "-c", "import time; time.sleep(60)"], dict(os.environ), 1, None, None,
    )
    assert outcome == "timeout"


# ── service ─────────────────────────────────────────────────────────────────


def _fake_run(status="healthy", cancel_after_events=False):
    def fake(**kwargs):
        on_event, should_cancel = kwargs["on_event"], kwargs["should_cancel"]
        on_event("info", "PLAY [all]")
        on_event("info", "TASK [ping]")
        if cancel_after_events:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if should_cancel():
                    return PlaybookResult(status="cancelled", message="취소됨", duration_ms=5)
                time.sleep(0.1)
            return PlaybookResult(status="critical", message="취소가 전달되지 않음", duration_ms=5)
        should_cancel()
        return PlaybookResult(status=status, message="OK: done", duration_ms=12, stats={"totals": {"ok": 1}})
    return fake


def test_perform_run_stores_log_lines_and_result(db, playbook, monkeypatch):
    monkeypatch.setattr(playbook_service, "run_playbook", _fake_run("healthy"))
    run, result = playbook_service.execute_playbook_run(db, playbook, trigger="manual")
    assert result.status == "healthy"
    assert run.status == "healthy" and run.finished_at is not None
    messages = [line[2] for line in run.log_lines]
    assert "PLAY [all]" in messages and "TASK [ping]" in messages
    assert any(m.startswith("종료 · healthy") for m in messages)
    assert playbook.status == "healthy"
    assert playbook.last_result["message"] == "OK: done"


def test_cancel_keeps_previous_playbook_status(db, playbook, monkeypatch):
    monkeypatch.setattr(playbook_service, "run_playbook", _fake_run(cancel_after_events=True))
    run, prev = playbook_service.begin_playbook_run(db, playbook)
    assert run.status == "running" and prev == "healthy"

    # 다른 세션(다른 replica)에서 취소 요청
    other = SessionLocal()
    try:
        other.query(PlaybookRun).filter(PlaybookRun.id == run.id).update({"cancel_requested": True})
        other.commit()
    finally:
        other.close()

    result = playbook_service.perform_playbook_run(db, playbook, run, prev_status=prev, flush_interval=0)
    assert result.status == "cancelled"
    assert run.status == "cancelled"
    assert playbook.status == "healthy"  # 취소는 판정이 아니다
    assert playbook.last_result == {"message": "이전 결과"}


def test_log_buffer_caps_lines():
    buf = playbook_service.RunLogBuffer(limit=3)
    for i in range(5):
        buf.add("info", f"line {i}")
    snap = buf.snapshot()
    assert snap[0][1] == "warn" and "2줄 생략" in snap[0][2]
    assert [x[2] for x in snap[1:]] == ["line 2", "line 3", "line 4"]


# ── router ──────────────────────────────────────────────────────────────────


def test_start_run_returns_run_id_and_progress_streams(db, playbook, admin, monkeypatch):
    captured = {}

    def fake_start(run_id, prev_status, creds):
        captured.update(run_id=run_id, prev=prev_status, creds=creds)

    monkeypatch.setattr(playbooks_router, "start_background_run", fake_start)
    monkeypatch.setattr(playbooks_router.audit_logger, "record", lambda *a, **k: None)
    res = playbooks_router.start_playbook_run(
        playbook.id, request=None, payload=PlaybookRunRequest(ssh_username="ops", ssh_password="pw"),
        db=db, actor=admin,
    )
    assert res.status == "running"
    assert captured["run_id"] == res.run_id
    assert captured["creds"]["ssh_password"] == "pw"  # 스레드에만 넘긴다
    run = db.query(PlaybookRun).filter(PlaybookRun.id == res.run_id).one()
    assert "pw" not in json.dumps(run.log_lines or [])

    # 같은 플레이북 중복 실행은 409
    with pytest.raises(HTTPException) as exc:
        playbooks_router.start_playbook_run(playbook.id, request=None, payload=PlaybookRunRequest(), db=db, actor=admin)
    assert exc.value.status_code == 409

    # 실행 스레드 대신 직접 수행 → 진행 조회
    monkeypatch.setattr(playbook_service, "run_playbook", _fake_run("warning"))
    playbook_service.perform_playbook_run(db, playbook, run, prev_status=captured["prev"])
    prog = playbooks_router.get_playbook_run(res.run_id, since=0, db=db, scope=ClusterScope(frozenset()))
    assert prog.finished and prog.status == "warning"
    assert prog.next == len(prog.log_lines)
    tail = playbooks_router.get_playbook_run(res.run_id, since=prog.next - 1, db=db, scope=ClusterScope(frozenset()))
    assert len(tail.log_lines) == 1 and tail.next == prog.next

    # 숨김 클러스터면 404
    with pytest.raises(HTTPException) as exc:
        playbooks_router.get_playbook_run(res.run_id, since=0, db=db, scope=ClusterScope(frozenset({playbook.cluster_id})))
    assert exc.value.status_code == 404


def test_cancel_endpoint_sets_flag_and_is_idempotent(db, playbook, admin, monkeypatch):
    monkeypatch.setattr(playbooks_router.audit_logger, "record", lambda *a, **k: None)
    run, _prev = playbook_service.begin_playbook_run(db, playbook)
    prog = playbooks_router.cancel_playbook_run(run.id, request=None, db=db, actor=admin)
    assert prog.cancel_requested and prog.cancelled_by == "admin-test"
    assert prog.status == "running"  # 실제 중단은 실행 스레드가 한다

    run.status = "healthy"
    run.finished_at = datetime.utcnow()
    db.commit()
    again = playbooks_router.cancel_playbook_run(run.id, request=None, db=db, actor=admin)
    assert again.status == "healthy" and again.finished


def test_stale_running_run_is_reaped(db, playbook):
    run, _prev = playbook_service.begin_playbook_run(db, playbook)
    run.started_at = datetime.utcnow() - timedelta(hours=3)
    db.commit()
    prog = playbooks_router.get_playbook_run(run.id, since=0, db=db, scope=ClusterScope(frozenset()))
    assert prog.finished and prog.status == "critical"
    assert "중단" in prog.message
    db.refresh(playbook)
    assert playbook.status == "critical"


# ── 실제 ansible-core 로 콜백 플러그인 검증 (ansible-playbook 이 없으면 건너뜀) ────────────


def _ansible_bin():
    import shutil
    venv_bin = os.path.dirname(sys.executable)
    return shutil.which("ansible-playbook", path=f"{venv_bin}:{os.environ.get('PATH', '')}"), venv_bin


@pytest.mark.skipif(_ansible_bin()[0] is None, reason="ansible-playbook 없음")
def test_real_ansible_streams_events_and_parses_result(tmp_path, monkeypatch):
    _bin, venv_bin = _ansible_bin()
    (tmp_path / "site.yml").write_text(
        "- hosts: all\n  gather_facts: false\n  tasks:\n"
        "    - name: ping\n      ping:\n"
        "    - name: boom\n      command: /bin/false\n"
    )
    (tmp_path / "inv.ini").write_text(f"localhost ansible_connection=local ansible_python_interpreter={sys.executable}\n")
    orig = playbook_executor._run_streaming
    # 실행기는 PATH 를 고정하므로(이미지 기준) 테스트 환경의 ansible 이 보이게 앞에 붙인다.
    monkeypatch.setattr(
        playbook_executor, "_run_streaming",
        lambda cmd, env, t, on, sc: orig(cmd, {**env, "PATH": f"{venv_bin}:{env['PATH']}"}, t, on, sc),
    )
    events = []
    r = playbook_executor.run_playbook(
        playbook_path=str(tmp_path / "site.yml"), inventory_path=str(tmp_path / "inv.ini"), timeout=120,
        on_event=lambda lv, msg: events.append((lv, msg)),
    )
    messages = [m for _lv, m in events]
    assert "TASK [ping]" in messages and "TASK [boom]" in messages
    assert any(lv == "error" and "failed: [localhost]" in m for lv, m in events)
    assert r.status == "critical"
    assert r.stats["totals"]["failures"] == 1
    assert r.stats["failed_tasks"][0]["task"] == "boom"
    assert "TASK [boom]" in r.raw_output  # 원문 로그는 사람이 읽는 기본 출력


def test_parse_result_uses_callback_payload():
    import subprocess
    cp = subprocess.CompletedProcess(["ansible-playbook"], 0, "PLAY RECAP ...", "")
    cp.result_payload = {"stats": {"h1": {"ok": 2, "changed": 0, "failures": 0, "unreachable": 0, "skipped": 0}}, "plays": []}
    r = playbook_executor._parse_result(cp, 10)
    assert r.status == "healthy" and r.stats["totals"]["ok"] == 2
