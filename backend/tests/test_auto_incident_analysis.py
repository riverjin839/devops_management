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
        cluster_id=uuid.uuid4(),
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
