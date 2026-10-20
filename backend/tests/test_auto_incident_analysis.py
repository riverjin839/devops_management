"""run_auto_incident_analysis 태스크 통합 테스트 — 실제 Postgres 사용.

- 분석 성공: IncidentAnalysis 저장 + AlertEvent.analysis_id/analysis_status 갱신
- 분석기 실패: status=failed 로 기록되고 알람 행은 영향 없음
- 존재하지 않는 알람 id: no-op
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.alert_event import AlertEvent  # noqa: E402
from app.models.incident_analysis import IncidentAnalysis  # noqa: E402
from app.main import _run_migrations  # noqa: E402
from app.celery_app import run_auto_incident_analysis  # noqa: E402
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


def _make_alert(db, **overrides) -> AlertEvent:
    event = AlertEvent(
        id=uuid.uuid4(),
        cluster_id=overrides.pop("cluster_id", uuid.uuid4()),
        source="alertmanager",
        fingerprint=uuid.uuid4().hex,
        alertname="KubePodCrashLooping",
        severity="critical",
        status="firing",
        namespace="prod-api",
        resource="api-abc",
        summary="Pod is crash looping",
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


class _DegradedAnalyzer:
    """LLM 연결 실패 등으로 대체 결과를 돌려주는 분석기 (D-115)."""
    async def analyze(self, context):
        return AnalysisResult(
            severity="info",
            root_cause="LLM 응답 없음 — 대체 결과",
            suggested_actions=[],
            confidence=0.0,
            analyzed_by="local_llm:test-profile:test-model",
            analyzed_at="2026-07-29T00:00:00Z",
            degraded=True,
            degraded_reason="LLM 연결 실패",
        )

    async def health_check(self):
        return False


class _BoomAnalyzer:
    async def analyze(self, context):
        raise RuntimeError("llm exploded")

    async def health_check(self):
        return False


def test_task_persists_analysis_and_links_alert(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _FakeAnalyzer())
    event = _make_alert(db)

    result = run_auto_incident_analysis(str(event.id), rule_id="r1")
    assert result["ok"] is True
    assert result["status"] == "done"

    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.alert_event_id == event.id).first()
    assert row is not None
    assert row.status == "done"
    assert row.trigger == "alert"
    assert "OOMKilled" in row.root_cause
    assert row.suggested_actions == ["메모리 limit 상향", "힙 덤프 확인"]
    assert row.analyzed_by == "local_llm:test-profile:test-model"
    assert row.matched_rule_id == "r1"
    assert row.duration_ms is not None
    assert row.degraded is False  # 서버 판정이 있으면 화면이 confidence 추정을 쓰지 않는다

    fresh = db.query(AlertEvent).filter(AlertEvent.id == event.id).first()
    assert fresh.analysis_id == row.id
    assert fresh.analysis_status == "done"


def test_task_manual_trigger_without_rule(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _FakeAnalyzer())
    event = _make_alert(db)

    result = run_auto_incident_analysis(str(event.id))
    assert result["status"] == "done"
    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.alert_event_id == event.id).first()
    assert row.trigger == "manual"


def test_task_records_failure_without_touching_alert_row(db, monkeypatch):
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _BoomAnalyzer())
    event = _make_alert(db)

    result = run_auto_incident_analysis(str(event.id), rule_id="r1")
    assert result["ok"] is True
    assert result["status"] == "failed"

    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.alert_event_id == event.id).first()
    assert row.status == "failed"
    assert "llm exploded" in (row.error or "")

    fresh = db.query(AlertEvent).filter(AlertEvent.id == event.id).first()
    assert fresh.analysis_status == "failed"
    assert fresh.status == "firing"  # 알람 자체는 무영향


def test_task_missing_alert_is_noop():
    result = run_auto_incident_analysis(str(uuid.uuid4()))
    assert result == {"ok": False, "reason": "alert_not_found"}


def test_task_bad_id_is_noop():
    result = run_auto_incident_analysis("not-a-uuid")
    assert result == {"ok": False, "reason": "bad_id"}


def test_task_degraded_result_is_recorded_as_failed(db, monkeypatch):
    """대체 결과(degraded)를 성공(done)으로 저장하지 않는다 (D-115)."""
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _DegradedAnalyzer())
    event = _make_alert(db)

    result = run_auto_incident_analysis(str(event.id), rule_id="r1")
    assert result["status"] == "failed"

    db.expire_all()
    row = db.query(IncidentAnalysis).filter(
        IncidentAnalysis.alert_event_id == event.id).first()
    assert row.status == "failed"
    assert row.degraded is True
    assert "LLM 연결 실패" in (row.error or "")


def test_task_runs_analyzer_in_cluster_owner_tenant_context(db, monkeypatch):
    """자동 분석은 클러스터 소유 테넌트의 LLM 컨텍스트 안에서 분석기를 고르고 돌린다 (D-114).

    그래야 테넌트가 incident_analysis LLM 을 지정했을 때 factory 가 Claude 직접 호출 대신
    게이트웨이를 고르고, LLM 사용량이 그 테넌트에 귀속된다.
    """
    from app.models.cluster import Cluster
    from app.models.tenant import ClusterBinding, Tenant
    from app.services.llm.service import current_llm_tenant

    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"auto-an-{tag}", api_endpoint="https://c:6443")
    tenant = Tenant(name=f"auto-an-team-{tag}", llm_routing={"incident_analysis": {"primary": "onprem"}})
    db.add_all([cluster, tenant])
    db.commit()
    db.add(ClusterBinding(tenant_id=tenant.id, cluster_id=cluster.id, access="operate"))
    db.commit()
    seen: list = []

    def _get(dbb=None):
        seen.append(current_llm_tenant())
        return _FakeAnalyzer()

    monkeypatch.setattr(factory_module, "get_analyzer", _get)
    try:
        event = _make_alert(db, cluster_id=cluster.id)
        result = run_auto_incident_analysis(str(event.id))
        assert result["status"] == "done"
        assert seen and seen[0]["id"] == str(tenant.id)
        assert seen[0]["routing"] == {"incident_analysis": {"primary": "onprem"}}
        assert current_llm_tenant() is None  # 태스크 밖으로 새지 않는다

        # 바인딩 없는 클러스터는 테넌트 컨텍스트 없이(전역 설정)
        seen.clear()
        other = _make_alert(db)
        run_auto_incident_analysis(str(other.id))
        assert seen == [None]
    finally:
        db.query(IncidentAnalysis).filter(IncidentAnalysis.cluster_id == cluster.id).delete(synchronize_session=False)
        db.query(AlertEvent).filter(AlertEvent.cluster_id == cluster.id).delete(synchronize_session=False)
        db.query(ClusterBinding).filter(ClusterBinding.tenant_id == tenant.id).delete(synchronize_session=False)
        db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
        db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
        db.commit()


def test_task_owner_tenant_db_error_rolls_back_and_still_saves(db, monkeypatch):
    """소유 테넌트 조회가 SQL 오류로 실패해도 세션을 되돌리고 전역 설정으로 분석·저장한다.

    rollback 이 없으면 aborted 트랜잭션 때문에 결과 commit 이 실패해 분석 행이 running 에 고착된다.
    """
    from sqlalchemy import text

    import app.services.tenant_concurrency as tc

    def _broken_owner_tenant(dbb, cluster_id):
        dbb.execute(text("SELECT * FROM no_such_table_for_test"))  # 세션을 aborted 상태로 만든다

    monkeypatch.setattr(tc, "owner_tenant", _broken_owner_tenant)
    monkeypatch.setattr(factory_module, "get_analyzer", lambda dbb=None: _FakeAnalyzer())
    event = _make_alert(db)

    result = run_auto_incident_analysis(str(event.id), rule_id="r1")
    assert result["status"] == "done"

    db.expire_all()
    row = db.query(IncidentAnalysis).filter(IncidentAnalysis.alert_event_id == event.id).first()
    assert row is not None and row.status == "done"
    fresh = db.query(AlertEvent).filter(AlertEvent.id == event.id).first()
    assert fresh.analysis_status == "done"
