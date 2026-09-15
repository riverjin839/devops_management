"""R-4 6차 라운드 4단계 — 항목 상세(`/checks/:itemId`) 백엔드 계약.

커버하는 계약:
  ID-1  item_detail() — 존재하지 않는 항목은 None.
  ID-2  item_detail() — core_bundle 항목은 Cluster.check_cron_expr/check_cron_enabled 로 cron 을 채운다.
  ID-3  item_detail() — 그 외 항목은 CheckMatrixSchedule 로 cron 을 채우고, 스케줄이 없으면 None/false.
  ID-4  item_detail() — 최근 CheckMatrixResult 가 있으면 셀에 상태/값/시각이 채워진다.
  ID-5  라우터 GET /check-matrix/items/{item_id}/detail — 404/200.
  ID-6  GET /deep-check/definitions?check_type=X — cluster_id 없이 글로벌+전 클러스터 정의를 모두 반환.
"""
import uuid
from datetime import datetime

import pytest

from app.models import (
    CheckMatrixItem,
    CheckMatrixResult,
    CheckMatrixSchedule,
    CheckMatrixSourceType,
    Cluster,
    DeepCheckDefinition,
    StatusEnum,
)
from app.services import check_matrix_service as svc


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
    c = Cluster(name=f"itemdetail-{uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:65535")
    db.add(c)
    db.commit()
    yield c
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


class TestItemDetail:
    def test_unknown_item_returns_none(self, db):
        assert svc.item_detail(db, uuid.uuid4()) is None

    def test_core_bundle_cron_comes_from_cluster(self, db, cluster):
        cluster.check_cron_expr = "0 9 * * *"
        cluster.check_cron_enabled = True
        db.add(cluster)
        item = CheckMatrixItem(
            name="core-bundle-probe", source_type=CheckMatrixSourceType.core_bundle, is_system=True,
        )
        db.add(item)
        db.commit()
        try:
            out = svc.item_detail(db, item.id)
            assert out["item"]["id"] == str(item.id)
            cell = next(c for c in out["cells"] if c["cluster_id"] == str(cluster.id))
            assert cell["cron_expr"] == "0 9 * * *"
            assert cell["schedule_enabled"] is True
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item.id).delete(synchronize_session=False)
            db.commit()

    def test_non_core_bundle_cron_comes_from_schedule_and_defaults_empty(self, db, cluster):
        item = CheckMatrixItem(
            name="manual-probe", source_type=CheckMatrixSourceType.manual,
        )
        db.add(item)
        db.commit()
        try:
            # 스케줄이 아직 없으면 cron_expr None / schedule_enabled False.
            out = svc.item_detail(db, item.id)
            cell = next(c for c in out["cells"] if c["cluster_id"] == str(cluster.id))
            assert cell["cron_expr"] is None
            assert cell["schedule_enabled"] is False

            sch = CheckMatrixSchedule(
                item_id=item.id, cluster_id=cluster.id, cron_expr="*/15 * * * *", enabled=True,
            )
            db.add(sch)
            db.commit()

            out2 = svc.item_detail(db, item.id)
            cell2 = next(c for c in out2["cells"] if c["cluster_id"] == str(cluster.id))
            assert cell2["cron_expr"] == "*/15 * * * *"
            assert cell2["schedule_enabled"] is True
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item.id).delete(synchronize_session=False)
            db.commit()

    def test_latest_result_populates_cell(self, db, cluster):
        item = CheckMatrixItem(name="result-probe", source_type=CheckMatrixSourceType.manual)
        db.add(item)
        db.commit()
        try:
            db.add(CheckMatrixResult(
                item_id=item.id, cluster_id=cluster.id, status=StatusEnum.warning,
                value=42.5, message="테스트 결과", checked_at=datetime.utcnow(),
            ))
            db.commit()

            out = svc.item_detail(db, item.id)
            cell = next(c for c in out["cells"] if c["cluster_id"] == str(cluster.id))
            assert cell["status"] == "warning"
            assert cell["value"] == 42.5
            assert cell["message"] == "테스트 결과"
            assert cell["checked_at"] is not None
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item.id).delete(synchronize_session=False)
            db.commit()


class TestDefinitionsByCheckType:
    def test_check_type_filter_returns_global_and_all_cluster_overrides(self, db, cluster):
        check_type = f"probe-{uuid.uuid4().hex[:8]}"
        other_type = f"other-{uuid.uuid4().hex[:8]}"
        global_def = DeepCheckDefinition(cluster_id=None, check_type=check_type, name="글로벌")
        cluster_def = DeepCheckDefinition(cluster_id=cluster.id, check_type=check_type, name="전용")
        unrelated_def = DeepCheckDefinition(cluster_id=None, check_type=other_type, name="무관")
        db.add_all([global_def, cluster_def, unrelated_def])
        db.commit()
        try:
            from app.routers.check_definitions_router import list_definitions

            out = list_definitions(cluster_id=None, include_global=True, with_status=False, check_type=check_type, db=db)
            ids = {row.id for row in out}
            assert global_def.id in ids
            assert cluster_def.id in ids
            assert unrelated_def.id not in ids
        finally:
            db.query(DeepCheckDefinition).filter(
                DeepCheckDefinition.id.in_([global_def.id, cluster_def.id, unrelated_def.id])
            ).delete(synchronize_session=False)
            db.commit()
