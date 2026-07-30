"""K8s 이벤트 라우터 — kubewatch ingest 인증 + 조회/AI 분석 엔드포인트.

alert 파이프라인의 동급 엔드포인트(`observability.py`)와 동일한 계약:
- ingest 는 KUBEWATCH_TOKEN 미설정 시 fail-closed(503), 오검증 시 401.
- 수신 직후 자동 분석 훅을 호출하되 훅 실패가 ingest 자체를 막지 않는다.
- `/events/{id}/analysis`(조회) / `/events/{id}/analyze`(수동 트리거, operator+) 는
  알람 쪽 `/observability/alerts/{id}/...` 와 동일한 응답 형태.
"""
import uuid
from types import SimpleNamespace as NS

import pytest


@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    from app.main import _ensure_pgvector_extension
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: NS(
        id=uuid.uuid4(), username="tester", role="admin")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def anon_client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def _make_k8s_event(db, **overrides):
    from app.models.k8s_event import K8sEvent
    event = K8sEvent(
        id=uuid.uuid4(),
        cluster_id=uuid.uuid4(),
        event_type="MODIFIED",
        resource_kind="Pod",
        resource_name="api-abc",
        namespace="prod-api",
        reason="CrashLoopBackOff",
        message="Back-off restarting failed container",
        severity="critical",
        **overrides,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


# ── ingest 인증 (fail-closed) ────────────────────────────────────────────────

def test_ingest_rejects_when_token_unset(anon_client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "kubewatch_token", "")
    r = anon_client.post("/api/v1/events/kubewatch", json={"name": "x"})
    assert r.status_code == 503


def test_ingest_rejects_bad_token(anon_client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "kubewatch_token", "secret-token")
    r = anon_client.post(
        "/api/v1/events/kubewatch", json={"name": "x"},
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_ingest_accepts_valid_token_and_persists(anon_client, db, monkeypatch):
    from app.config import settings
    from app.models.k8s_event import K8sEvent
    monkeypatch.setattr(settings, "kubewatch_token", "secret-token")

    payload = {
        "type": "MODIFIED",
        "object": {
            "kind": "Pod",
            "metadata": {"name": "api-abc", "namespace": "prod-api"},
            "status": {"reason": "CrashLoopBackOff", "message": "back-off"},
        },
    }
    r = anon_client.post(
        "/api/v1/events/kubewatch", json=payload,
        headers={"Authorization": "Bearer secret-token"},
    )
    assert r.status_code == 201
    event_id = r.json()["id"]
    db.expire_all()
    row = db.query(K8sEvent).filter(K8sEvent.id == uuid.UUID(event_id)).first()
    assert row is not None


def test_ingest_hook_failure_does_not_break_ingest(anon_client, db, monkeypatch):
    """자동 분석 훅이 뭘 하든(예외 포함) ingest 자체는 201 로 성공해야 한다."""
    from app.config import settings
    import app.services.observability.analysis_hook as hook_module
    monkeypatch.setattr(settings, "kubewatch_token", "secret-token")
    monkeypatch.setattr(
        hook_module, "maybe_enqueue_analysis_for_k8s_event",
        lambda db, event: (_ for _ in ()).throw(RuntimeError("redis down")),
    )
    payload = {
        "type": "MODIFIED",
        "object": {
            "kind": "Pod",
            "metadata": {"name": "api-xyz", "namespace": "prod-api"},
            "status": {"reason": "OOMKilling"},
        },
    }
    r = anon_client.post(
        "/api/v1/events/kubewatch", json=payload,
        headers={"Authorization": "Bearer secret-token"},
    )
    assert r.status_code == 201


# ── 조회/수동 트리거 (JWT 보호) ────────────────────────────────────────────────

def test_get_analysis_requires_auth(anon_client, db):
    event_id = uuid.uuid4()
    r = anon_client.get(f"/api/v1/events/{event_id}/analysis")
    assert r.status_code == 401


def test_get_analysis_404_when_none(client, db):
    event = _make_k8s_event(db)
    r = client.get(f"/api/v1/events/{event.id}/analysis")
    assert r.status_code == 404


def test_get_analysis_returns_linked_row(client, db):
    from app.models.incident_analysis import IncidentAnalysis
    event = _make_k8s_event(db)
    analysis = IncidentAnalysis(
        k8s_event_id=event.id, cluster_id=event.cluster_id, namespace=event.namespace,
        resource=event.resource_name, trigger="k8s_event", status="done",
        root_cause="OOMKilled", suggested_actions=["메모리 상향"], analyzed_by="rule_based",
    )
    db.add(analysis)
    db.commit()

    r = client.get(f"/api/v1/events/{event.id}/analysis")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["k8s_event_id"] == str(event.id)
    assert data["alert_event_id"] is None
    assert data["trigger"] == "k8s_event"
    assert data["root_cause"] == "OOMKilled"


def test_trigger_analysis_queues_and_sets_status(client, db, monkeypatch):
    captured = {}

    class _FakeTask:
        @staticmethod
        def apply_async(args=None, queue=None):
            captured["args"] = args
            captured["queue"] = queue

    import app.celery_app as celery_module
    monkeypatch.setattr(celery_module, "run_auto_incident_analysis_k8s_event", _FakeTask)

    event = _make_k8s_event(db)
    r = client.post(f"/api/v1/events/{event.id}/analyze")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "status": "queued"}
    assert captured["queue"] == "llm"
    assert captured["args"] == [str(event.id)]

    db.expire_all()
    from app.models.k8s_event import K8sEvent
    fresh = db.query(K8sEvent).filter(K8sEvent.id == event.id).first()
    assert fresh.analysis_status == "queued"


def test_trigger_analysis_short_circuits_when_already_running(client, db):
    event = _make_k8s_event(db, analysis_status="running")
    r = client.post(f"/api/v1/events/{event.id}/analyze")
    assert r.status_code == 200
    assert r.json()["status"] == "running"


def test_trigger_analysis_404_for_missing_event(client, db):
    r = client.post(f"/api/v1/events/{uuid.uuid4()}/analyze")
    assert r.status_code == 404
