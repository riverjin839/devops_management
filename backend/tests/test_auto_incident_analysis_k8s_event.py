"""run_auto_incident_analysis_k8s_event 태스크 통합 테스트 — 실제 Postgres 사용.

`test_auto_incident_analysis.py`(알람용)와 동일한 계약을 K8s 이벤트 트리거에 대해 검증:
- 분석 성공: IncidentAnalysis 저장(trigger=k8s_event) + K8sEvent.analysis_id/analysis_status 갱신
- 분석기 실패: status=failed 로 기록되고 이벤트 행은 영향 없음
- 존재하지 않는 이벤트 id: no-op
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.k8s_event import K8sEvent  # noqa: E402
from app.models.incident_analysis import IncidentAnalysis  # noqa: E402
from app.main import _run_migrations  # noqa: E402
from app.celery_app import run_auto_incident_analysis_k8s_event  # noqa: E402
import app.services.analyzers.factory as factory_module  # noqa: E402
from app.services.analyzers.base import AnalysisResult  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
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


def _make_k8s_event(db, **overrides) -> K8sEvent:
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


class _FakeAnalyzer:
    async def analyze(self, context):
        return AnalysisResult(
            severity="critical",
            root_cause="OOMKilled — 메모리 한도 초과 (테스트)",
            suggested_actions=["메모리 limit 상향", "힙 덤프 확인"],
            confidence=0.8,
            analyzed_by="local_llm:test-profile:test-model",
            analyzed_at="2026-07-29T00:00:00Z",
            related_runbooks=["OOMKilled"],
        )

    async def health_check(self):
        return True


class _BoomAnalyzer:
    async def analyze(self, context):
        raise RuntimeError("llm exploded")

    async def health_check(self):
        return False


def test_task_persists_analysis_and_links_k8s_event(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _FakeAnalyzer())
    event = _make_k8s_event(db)

    result = run_auto_incident_analysis_k8s_event(str(event.id), rule_id="r1")
    assert result["ok"] is True
    assert result["status"] == "done"

    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.k8s_event_id == event.id).first()
    assert row is not None
    assert row.status == "done"
    assert row.trigger == "k8s_event"
    assert row.alert_event_id is None
    assert "OOMKilled" in row.root_cause
    assert row.suggested_actions == ["메모리 limit 상향", "힙 덤프 확인"]
    assert row.analyzed_by == "local_llm:test-profile:test-model"
    assert row.matched_rule_id == "r1"
    assert row.duration_ms is not None

    fresh = db.query(K8sEvent).filter(K8sEvent.id == event.id).first()
    assert fresh.analysis_id == row.id
    assert fresh.analysis_status == "done"


def test_task_manual_trigger_without_rule(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _FakeAnalyzer())
    event = _make_k8s_event(db)

    result = run_auto_incident_analysis_k8s_event(str(event.id))
    assert result["status"] == "done"
    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.k8s_event_id == event.id).first()
    assert row.trigger == "manual"


def test_task_records_failure_without_touching_event_row(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _BoomAnalyzer())
    event = _make_k8s_event(db)

    result = run_auto_incident_analysis_k8s_event(str(event.id), rule_id="r1")
    assert result["ok"] is True
    assert result["status"] == "failed"

    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.k8s_event_id == event.id).first()
    assert row.status == "failed"
    assert "llm exploded" in (row.error or "")

    fresh = db.query(K8sEvent).filter(K8sEvent.id == event.id).first()
    assert fresh.analysis_status == "failed"
    assert fresh.reason == "CrashLoopBackOff"  # 이벤트 자체는 무영향


def test_task_missing_k8s_event_is_noop():
    result = run_auto_incident_analysis_k8s_event(str(uuid.uuid4()))
    assert result == {"ok": False, "reason": "k8s_event_not_found"}


def test_task_bad_id_is_noop():
    result = run_auto_incident_analysis_k8s_event("not-a-uuid")
    assert result == {"ok": False, "reason": "bad_id"}


# ── 클러스터 소유 테넌트의 LLM 컨텍스트 (D-114 잔여) ──────────────────────

class _TenantSpyAnalyzer(_FakeAnalyzer):
    """분석 시점의 LLM 테넌트 컨텍스트를 기록한다."""
    seen = "unset"

    async def analyze(self, context):
        from app.services.llm.service import current_llm_tenant
        _TenantSpyAnalyzer.seen = current_llm_tenant()
        return await super().analyze(context)


@pytest.fixture
def bound_cluster(db):
    from app.models.cluster import Cluster
    from app.models.tenant import ClusterBinding, Tenant

    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"auto-an-{tag}", api_endpoint="https://auto-an:6443")
    tenant = Tenant(name=f"auto-an-team-{tag}",
                    llm_routing={"incident_analysis": {"primary": "internal-llm"}})
    db.add_all([cluster, tenant])
    db.commit()
    db.add(ClusterBinding(tenant_id=tenant.id, cluster_id=cluster.id, access="operate"))
    db.commit()
    yield cluster, tenant
    db.rollback()
    db.query(ClusterBinding).filter(ClusterBinding.tenant_id == tenant.id).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.commit()


def test_task_runs_in_cluster_owner_tenant_llm_context(db, monkeypatch, bound_cluster):
    cluster, tenant = bound_cluster
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _TenantSpyAnalyzer())
    event = _make_k8s_event(db)
    event.cluster_id = cluster.id
    db.commit()

    assert run_auto_incident_analysis_k8s_event(str(event.id))["status"] == "done"
    seen = _TenantSpyAnalyzer.seen
    assert isinstance(seen, dict) and seen["id"] == str(tenant.id)
    assert seen["routing"] == {"incident_analysis": {"primary": "internal-llm"}}


def test_task_unbound_cluster_has_no_tenant_context(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _TenantSpyAnalyzer())
    event = _make_k8s_event(db)

    assert run_auto_incident_analysis_k8s_event(str(event.id))["status"] == "done"
    assert _TenantSpyAnalyzer.seen is None
