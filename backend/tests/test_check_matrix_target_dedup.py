"""D-062 잔여 — 대상 중복 표시(target_key). 커버하는 계약:

  TD-1  같은 target_key + 서로 다른 exec_tech 2개 이상 → 두 행 모두 duplicate_count>=1, peers 채움.
  TD-2  같은 target_key 지만 exec_tech 가 전부 같으면(예: manual 2개) → 중복 아님(count=0).
  TD-3  target_key 가 없는 행 → 항상 count=0, peers=[].
  TD-4  비활성(enabled=False) 행은 그룹에서 제외 — 남은 동료가 1개뿐이면 중복 아님.
  TD-5  build_grid() 의 items 응답에 target_key/target_duplicate_count/target_peers 가 실린다.
  TD-6  item_detail() 도 동일한 판정을 스코프 좁혀 재현한다.
"""
import uuid

import pytest

from app.models import CheckMatrixItem, CheckMatrixSourceType, Cluster
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
    c = Cluster(name=f"targetdedup-{uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:65535")
    db.add(c)
    db.commit()
    yield c
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


def _mk(db, *, name, source_type, target_key=None, enabled=True, is_system=False):
    item = CheckMatrixItem(
        name=name, source_type=source_type, target_key=target_key,
        enabled=enabled, is_system=is_system,
    )
    db.add(item)
    db.commit()
    return item


class TestTargetDuplicateMap:
    def test_different_exec_tech_same_target_flags_both(self, db):
        a = _mk(db, name="a", source_type=CheckMatrixSourceType.core_bundle, target_key="etcd", is_system=True)
        b = _mk(db, name="b", source_type=CheckMatrixSourceType.manual, target_key="etcd")
        try:
            dup = svc._target_duplicate_map(db, [a, b])
            assert dup[str(a.id)]["duplicate_count"] == 1
            assert dup[str(b.id)]["duplicate_count"] == 1
            assert dup[str(a.id)]["peers"][0]["item_id"] == str(b.id)
            assert dup[str(a.id)]["peers"][0]["exec_tech"] == "manual"
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_([a.id, b.id])).delete(synchronize_session=False)
            db.commit()

    def test_same_exec_tech_same_target_is_not_duplicate(self, db):
        a = _mk(db, name="a", source_type=CheckMatrixSourceType.manual, target_key="etcd")
        b = _mk(db, name="b", source_type=CheckMatrixSourceType.manual, target_key="etcd")
        try:
            dup = svc._target_duplicate_map(db, [a, b])
            assert dup == {}
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_([a.id, b.id])).delete(synchronize_session=False)
            db.commit()

    def test_no_target_key_never_flagged(self, db):
        a = _mk(db, name="a", source_type=CheckMatrixSourceType.core_bundle, target_key=None, is_system=True)
        b = _mk(db, name="b", source_type=CheckMatrixSourceType.manual, target_key=None)
        try:
            dup = svc._target_duplicate_map(db, [a, b])
            assert dup == {}
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_([a.id, b.id])).delete(synchronize_session=False)
            db.commit()

    def test_disabled_peer_excluded(self, db):
        a = _mk(db, name="a", source_type=CheckMatrixSourceType.core_bundle, target_key="etcd", is_system=True)
        b = _mk(db, name="b", source_type=CheckMatrixSourceType.manual, target_key="etcd", enabled=False)
        try:
            dup = svc._target_duplicate_map(db, [a, b])
            assert dup == {}
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_([a.id, b.id])).delete(synchronize_session=False)
            db.commit()


class TestBackfillTargetKeyDoesNotRepaintClearedColor:
    def test_target_key_backfill_alone_does_not_set_color(self, db):
        """target_key 만 새로 채워지는 행(category 는 이미 있고 color 는 운영자가 지운 상태)은
        색을 다시 칠하면 안 된다 — category_touched 와 touched 를 분리하지 않으면 재발하는
        회귀(2026-09-29 CI 에서 실제로 걸림: cert_expiry 행이 target_key 백필만으로 색까지
        다시 칠해짐)."""
        row = _mk(
            db, name="already-categorized", source_type=CheckMatrixSourceType.deep_check,
            target_key=None,
        )
        row.source_ref = "cert_expiry"
        row.category = "k8s"
        row.color = None
        db.commit()
        try:
            svc.backfill_item_metadata(db)
            db.refresh(row)
            assert row.target_key == "certificate"
            assert row.color is None
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id == row.id).delete(synchronize_session=False)
            db.commit()


class TestGridAndDetailExposeTarget:
    def test_build_grid_includes_target_fields(self, db, cluster):
        a = _mk(db, name="a", source_type=CheckMatrixSourceType.core_bundle, target_key="etcd", is_system=True)
        b = _mk(db, name="b", source_type=CheckMatrixSourceType.manual, target_key="etcd")
        try:
            grid = svc.build_grid(db)
            by_id = {i["id"]: i for i in grid["items"]}
            assert by_id[str(a.id)]["target_key"] == "etcd"
            assert by_id[str(a.id)]["target_duplicate_count"] == 1
            assert by_id[str(b.id)]["target_duplicate_count"] == 1
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_([a.id, b.id])).delete(synchronize_session=False)
            db.commit()

    def test_item_detail_includes_target_fields(self, db, cluster):
        a = _mk(db, name="a", source_type=CheckMatrixSourceType.core_bundle, target_key="etcd", is_system=True)
        b = _mk(db, name="b", source_type=CheckMatrixSourceType.manual, target_key="etcd")
        try:
            out = svc.item_detail(db, a.id)
            assert out["item"]["target_key"] == "etcd"
            assert out["item"]["target_duplicate_count"] == 1
            assert out["item"]["target_peers"][0]["item_id"] == str(b.id)
        finally:
            db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_([a.id, b.id])).delete(synchronize_session=False)
            db.commit()
