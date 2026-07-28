"""클러스터 삭제 시 연관 데이터 정리(purge).

`db.delete(cluster)` 한 번으로는 클러스터가 안전하게 지워지지 않는다. 두 가지 함정이 있다.

1. **ORM nullify** — 자식 모델이 `relationship("Cluster", backref="xxx")` 로 Cluster 쪽
   컬렉션을 만들면, SQLAlchemy 의 기본 cascade(`save-update, merge`) 에는 delete 가 없어
   부모 삭제 시 자식의 FK 를 NULL 로 UPDATE 한다. `cluster_id` 가 NOT NULL 인 테이블에서는
   이게 곧 아래 에러다 (실제 발생: `check_matrix_results`).

       psycopg2.errors.NotNullViolation:
       null value in column "cluster_id" of relation "check_matrix_results"

   즉 "등록된 클러스터인데 cluster_id 가 없다" 가 아니라, **삭제 과정에서 ORM 이 자식 행의
   cluster_id 를 NULL 로 밀어 넣다가** NOT NULL 제약에 걸린 것이다.

2. **DB CASCADE 를 믿을 수 없음** — 모델에 `ondelete="CASCADE"` 가 있어도 그 제약은 테이블이
   *처음 생성될 때만* 반영된다(`Base.metadata.create_all`). 나중에 ondelete 를 추가한 모델은
   구버전 운영 DB 의 FK 제약에 반영돼 있지 않아 ForeignKeyViolation 이 난다.

그래서 ORM cascade 나 DB cascade 에 기대지 않고, **`cluster_id` 를 가진 모든 테이블을
메타데이터에서 찾아 명시적으로 정리한다.** 모델이 새로 추가돼도 자동으로 포함되므로 같은
버그가 재발하지 않는다 (`tests/test_cluster_deletion.py` 가 정책 누락을 CI 에서 잡는다).
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import Base

CLUSTER_TABLE = "clusters"

# ── 정책 ────────────────────────────────────────────────────────────────────
# 행을 지우지 않고 cluster_id 만 NULL 로 끊는 테이블(이력/자산 성격 — 클러스터가 사라져도
# 기록 자체는 남겨야 한다). 여기 없는 cluster_id 보유 테이블은 전부 DELETE 된다.
KEEP_ROWS: dict[str, str] = {
    "work_items": "업무 이력 — 클러스터가 사라져도 기록은 보존",
    "service_entries": "서비스 카탈로그 — 클러스터 연결만 해제",
    "node_server_specs": "서버 자산(스펙) 정보 — 클러스터 연결만 해제",
}

# cluster_id 를 가진 테이블끼리도 FK 로 얽혀 있어 순서가 필요한 것들. 먼저 지운다.
DELETE_FIRST: tuple[str, ...] = (
    "deep_check_results",  # daily_check_logs / deep_check_definitions 참조 (ondelete 없음)
    "check_logs",          # addons 참조 (ondelete 없음)
    "playbooks",           # ansible_inventories 참조 (ondelete 없음)
)

# cluster_id 가 없어 자동 탐지되지 않지만, 위 테이블을 참조하는 FK 에 ON DELETE 가 없어
# 부모보다 먼저 지워야 하는 자식들 — (자식 테이블, 자식 FK 컬럼, 부모 테이블).
INDIRECT_CHILDREN: tuple[tuple[str, str, str], ...] = (
    ("notification_logs", "daily_check_log_id", "daily_check_logs"),
    ("notification_logs", "channel_id", "notification_channels"),
    ("batch_job_runs", "job_id", "batch_jobs"),
)


def cluster_ref_tables() -> dict[str, str]:
    """`clusters.id` 를 참조하는 모든 테이블 → FK 컬럼명 매핑 (메타데이터에서 자동 추출)."""
    refs: dict[str, str] = {}
    for table in Base.metadata.sorted_tables:
        if table.name == CLUSTER_TABLE:
            continue
        for column in table.columns:
            if any(fk.column.table.name == CLUSTER_TABLE for fk in column.foreign_keys):
                refs[table.name] = column.name
                break
    return refs


def purge_order() -> list[str]:
    """DELETE 대상 테이블을 FK 의존성 안전 순서로 나열한다."""
    refs = cluster_ref_tables()
    targets = [name for name in refs if name not in KEEP_ROWS]
    first = [name for name in DELETE_FIRST if name in targets]
    rest = sorted(name for name in targets if name not in first)
    return first + rest


def purge_cluster_references(db: Session, cluster_id: UUID) -> dict[str, Any]:
    """클러스터를 지우기 전에 참조 데이터를 정리한다.

    커밋하지 않는다 — 호출자가 `db.delete(cluster)` 까지 마친 뒤 한 트랜잭션으로 커밋한다.
    개별 테이블 처리는 SAVEPOINT 로 격리해, 한 테이블이 실패해도 나머지가 정리되고 실패
    사유가 `errors` 에 모인다(운영자가 원인 테이블을 바로 알 수 있게).

    Returns:
        {"deleted": {table: rows}, "detached": {table: rows}, "errors": [{table, error}]}
    """
    tables = Base.metadata.tables
    refs = cluster_ref_tables()
    deleted: dict[str, int] = {}
    detached: dict[str, int] = {}
    errors: list[dict[str, str]] = []

    def _run(label: str, stmt) -> int | None:
        """SAVEPOINT 안에서 statement 실행 — 실패해도 바깥 트랜잭션은 살아남는다."""
        try:
            with db.begin_nested():
                return db.execute(stmt).rowcount or 0
        except SQLAlchemyError as exc:  # noqa: BLE001 — 사유를 모아 호출자에게 전달
            errors.append({"table": label, "error": str(exc.orig if hasattr(exc, "orig") else exc)})
            return None

    # 1) 간접 자식(=cluster_id 가 없는 손자 테이블) 선정리
    for child_name, fk_column, parent_name in INDIRECT_CHILDREN:
        child, parent = tables.get(child_name), tables.get(parent_name)
        if child is None or parent is None:
            continue
        parent_fk = refs.get(parent_name)
        if parent_fk is None:
            continue
        stmt = delete(child).where(
            child.c[fk_column].in_(
                select(parent.c.id).where(parent.c[parent_fk] == cluster_id)
            )
        )
        rows = _run(child_name, stmt)
        if rows is not None:
            deleted[child_name] = deleted.get(child_name, 0) + rows

    # 2) cluster_id 보유 테이블 정리 — 보존 대상은 NULL 처리, 나머지는 삭제
    for name in purge_order():
        table = tables[name]
        rows = _run(name, delete(table).where(table.c[refs[name]] == cluster_id))
        if rows is not None:
            deleted[name] = rows

    for name, _reason in KEEP_ROWS.items():
        table = tables.get(name)
        if table is None or name not in refs:
            continue
        column = table.c[refs[name]]
        if not column.nullable:  # 보존 정책인데 NOT NULL 이면 NULL 처리가 불가능하다
            errors.append({"table": name, "error": "cluster_id is NOT NULL — 보존 정책 적용 불가"})
            continue
        rows = _run(name, update(table).where(column == cluster_id).values({column.name: None}))
        if rows is not None:
            detached[name] = rows

    return {"deleted": deleted, "detached": detached, "errors": errors}
