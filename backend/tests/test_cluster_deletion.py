"""클러스터 삭제 회귀 테스트.

실제로 터졌던 버그:

    psycopg2.errors.NotNullViolation: null value in column "cluster_id"
    of relation "check_matrix_results"

원인은 두 가지이고, 아래 테스트가 각각을 CI 에서 막는다.

1. `relationship("Cluster", backref=...)` 의 기본 cascade 에 delete 가 없어, 부모 삭제 시
   ORM 이 자식의 NOT NULL FK 를 NULL 로 UPDATE 한다 → `test_cluster_backrefs_*`
2. 삭제 라우터가 연관 테이블을 손으로 나열해, 모델이 추가될 때마다 정리 대상이 누락된다
   → `test_purge_policy_covers_*`
"""
import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import ONETOMANY

import app.models  # noqa: F401 — 전체 모델을 metadata 에 등록
from app.database import Base
from app.models.cluster import Cluster
from app.routers.clusters import _detach_cluster_from_work_items
from app.services.cluster_purge import (
    CLUSTER_TABLE,
    KEEP_ROWS,
    cluster_ref_tables,
    purge_order,
)


# ── 1) 정리 정책 커버리지 ────────────────────────────────────────────────────

def test_purge_policy_covers_every_cluster_reference():
    """cluster_id 를 가진 모든 테이블은 삭제 대상이거나 명시적 보존 대상이어야 한다.

    새 모델에 cluster_id 를 추가하고 정책을 안 정하면 여기서 실패한다 — 그대로 두면
    클러스터 삭제가 FK/NOT NULL 위반으로 500 이 된다.
    """
    refs = set(cluster_ref_tables())
    covered = set(purge_order()) | set(KEEP_ROWS)
    assert refs, "clusters.id 를 참조하는 테이블을 하나도 못 찾았다 — 모델 import 확인"
    assert refs - covered == set(), f"정리 정책이 없는 테이블: {sorted(refs - covered)}"
    assert set(KEEP_ROWS) <= refs, f"cluster_id 가 없는 보존 대상: {sorted(set(KEEP_ROWS) - refs)}"


def test_known_regression_tables_are_deleted():
    """실제 장애 테이블들이 삭제 대상에 들어 있는지 못박아 둔다."""
    order = purge_order()
    for name in (
        "check_matrix_results",
        "check_matrix_schedules",
        "check_matrix_result_logs",
        "resource_count_snapshots",
        "cluster_config_snapshots",
    ):
        assert name in order, f"{name} 이 삭제 대상에서 빠졌다"


def test_history_tables_are_never_deleted():
    """이력/자산 테이블은 클러스터 삭제로 같이 사라지면 안 된다 (연결만 해제)."""
    order = purge_order()
    for name in ("work_items", "service_entries", "node_server_specs"):
        assert name in KEEP_ROWS, f"{name} 이 보존 정책에서 빠졌다"
        assert name not in order, f"{name} 이 삭제 대상에 들어갔다 — 이력이 지워진다"


def test_keep_rows_are_nullable():
    """보존 정책(=cluster_id 만 NULL 처리) 테이블은 컬럼이 nullable 이어야 한다."""
    refs = cluster_ref_tables()
    for name in KEEP_ROWS:
        column = Base.metadata.tables[name].c[refs[name]]
        assert column.nullable, f"{name}.{column.name} 은 NOT NULL 이라 보존 정책을 쓸 수 없다"


def test_purge_order_respects_intra_table_dependencies():
    """cluster 스코프 테이블끼리의 FK 중 ON DELETE 가 없는 것은 자식이 먼저 지워져야 한다."""
    order = purge_order()
    position = {name: i for i, name in enumerate(order)}
    for table in Base.metadata.sorted_tables:
        if table.name not in position:
            continue
        for column in table.columns:
            for fk in column.foreign_keys:
                parent = fk.column.table.name
                if parent == CLUSTER_TABLE or parent not in position:
                    continue
                if (fk.ondelete or "").upper() in ("CASCADE", "SET NULL"):
                    continue
                assert position[table.name] < position[parent], (
                    f"{table.name}.{column.name} → {parent} (ondelete 없음): "
                    f"{table.name} 이 {parent} 보다 먼저 삭제돼야 한다"
                )


