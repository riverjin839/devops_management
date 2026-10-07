"""D-089 — Pod 병목 진단 SSE 실행(`POST /pod-bottleneck/run/stream`) 회귀 테스트.

"지금 진단" 은 probe 4종을 동기로 끝낼 때까지 아무 정보도 주지 않았다. 이제 probe 가 끝나는 순서대로
step/log 이벤트를 흘리고, 마지막에 저장된 run id 를 result 로 보낸다. 실제 클러스터 대신 가짜 probe 로
검증한다(실제 DB 사용).
"""
import json
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension
from app.models import BottleneckRun, StatusEnum
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.user import User
from app.services.bottleneck_probes.base import BottleneckProbeBase, ProbeResult


class _FastProbe(BottleneckProbeBase):
    PROBE_KEY = "fake_fast"
    PROBE_LABEL = "Fake Fast"
    TIMEOUT_SEC = 2

    async def run(self, ctx):
        return ProbeResult(status=StatusEnum.healthy, message="ok", recommendation=None)


class _BadProbe(BottleneckProbeBase):
    PROBE_KEY = "fake_bad"
    PROBE_LABEL = "Fake Bad"
    TIMEOUT_SEC = 2

    async def run(self, ctx):
        return ProbeResult(status=StatusEnum.critical, message="conn refused", recommendation="방화벽 확인")


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
    cluster = Cluster(name=f"bn-stream-{tag}", api_endpoint="https://c:6443")
    op = User(username=f"bn-op-{tag}", hashed_password="x", role="operator")
    viewer = User(username=f"bn-viewer-{tag}", hashed_password="x", role="viewer")
    db.add_all([cluster, op, viewer])
    db.commit()
    yield {"cluster": cluster, "op": op, "viewer": viewer}
    db.query(BottleneckRun).filter(BottleneckRun.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_([op.id, viewer.id])).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_([op.id, viewer.id])).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client_as(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    import app.routers.bottleneck as bn

    monkeypatch.setattr(bn, "BOTTLENECK_PROBE_REGISTRY", {"fake_fast": _FastProbe, "fake_bad": _BadProbe})
    monkeypatch.setattr(bn, "make_context", lambda **kw: object())

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _events(text: str) -> list[dict]:
    out = []
    for block in text.split("\n\n"):
        for ln in block.splitlines():
            if ln.startswith("data:"):
                out.append(json.loads(ln[5:].strip()))
    return out


def _body(world):
    return {"cluster_id": str(world["cluster"].id), "namespace": "default",
            "source_pod": "a", "dest_pod": "b"}


def test_stream_emits_steps_logs_and_result(client_as, world, db):
    res = client_as(world["op"]).post("/api/v1/pod-bottleneck/run/stream", json=_body(world))
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    evts = _events(res.text)
    types = [e["type"] for e in evts]
    assert "error" not in types, evts
    # probe 마다 running → done/failed 단계가 온다
    steps = [e for e in evts if e["type"] == "step"]
    assert {(e["name"], e["status"]) for e in steps} >= {
        ("fake_fast", "running"), ("fake_fast", "done"), ("fake_bad", "running"), ("fake_bad", "failed"),
    }
    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert any("conn refused" in m for m in logs)
    assert any("방화벽 확인" in m for m in logs)
    result = evts[-1]
    assert result["type"] == "result"
    assert result["overall_status"] == "critical"
    row = db.query(BottleneckRun).filter(BottleneckRun.id == uuid.UUID(result["run_id"])).first()
    assert row is not None
    assert set(row.probes.keys()) == {"fake_fast", "fake_bad"}


def test_stream_requires_operator_before_streaming(client_as, world):
    res = client_as(world["viewer"]).post("/api/v1/pod-bottleneck/run/stream", json=_body(world))
    assert res.status_code == 403


def test_stream_unknown_cluster_is_plain_404(client_as, world):
    body = {**_body(world), "cluster_id": str(uuid.uuid4())}
    res = client_as(world["op"]).post("/api/v1/pod-bottleneck/run/stream", json=body)
    assert res.status_code == 404
