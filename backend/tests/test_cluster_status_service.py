"""cluster_status_service.recompute() — 클러스터 종합 상태 단일 롤업 테스트.

커버하는 계약:
  SC-1  DailyCheckLog 가 없으면 core_bundle 신호 없이 애드온/심층 점검만으로 집계한다.
  SC-2  최신 DailyCheckLog 가 pending(미연결)이면 다른 신호와 무관하게 전체가 pending.
  SC-3  애드온은 opt-in 없이 항상 반영되고, 개별 pending 은 warning 으로 승격된다.
  SC-4  심층 점검은 affects_cluster_status=True 인 정의만 반영되고, 그 결과가 pending
        이면 "미판정"으로 집계에서 제외된다(warning 승격 없음 — 애드온과 다른 규칙).
  SC-5  같은 check_type 에 클러스터 전용 정의와 글로벌 정의가 모두 있으면 클러스터
        전용이 우선한다.
  SC-6  우선순위는 critical > warning > healthy 이고, Cluster.status 에 실제로 기록된다.
"""
import uuid

import pytest

from app.models import (
    Addon,
    CheckScheduleType,
    Cluster,
    DailyCheckLog,
    DeepCheckDefinition,
    DeepCheckResult,
    StatusEnum,
)
from app.services import cluster_status_service as svc


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
def cluster(db):
    suffix = uuid.uuid4().hex[:8]
    row = Cluster(name=f"status-svc-test-{suffix}", api_endpoint="https://127.0.0.1:65535")
    db.add(row)
    db.commit()
    yield row
    db.query(DeepCheckResult).filter(DeepCheckResult.cluster_id == row.id).delete(synchronize_session=False)
    db.query(DeepCheckDefinition).filter(DeepCheckDefinition.cluster_id == row.id).delete(synchronize_session=False)
    db.query(Addon).filter(Addon.cluster_id == row.id).delete(synchronize_session=False)
    db.query(DailyCheckLog).filter(DailyCheckLog.cluster_id == row.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == row.id).delete(synchronize_session=False)
    db.commit()


def _add_daily_log(db, cluster_id, overall_status: StatusEnum):
    from datetime import datetime
    log = DailyCheckLog(
        cluster_id=cluster_id,
        schedule_type=CheckScheduleType.manual,
        check_date=datetime.utcnow(),
        overall_status=overall_status,
        api_server_status=overall_status,
    )
    db.add(log)
    db.commit()
    return log


def _add_addon(db, cluster_id, *, status: StatusEnum, suffix: str):
    addon = Addon(cluster_id=cluster_id, name=f"addon-{suffix}", type=f"type-{suffix}", status=status)
    db.add(addon)
    db.commit()
    return addon


def _add_definition(db, *, check_type, cluster_id=None, affects=True):
    d = DeepCheckDefinition(
        cluster_id=cluster_id, check_type=check_type, name=f"def-{check_type}-{cluster_id}",
        affects_cluster_status=affects,
    )
    db.add(d)
    db.commit()
    return d


def _add_result(db, cluster_id, check_type, status: StatusEnum):
    from datetime import datetime
    r = DeepCheckResult(
        cluster_id=cluster_id, check_type=check_type, status=status, checked_at=datetime.utcnow(),
    )
    db.add(r)
    db.commit()
    return r


class TestNoDailyLog:
    def test_no_signals_defaults_healthy(self, db, cluster):
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "healthy"
        assert out["contributors"] == []
        db.refresh(cluster)
        assert cluster.status == StatusEnum.healthy

    def test_addon_only_critical_rolls_up_without_core_bundle(self, db, cluster):
        _add_addon(db, cluster.id, status=StatusEnum.critical, suffix="a")
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "critical"
        assert any(c["source_type"] == "addon" and c["status"] == "critical" for c in out["contributors"])


class TestCoreBundlePendingFloor:
    def test_pending_short_circuits_even_with_critical_addon(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.pending)
        _add_addon(db, cluster.id, status=StatusEnum.critical, suffix="a")
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "pending"
        assert len(out["contributors"]) == 1
        assert out["contributors"][0]["source_type"] == "core_bundle"
        db.refresh(cluster)
        assert cluster.status == StatusEnum.pending

    def test_healthy_core_bundle_lets_addon_drive_status(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_addon(db, cluster.id, status=StatusEnum.warning, suffix="a")
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "warning"


class TestAddonPendingPromotion:
    def test_individual_addon_pending_promotes_to_warning_not_critical(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_addon(db, cluster.id, status=StatusEnum.pending, suffix="a")
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "warning"


class TestDeepCheckOptIn:
    def test_affects_true_critical_rolls_up(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_definition(db, check_type="cert_expiry", affects=True)
        _add_result(db, cluster.id, "cert_expiry", StatusEnum.critical)
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "critical"
        assert any(c["source_type"] == "deep_check" for c in out["contributors"])

    def test_affects_false_critical_is_excluded(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_definition(db, check_type="cert_expiry", affects=False)
        _add_result(db, cluster.id, "cert_expiry", StatusEnum.critical)
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "healthy"
        assert not any(c["source_type"] == "deep_check" for c in out["contributors"])

    def test_pending_result_excluded_not_promoted(self, db, cluster):
        """애드온과 달리 심층 점검의 개별 pending 은 warning 으로 승격되지 않고 그냥 빠진다."""
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_definition(db, check_type="cert_expiry", affects=True)
        _add_result(db, cluster.id, "cert_expiry", StatusEnum.pending)
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "healthy"
        assert not any(c["source_type"] == "deep_check" for c in out["contributors"])

    def test_cluster_specific_definition_overrides_global(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_definition(db, check_type="cert_expiry", cluster_id=None, affects=True)
        _add_definition(db, check_type="cert_expiry", cluster_id=cluster.id, affects=True)
        _add_result(db, cluster.id, "cert_expiry", StatusEnum.warning)
        out = svc.recompute(db, cluster.id)
        deep_contributors = [c for c in out["contributors"] if c["source_type"] == "deep_check"]
        assert len(deep_contributors) == 1  # 글로벌 정의가 중복으로 잡히지 않음
        assert out["status"] == "warning"


class TestPriority:
    def test_critical_beats_warning(self, db, cluster):
        _add_daily_log(db, cluster.id, StatusEnum.healthy)
        _add_addon(db, cluster.id, status=StatusEnum.warning, suffix="w")
        _add_addon(db, cluster.id, status=StatusEnum.critical, suffix="c")
        out = svc.recompute(db, cluster.id)
        assert out["status"] == "critical"
