"""D-135 — versions 수집(SSH) SSE 실시간 로그 회귀 테스트.

수집 모달 5종은 동기 응답이라 모든 호스트가 끝나야 실행 로그가 보였다. `/stream` 엔드포인트가
호스트가 끝날 때마다 log·step 을 흘리고 마지막에 동기 응답과 같은 본문을 ``result`` 로 보낸다.
실제 SSH 대신 가짜 `_exec_ssh` 로 검증한다(실제 DB 사용).
"""
import asyncio
import json
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

import app.routers.versions as versions  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models import ClusterConfigSnapshot  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.ssh_runner import SSHResult  # noqa: E402

OK_HOST = "10.9.0.1"
BAD_HOST = "10.9.0.2"


def _fake_exec(target, cmd, **_kw):
    if target.host == BAD_HOST:
        return SSHResult(host=target.host, status="connect_error", exit_code=None,
                         stdout="", stderr="", duration_ms=3, error="connection refused")
    return SSHResult(host=target.host, status="ok", exit_code=0,
                     stdout="apiserver   Aug 12, 2027 10:11 UTC   362d\n", stderr="", duration_ms=5, error=None)


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"ver-stream-{tag}", api_endpoint="https://c:6443")
    op = User(username=f"ver-op-{tag}", hashed_password="x", role="operator")
    db.add_all([cluster, op])
    db.commit()
    yield {"cluster": cluster, "op": op}
    db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id == op.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id == op.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client(world, monkeypatch):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    monkeypatch.setattr(versions, "_exec_ssh", _fake_exec)
    app.dependency_overrides[get_current_user] = lambda: world["op"]
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _events(text: str) -> list[dict]:
    out = []
    for block in text.split("\n\n"):
        for ln in block.splitlines():
            if ln.startswith("data:"):
                out.append(json.loads(ln[5:].strip()))
    return out


def _body(**extra) -> dict:
    return {"hosts": [OK_HOST, BAD_HOST], "username": "root", "password": "pw", **extra}


def test_kubeadm_certs_stream_reports_each_host_then_result(client, world, db):
    res = client.post(f"/api/v1/clusters/{world['cluster'].id}/collect-kubeadm-certs/stream", json=_body())
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    evts = _events(res.text)
    assert "error" not in [e["type"] for e in evts], evts

    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert any(m.startswith("[1/2] ") and OK_HOST in m for m in logs)
    assert any(BAD_HOST in m and "connection refused" in m for m in logs)
    steps = {(e["name"], e["status"]) for e in evts if e["type"] == "step"}
    assert {(OK_HOST, "running"), (OK_HOST, "done"), (BAD_HOST, "failed")} <= steps
    # 자격증명은 어떤 이벤트에도 실리지 않는다
    assert '"pw"' not in res.text

    last = evts[-1]
    assert last["type"] == "result"
    body = last["result"]
    assert body["changed"] == 1
    assert [h["host"] for h in body["hosts"]] == [OK_HOST, BAD_HOST]
    assert body["errors"] and BAD_HOST in body["errors"][0]
    db.expire_all()
    snaps = db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == world["cluster"].id).all()
    assert [s.component for s in snaps] == [f"kubeadm_certs:{OK_HOST}"]


def test_parallel_collect_stream_matches_sync_response(client, world):
    cid = world["cluster"].id
    sync = client.post(f"/api/v1/clusters/{cid}/collect-kernel-params", json=_body()).json()
    evts = _events(client.post(f"/api/v1/clusters/{cid}/collect-kernel-params/stream", json=_body()).text)
    assert evts[-1]["type"] == "result"
    streamed = evts[-1]["result"]
    assert [h["host"] for h in streamed["hosts"]] == [h["host"] for h in sync["hosts"]]
    assert [h["status"] for h in streamed["hosts"]] == ["ok", "connect_error"]
    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert any("SSH 수집 시작" in m for m in logs)
    assert any("변경분 스냅샷 저장" in m for m in logs)
    assert any(m.startswith("완료 — 호스트 2대") for m in logs)


def test_stream_validation_errors_are_plain_http(client, world):
    cid = world["cluster"].id
    res = client.post(f"/api/v1/clusters/{cid}/collect-etcd-systemd/stream", json=_body(password=None))
    assert res.status_code == 422
    res = client.post(f"/api/v1/clusters/{uuid.uuid4()}/collect-kubelet-config/stream", json=_body())
    assert res.status_code == 404


def test_parallel_collect_keeps_order_and_is_silent_without_stream():
    events: list[dict] = []
    token = versions._collect_emit.set(events.append)
    try:
        out = asyncio.run(versions._parallel_collect(["a", "b", "c"], worker=lambda h: {"host": h, "status": "ok", "exit_code": 0}))
    finally:
        versions._collect_emit.reset(token)
    assert [r["host"] for r in out] == ["a", "b", "c"]
    done = [e for e in events if e["type"] == "step" and e["status"] == "done"]
    assert sorted(e["name"] for e in done) == ["a", "b", "c"]

    # 스트림이 아니면(기본 noop) 아무 이벤트도 만들지 않는다
    events.clear()
    asyncio.run(versions._parallel_collect(["x"], worker=lambda h: {"host": h, "status": "ok"}))
    assert events == []
