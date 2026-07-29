"""스키마 드리프트 점검·복구 — 모델(`Base.metadata`) vs 실제 DB 비교.

왜 필요한가: 이 프로젝트는 Alembic 없이 `create_all` + 경량 마이그레이션으로 스키마를
관리한다. `create_all` 은 **이미 존재하는 테이블의 컬럼/제약을 바꾸지 않기** 때문에,
오래 운영된 DB 는 모델과 조금씩 어긋난 채 남는다. 그 어긋남은 배포 직후엔 조용하다가
해당 컬럼을 건드리는 요청에서만 500 으로 드러난다 — 실제로 이런 사례가 반복됐다:

  - `deep_check_results.status` / `.message` 누락 → 클러스터 삭제 시 500
  - `deep_check_results.daily_check_log_id` 의 레거시 NOT NULL → deep check 실행 전부 500
  - `daily_check_logs.ai_*` 계열 누락 → 일일점검 저장 시 500

한 컬럼씩 사후에 쫓아가는 대신 **전체를 기계적으로 비교**하고, 운영자가 화면에서
직접 확인·복구할 수 있게 한다(프로젝트 UI-First 원칙 — `CLAUDE.md`).

감지하는 드리프트 3종:
  - `missing_table`  : 모델에 있는 테이블이 DB 에 없음 (create_all 실패 흔적)
  - `missing_column` : 모델에 있는 컬럼이 DB 에 없음
  - `not_null_drift` : 모델은 nullable 인데 DB 는 NOT NULL (레거시 제약)

복구는 **덧붙이기와 제약 완화만** 한다 — 컬럼 삭제·타입 변경처럼 데이터를 잃을 수 있는
작업은 절대 자동으로 하지 않는다. 반대 방향(모델 NOT NULL / DB nullable)도 보고만 하고
고치지 않는다 — 기존 행의 backfill 값을 알 수 없어 임의로 채우면 안 되기 때문이다.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import inspect, text

from app.database import Base, engine

logger = logging.getLogger(__name__)

# 모델과 무관하게 DB 에만 존재하는 테이블(확장/외부 도구)은 비교 대상이 아니다.
# 여기서는 "모델 → DB" 단방향만 본다.


def _compile_type(col) -> str | None:
    try:
        return col.type.compile(dialect=engine.dialect)
    except Exception as e:  # noqa: BLE001 — 커스텀 TypeDecorator 등
        logger.warning("schema_health: %s 타입 컴파일 불가 (%s)", col.name, e)
        return None


def inspect_drift() -> dict[str, Any]:
    """모델과 실제 DB 를 비교해 드리프트 목록을 만든다 (읽기 전용)."""
    ins = inspect(engine)
    existing_tables = set(ins.get_table_names())

    issues: list[dict[str, Any]] = []
    checked_tables = 0
    checked_columns = 0

    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            issues.append({
                "kind": "missing_table",
                "table": table.name,
                "column": None,
                "detail": "모델에 정의된 테이블이 DB 에 없습니다 — create_all 이 실패했을 수 있습니다.",
                "repairable": False,
            })
            continue
        checked_tables += 1
        try:
            db_cols = {c["name"]: c for c in ins.get_columns(table.name)}
        except Exception as e:  # noqa: BLE001
            issues.append({
                "kind": "inspect_failed",
                "table": table.name,
                "column": None,
                "detail": f"컬럼 조회 실패: {str(e)[:200]}",
                "repairable": False,
            })
            continue

        for col in table.columns:
            checked_columns += 1
            db_col = db_cols.get(col.name)
            if db_col is None:
                type_sql = _compile_type(col)
                issues.append({
                    "kind": "missing_column",
                    "table": table.name,
                    "column": col.name,
                    "detail": (
                        f"모델에 있는 컬럼이 DB 에 없습니다 (모델 타입 {type_sql or '컴파일 불가'}). "
                        "이 컬럼을 읽거나 쓰는 요청이 500 으로 실패합니다."
                    ),
                    # 타입 컴파일이 안 되면 자동 추가할 수 없다.
                    "repairable": type_sql is not None,
                })
                continue
            # NOT NULL 드리프트 — 모델은 NULL 허용인데 DB 가 막고 있는 경우.
            if col.nullable and not db_col.get("nullable", True):
                issues.append({
                    "kind": "not_null_drift",
                    "table": table.name,
                    "column": col.name,
                    "detail": (
                        "모델은 NULL 을 허용하는데 DB 에 NOT NULL 제약이 남아 있습니다 — "
                        "이 컬럼을 비운 채 저장하는 기능이 500 으로 실패합니다."
                    ),
                    "repairable": True,
                })

    return {
        "healthy": len(issues) == 0,
        "checked_tables": checked_tables,
        "checked_columns": checked_columns,
        "issue_count": len(issues),
        "issues": issues,
    }


def repair_drift(*, dry_run: bool = False) -> dict[str, Any]:
    """감지된 드리프트 중 **안전한 것만** 복구한다.

    - `missing_column`  → `ADD COLUMN IF NOT EXISTS <type>` (항상 nullable —
      기존 행의 backfill 값을 알 수 없으므로 NOT NULL 은 걸지 않는다).
    - `not_null_drift`  → `ALTER COLUMN ... DROP NOT NULL`.
    - 그 외(missing_table 등)는 손대지 않고 `skipped` 로 보고한다 — 사람이 판단할 일이다.

    개별 문장은 독립 트랜잭션으로 실행하고 실패해도 다음으로 진행한다(부분 복구 허용).
    """
    drift = inspect_drift()
    col_types: dict[tuple[str, str], str] = {}
    for table in Base.metadata.sorted_tables:
        for col in table.columns:
            compiled = _compile_type(col)
            if compiled:
                col_types[(table.name, col.name)] = compiled

    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for issue in drift["issues"]:
        if not issue["repairable"]:
            skipped.append({**issue, "reason": "자동 복구 대상이 아닙니다 — 수동 확인 필요."})
            continue

        table, column = issue["table"], issue["column"]
        if issue["kind"] == "missing_column":
            type_sql = col_types.get((table, column))
            if not type_sql:
                skipped.append({**issue, "reason": "타입 컴파일 불가"})
                continue
            sql = f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {type_sql}"
        elif issue["kind"] == "not_null_drift":
            sql = f"ALTER TABLE {table} ALTER COLUMN {column} DROP NOT NULL"
        else:
            skipped.append({**issue, "reason": "지원하지 않는 복구 유형"})
            continue

        if dry_run:
            applied.append({**issue, "sql": sql, "executed": False})
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
            applied.append({**issue, "sql": sql, "executed": True})
            logger.info("schema_health: repaired %s.%s (%s)", table, column, issue["kind"])
        except Exception as e:  # noqa: BLE001
            errors.append({**issue, "sql": sql, "error": str(e)[:300]})
            logger.warning("schema_health: repair failed %s.%s — %s", table, column, e)

    return {
        "dry_run": dry_run,
        "detected": drift["issue_count"],
        "applied": applied,
        "skipped": skipped,
        "errors": errors,
        # 복구 후 재검사 — dry_run 이면 의미가 없으므로 생략.
        "remaining": None if dry_run else inspect_drift()["issue_count"],
    }


def relax_not_null_drift() -> int:
    """부팅 안전망 — NOT NULL 드리프트만 자동으로 푼다.

    `_sync_missing_model_columns()` 가 "누락 컬럼"을 자동 보강하듯, 이 함수는 "레거시
    NOT NULL"을 자동 완화한다. 모델이 nullable 이라고 선언한 컬럼은 NULL 저장이
    정상 동작이므로, DB 쪽 제약을 푸는 것은 데이터 손실 없는 안전한 방향이다.
    반대 방향(모델 NOT NULL)은 backfill 판단이 필요해 건드리지 않는다.
    """
    relaxed = 0
    for issue in inspect_drift()["issues"]:
        if issue["kind"] != "not_null_drift":
            continue
        sql = (
            f"ALTER TABLE {issue['table']} "
            f"ALTER COLUMN {issue['column']} DROP NOT NULL"
        )
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
            relaxed += 1
            logger.warning(
                "migration: %s.%s 의 레거시 NOT NULL 을 해제함 (모델은 nullable). "
                "이 제약이 필요하다면 모델을 nullable=False 로 바꿀 것.",
                issue["table"], issue["column"],
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "migration: %s.%s NOT NULL 해제 실패 (%s) — 계속 진행",
                issue["table"], issue["column"], e,
            )
    return relaxed