# ── 2) ORM nullify 방지 ──────────────────────────────────────────────────────

def test_cluster_backrefs_never_nullify_not_null_fk():
    """Cluster 쪽 1:N 컬렉션이 NOT NULL 자식을 nullify 하지 않는지 검사.

    NOT NULL 자식은 delete cascade 거나 passive_deletes 여야 한다. 둘 다 아니면
    `db.delete(cluster)` 가 `UPDATE ... SET cluster_id=NULL` 을 날려 터진다.
    """
    offenders = []
    for rel in sa_inspect(Cluster).relationships:
        if rel.direction is not ONETOMANY:
            continue
        not_null_remote = [
            remote for _local, remote in rel.local_remote_pairs if not remote.nullable
        ]
        if not not_null_remote:
            continue
        if rel.passive_deletes or "delete" in rel.cascade:
            continue
        offenders.append(f"Cluster.{rel.key} → {not_null_remote[0]}")
    assert not offenders, (
        "다음 관계가 NOT NULL 자식의 cluster_id 를 NULL 로 만든다 — "
        f"passive_deletes=True 또는 delete cascade 필요: {offenders}"
    )


# ── 3) 다중 대상 업무 정리 ───────────────────────────────────────────────────

def _work_item(cluster_ids, cluster_names, cluster_id, cluster_name):
    item = MagicMock()
    item.cluster_ids = cluster_ids
    item.cluster_names = cluster_names
    item.cluster_id = cluster_id
    item.cluster_name = cluster_name
    return item


def _db_returning(items):
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = items
    return db


def test_detach_removes_cluster_from_multi_target_work_item():
    gone, keep = uuid.uuid4(), uuid.uuid4()
    item = _work_item([str(gone), str(keep)], ["삭제될것", "남을것"], gone, "삭제될것")

    _detach_cluster_from_work_items(_db_returning([item]), gone)

    assert item.cluster_ids == [str(keep)]
    assert item.cluster_names == ["남을것"]
    # 대표가 삭제된 클러스터였으므로 남은 첫 대상으로 승격
    assert item.cluster_id == keep
    assert item.cluster_name == "남을것"


def test_detach_clears_representative_when_no_target_remains():
    gone = uuid.uuid4()
    item = _work_item([str(gone)], ["삭제될것"], gone, "삭제될것")

    _detach_cluster_from_work_items(_db_returning([item]), gone)

    assert item.cluster_ids == []
    assert item.cluster_names == []
    assert item.cluster_id is None
    assert item.cluster_name is None


def test_detach_keeps_other_representative_intact():
    """대표가 다른 클러스터면 건드리지 않는다 (배열에서만 제거)."""
    gone, primary = uuid.uuid4(), uuid.uuid4()
    item = _work_item([str(primary), str(gone)], ["대표", "삭제될것"], primary, "대표")

    _detach_cluster_from_work_items(_db_returning([item]), gone)

    assert item.cluster_ids == [str(primary)]
    assert item.cluster_names == ["대표"]
    assert item.cluster_id == primary
    assert item.cluster_name == "대표"


@pytest.mark.parametrize("names", [None, [], ["하나만"]])
def test_detach_tolerates_missing_or_short_names(names):
    """cluster_names 가 없거나 길이가 어긋나도 예외 없이 정리된다."""
    gone, keep = uuid.uuid4(), uuid.uuid4()
    item = _work_item([str(gone), str(keep)], names, gone, None)

    _detach_cluster_from_work_items(_db_returning([item]), gone)

    assert item.cluster_ids == [str(keep)]
    assert len(item.cluster_names) == 1
