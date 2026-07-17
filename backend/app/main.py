import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text, inspect

from app.config import settings
from app.database import engine, Base, SessionLocal
from fastapi import Depends

from app.routers import (
    agent_router,
    clusters_router,
    daily_check_router,
    health_router,
    history_router,
    node_labels_router,
    node_images_router,
    playbooks_router,
    promql_router,
    work_items_router,
    jira_router,
    projects_router,
    sprints_router,
    ui_settings_router,
    workflows_router,
    work_guide_router,
    ops_note_router,
    voc_router,
    reactions_router,
    mindmap_router,
    management_server_router,
    isilon_nfs_router,
    infra_nodes_router,
    topology_trace_router,
    ontology_router,
    analyze_router,
    trends_router,
    versions_router,
    bulk_exec_router,
    etcdctl_router,
    cilium_trace_router,
    mc_client_router,
    node_server_specs_router,
    cluster_custom_fields_router,
    work_item_custom_fields_router,
    backup_router,
    service_entries_router,
    batch_jobs_router,
    commands_router,
    ansible_files_router,
    ansible_inventories_router,
    auth_router,
    audit_logs_router,
    deep_check_router,
    deep_check_ingest_router,
    deep_check_definitions_router,
    notifications_router,
    lake_services_router,
    bottleneck_router,
    lake_service_types_router,
    service_categories_router,
    ops_check_router,
    k8s_resources_router,
    k8s_allocation_router,
    k8s_helm_router,
    k8s_exec_router,
    metric_trend_router,
    service_topology_router,
    cluster_items_router,
    cluster_trends_router,
    terminal_appearance_router,
    k8s_events_router,
    k8s_events_ingest_router,
    release_notes_router,
    check_matrix_router,
)
from app.auth.deps import get_current_user
from app.auth.security import hash_password
from app.models.user import User


_log = logging.getLogger("k8s_monitor.migration")


def _ensure_pgvector_extension() -> None:
    """``CREATE EXTENSION IF NOT EXISTS vector`` — WorkItem/WorkGuide 임베딩 컬럼(Vector 타입)이
    쓰는 pgvector 확장을 보장한다.

    폐쇄망에서는 Postgres 서버에 pgvector 확장 패키지가 Nexus 로 미리 반입되어 있어야 한다
    (docs/AIRGAP_LLM_NEXUS.md 참고). ``Base.metadata.create_all()`` 보다 반드시 먼저 실행해야
    브랜드 뉴 설치에서 ``CREATE TABLE work_items (... embedding vector(768) ...)`` 가
    "type vector does not exist" 로 실패하지 않는다. 확장이 없으면 로깅만 하고 부팅은 계속 —
    이 경우 work_items/work_guides 테이블 생성 자체가 실패할 수 있으나(신규 설치 한정),
    다른 마이그레이션 단계는 개별 try/except 로 격리돼 있어 부팅 자체가 막히지 않는다.
    """
    from sqlalchemy import text as _text
    try:
        with engine.begin() as conn:
            # backend/celery-worker/celery-beat 등 여러 replica 가 동시에 부팅하며 각자 이
            # 함수를 실행하면 "CREATE EXTENSION IF NOT EXISTS" 의 존재 확인→생성이 원자적이지
            # 않아 두 세션이 동시에 생성을 시도해 duplicate key value violates unique
            # constraint "pg_extension_name_index" 로 충돌할 수 있다. 트랜잭션 advisory lock
            # 으로 직렬화해 이 레이스를 막는다 (커밋/롤백 시 자동 해제, 별도 unlock 불필요).
            conn.execute(_text("SELECT pg_advisory_xact_lock(872346192)"))
            conn.execute(_text("CREATE EXTENSION IF NOT EXISTS vector"))
        _log.info("migration: pgvector extension ensured")
    except Exception as e:  # noqa: BLE001
        _log.warning(
            "migration: pgvector extension 생성 실패 (%s) — 임베딩 컬럼 관련 기능 비활성화 가능. "
            "Nexus 로 postgresql-pgvector 패키지 반입 필요.", e,
        )


def _safe_add_column(table: str, col_name: str, col_type: str) -> None:
    """ALTER TABLE ... ADD COLUMN IF NOT EXISTS 를 단일 트랜잭션으로 실행.

    PostgreSQL 9.6+ 의 IF NOT EXISTS 를 사용해 중복 추가 시도에도 멱등. 발생한
    예외는 모두 잡아 로깅만 하고 부팅 자체를 막지 않는다 (defensive — 마이그레이션
    실패가 backend 기동 자체를 막아 CrashLoopBackOff 가 되던 문제 해결).
    """
    from sqlalchemy import text as _text
    try:
        with engine.begin() as conn:
            conn.execute(_text(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
            ))
        _log.info("migration: ensured %s.%s exists", table, col_name)
    except Exception as e:  # noqa: BLE001
        _log.warning(
            "migration: failed to add %s.%s (%s) — continuing", table, col_name, e
        )


def _backfill_work_items_service_from_module() -> None:
    """Phase B (knowledge-workitem-linkage) — module → service 1회성 backfill.

    Idempotent: ``WHERE service IS NULL`` 조건으로 이미 채워진 행은 건드리지 않음.
    매핑: monitoring→prometheus, infra→etcd, backend/frontend→skip(서비스 아님),
    나머지는 module 값을 service 에 1:1 복사 (k8s↔k8s 등).
    """
    from sqlalchemy import text as _text
    sql = _text("""
        UPDATE work_items
           SET service =
             CASE module
               WHEN 'monitoring' THEN 'prometheus'
               WHEN 'infra'      THEN 'etcd'
               ELSE module
             END
         WHERE service IS NULL
           AND module IS NOT NULL
           AND module NOT IN ('backend', 'frontend')
    """)
    try:
        with engine.begin() as conn:
            result = conn.execute(sql)
            n = result.rowcount if result.rowcount is not None else -1
        _log.info("backfill: %s rows updated (module → service)", n)
    except Exception as e:  # noqa: BLE001
        _log.warning("backfill: failed (%s) — continuing", e)


def _safe_exec(sql: str, *, label: str = "") -> None:
    """범용 DDL/DML 실행 헬퍼 — 한 트랜잭션으로 실행하고 예외는 로깅만.

    DROP NOT NULL, ALTER COLUMN TYPE ... USING, UPDATE backfill, ADD CONSTRAINT
    등 IF NOT EXISTS 가 없는 위험한 마이그레이션을 부팅 안전하게 감싼다.
    """
    from sqlalchemy import text as _text
    try:
        with engine.begin() as conn:
            conn.execute(_text(sql))
        if label:
            _log.info("migration: %s ok", label)
    except Exception as e:  # noqa: BLE001
        _log.warning("migration: %s skipped (%s)", label or sql[:80], e)


def _safe_create_index(name: str, table: str, expr: str) -> None:
    """CREATE INDEX IF NOT EXISTS — 부팅 안전 헬퍼."""
    _safe_exec(
        f"CREATE INDEX IF NOT EXISTS {name} ON {table} {expr}",
        label=f"index {name}",
    )


def _constraint_exists(name: str) -> bool:
    """pg_constraint 에 해당 이름의 제약이 이미 있는지."""
    from sqlalchemy import text as _text
    try:
        with engine.begin() as conn:
            row = conn.execute(
                _text("SELECT 1 FROM pg_constraint WHERE conname = :n LIMIT 1"),
                {"n": name},
            ).first()
        return row is not None
    except Exception:  # noqa: BLE001
        return False


def _safe_add_constraint(
    table: str,
    name: str,
    definition: str,
    *,
    requires_tables: tuple[str, ...] = (),
    label: str = "",
) -> None:
    """ADD CONSTRAINT 멱등 헬퍼 — ADD CONSTRAINT 는 IF NOT EXISTS 가 없어 매 부팅마다
    '이미 있음' / '참조 테이블 없음' 으로 warning 이 쌓인다. 이를 막기 위해:

    - 대상 테이블이 없으면 no-op.
    - 참조(requires_tables) 중 없는 테이블이 있으면 info 로 1줄 남기고 skip (warning 아님).
    - 같은 이름의 제약이 이미 있으면 조용히 skip.
    - 그 외에만 실제 ALTER TABLE ADD CONSTRAINT 실행.
    """
    lbl = label or name
    tables = set(inspect(engine).get_table_names())
    if table not in tables:
        return
    missing = [t for t in requires_tables if t not in tables]
    if missing:
        _log.info("migration: %s skipped (참조 테이블 없음: %s)", lbl, ", ".join(missing))
        return
    if _constraint_exists(name):
        return  # 이미 있음 — 조용히 통과 (재부팅 시 warning 누적 방지)
    _safe_exec(f"ALTER TABLE {table} ADD CONSTRAINT {name} {definition}", label=lbl)


def _run_migrations():
    """기존 테이블에 누락된 컬럼 추가 (경량 마이그레이션)"""
    inspector = inspect(engine)
    if "addons" in inspector.get_table_names():
        _safe_add_column("addons", "details", "JSONB")
        _safe_add_column("addons", "config", "JSONB")
    if "playbooks" in inspector.get_table_names():
        _safe_add_column("playbooks", "show_on_dashboard", "BOOLEAN DEFAULT FALSE")
        # 신규 FK 컬럼 — 컬럼만 먼저, REFERENCES 는 별도 ADD CONSTRAINT 로 분리 (대상 테이블 부재 위험 격리).
        _safe_add_column("playbooks", "playbook_file_id", "UUID")
        _safe_add_column("playbooks", "inventory_id", "UUID")
        _safe_add_constraint(
            "playbooks", "playbooks_playbook_file_id_fkey",
            "FOREIGN KEY (playbook_file_id) REFERENCES ansible_playbook_files(id)",
            requires_tables=("ansible_playbook_files",),
            label="playbooks.playbook_file_id FK",
        )
        _safe_add_constraint(
            "playbooks", "playbooks_inventory_id_fkey",
            "FOREIGN KEY (inventory_id) REFERENCES ansible_inventories(id)",
            requires_tables=("ansible_inventories",),
            label="playbooks.inventory_id FK",
        )
        # 기존 NOT NULL 제약 완화 — 데이터에 NULL 있을 수 있어 위험. 실패해도 부팅 진행.
        _safe_exec(
            "ALTER TABLE playbooks ALTER COLUMN playbook_path DROP NOT NULL",
            label="playbooks.playbook_path DROP NOT NULL",
        )
    if "clusters" in inspector.get_table_names():
        new_cluster_cols = [
            ("region", "VARCHAR(100)"),
            ("operation_level", "VARCHAR(50)"),
            ("max_pod", "INTEGER"),
            ("cilium_config", "TEXT"),
            ("cidr", "VARCHAR(255)"),
            ("internal_ips", "TEXT"),
            ("first_host", "VARCHAR(100)"),
            ("last_host", "VARCHAR(100)"),
            ("description", "TEXT"),
            ("node_count", "INTEGER"),
            ("hostname", "VARCHAR(255)"),
            ("pod_cidr", "VARCHAR(255)"),
            ("pod_first_host", "VARCHAR(100)"),
            ("pod_last_host", "VARCHAR(100)"),
            ("svc_cidr", "VARCHAR(255)"),
            ("svc_first_host", "VARCHAR(100)"),
            ("svc_last_host", "VARCHAR(100)"),
            ("bond0_ip", "VARCHAR(100)"),
            ("bond0_mac", "VARCHAR(50)"),
            ("bond1_ip", "VARCHAR(100)"),
            ("bond1_mac", "VARCHAR(50)"),
            ("bgp_enabled", "BOOLEAN DEFAULT FALSE"),
            ("as_number", "VARCHAR(20)"),
            ("kubeconfig_content", "TEXT"),
            ("k8s_version", "VARCHAR(128)"),
            ("cilium_version", "VARCHAR(128)"),
            ("node_ips", "TEXT"),
            ("custom_values", "JSONB"),
            ("seq", "INTEGER NOT NULL DEFAULT 1000"),
            ("icon", "VARCHAR(64)"),
            # G-9: TLS 검증 옵트인. 기본 false = 기존 verify=False 동작 유지.
            ("tls_verify", "BOOLEAN NOT NULL DEFAULT FALSE"),
            # Cluster Trends — per-cluster Prometheus URL 오버라이드 + 토글.
            ("prometheus_url", "VARCHAR(512)"),
            ("prometheus_enabled", "BOOLEAN NOT NULL DEFAULT FALSE"),
            # 점검 매트릭스 — core_bundle 행(DailyChecker 원자 실행) 클러스터별 cron.
            # check_schedules(구 아침/점심/저녁) 완전 대체.
            ("check_cron_expr", "VARCHAR(100)"),
            ("check_last_run_at", "TIMESTAMP"),
        ]
        for col_name, col_type in new_cluster_cols:
            _safe_add_column("clusters", col_name, col_type)

        # check_cron_expr 백필 — 기존 09/13/18시 하드코딩 스케줄과 동일한 동작을 보존.
        # cron 이 아직 설정 안 된(NULL) 클러스터에만 적용 — 사용자가 명시적으로 지운 경우는 없음
        # (지우기=NULL 로 재설정하는 UI 를 제공하지 않을 예정이라 매 부팅 재적용해도 안전).
        _safe_exec(
            "UPDATE clusters SET check_cron_expr = '0 9,13,18 * * *' WHERE check_cron_expr IS NULL",
            label="backfill clusters.check_cron_expr",
        )

        # seq 백필 — 기존 레코드는 created_at 순서대로 1000, 1010, 1020, ...
        # 새 컬럼이 막 추가됐다면 모두 default(1000) 이라 정렬이 안정적이지 않다.
        try:
            with engine.begin() as conn:
                rows = conn.execute(text(
                    "SELECT id FROM clusters WHERE seq = 1000 ORDER BY created_at"
                )).fetchall()
                if len(rows) > 1:
                    for i, row in enumerate(rows):
                        conn.execute(
                            text("UPDATE clusters SET seq = :seq WHERE id = :id"),
                            {"seq": 1000 + i * 10, "id": row[0]},
                        )
        except Exception as e:  # noqa: BLE001
            _log.warning("migration: clusters.seq backfill skipped — %s", e)

        # 길이 확장 — VARCHAR(32) → VARCHAR(128). 이미 128 이면 _safe_exec 가 no-op (Postgres 가 같은 타입 ALTER 는 허용).
        for col_name in ("k8s_version", "cilium_version"):
            _safe_exec(
                f"ALTER TABLE clusters ALTER COLUMN {col_name} TYPE VARCHAR(128)",
                label=f"clusters.{col_name} extend to VARCHAR(128)",
            )

        # icon: VARCHAR(64) → TEXT — 업로드된 이미지의 base64 data URL (수 KB) 저장용.
        _safe_exec(
            "ALTER TABLE clusters ALTER COLUMN icon TYPE TEXT",
            label="clusters.icon extend to TEXT (for data URL)",
        )

        # 백필: kubeconfig_content 가 NULL 인 기존 레코드 중 파일이 남아있으면 DB 로 복사
        # (/tmp 기반 저장소라 재시작 후 파일이 사라지면 영원히 못 살리므로 한 번은 시도)
        import os as _os
        try:
            with engine.begin() as conn:
                rows = conn.execute(text(
                    "SELECT id, kubeconfig_path FROM clusters "
                    "WHERE (kubeconfig_content IS NULL OR kubeconfig_content = '') "
                    "  AND kubeconfig_path IS NOT NULL AND kubeconfig_path != ''"
                )).fetchall()
                for cid, kc_path in rows:
                    if kc_path and _os.path.exists(kc_path):
                        try:
                            with open(kc_path, encoding="utf-8") as f:
                                kc_content = f.read()
                            if kc_content.strip():
                                conn.execute(
                                    text("UPDATE clusters SET kubeconfig_content = :c WHERE id = :id"),
                                    {"c": kc_content, "id": cid},
                                )
                        except Exception:
                            pass
        except Exception:
            pass
    # trend_sources: 마지막 수집 상태 컬럼 추가
    if "trend_sources" in inspector.get_table_names():
        for col_name, col_type in [
            ("last_status", "VARCHAR(20)"),
            ("last_message", "TEXT"),
            ("last_item_count", "INTEGER DEFAULT 0"),
            ("last_collected_at", "TIMESTAMP WITHOUT TIME ZONE"),
        ]:
            _safe_add_column("trend_sources", col_name, col_type)

    if "issues" in inspector.get_table_names():
        _safe_add_column("issues", "detail_content", "TEXT")
        # 통합지식 service tag — ui_settings.serviceCatalog 의 slug 와 연결
        _safe_add_column("issues", "service", "VARCHAR(64)")
        _safe_create_index("ix_issues_service", "issues", "(service)")
    if "workflow_steps" in inspector.get_table_names():
        _safe_add_column("workflow_steps", "step_type", "VARCHAR(50) NOT NULL DEFAULT 'action'")
        _safe_add_column("workflow_steps", "status", "VARCHAR(20) NOT NULL DEFAULT 'idle'")
        _safe_add_column("workflow_steps", "reference_type", "VARCHAR(50)")
        _safe_add_column("workflow_steps", "reference_id", "VARCHAR(100)")
        # 상태 어휘 변경 — 실행엔진(idle/running/success/failed) → 기획 게시판(todo/in-progress/blocked/done).
        # 기존 데이터를 새 값으로 매핑. 이미 매핑됐으면 WHERE 조건이 0건이라 no-op.
        _safe_exec(
            "UPDATE workflow_steps SET status = CASE status "
            "  WHEN 'idle' THEN 'todo' "
            "  WHEN 'running' THEN 'in-progress' "
            "  WHEN 'success' THEN 'done' "
            "  WHEN 'failed' THEN 'blocked' "
            "  ELSE status END "
            "WHERE status IN ('idle','running','success','failed')",
            label="workflow_steps.status remap",
        )
    # tasks: Date → DateTime 마이그레이션 + 칸반 보드 필드 추가
    if "tasks" in inspector.get_table_names():
        task_col_map = {col["name"]: col["type"].__class__.__name__ for col in inspector.get_columns("tasks")}
        # Date → Timestamp 타입 변경. USING cast 실패 가능 (잘못된 데이터) — _safe_exec 로 격리.
        for col_name in ("scheduled_at", "completed_at"):
            if col_name in task_col_map and task_col_map[col_name].upper() == "DATE":
                _safe_exec(
                    f"ALTER TABLE tasks ALTER COLUMN {col_name} TYPE TIMESTAMP WITHOUT TIME ZONE "
                    f"USING {col_name}::TIMESTAMP WITHOUT TIME ZONE",
                    label=f"tasks.{col_name} Date→Timestamp",
                )
        # 칸반 보드 신규 컬럼
        _safe_add_column("tasks", "kanban_status", "VARCHAR(20) NOT NULL DEFAULT 'todo'")
        _safe_add_column("tasks", "module", "VARCHAR(50)")
        _safe_add_column("tasks", "type_label", "VARCHAR(20)")
        _safe_add_column("tasks", "effort_hours", "INTEGER")
        _safe_add_column("tasks", "done_condition", "TEXT")
        # 통합지식 service tag — ui_settings.serviceCatalog 의 slug 와 연결
        _safe_add_column("tasks", "service", "VARCHAR(64)")
        _safe_create_index("ix_tasks_service", "tasks", "(service)")
        # 기존 completed_at 있는 레코드 → done 으로 동기화. 이미 done 이면 idempotent.
        _safe_exec(
            "UPDATE tasks SET kanban_status = 'done' "
            "WHERE completed_at IS NOT NULL AND kanban_status != 'done'",
            label="tasks.kanban_status sync from completed_at",
        )
        # Sub-task / issue link FK 컬럼 — 컬럼만 먼저, FK constraint 는 별도.
        _safe_add_column("tasks", "parent_id", "UUID")
        _safe_add_column("tasks", "issue_id", "UUID")
        _safe_add_constraint(
            "tasks", "tasks_parent_id_fkey",
            "FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE",
            requires_tables=("tasks",),
            label="tasks.parent_id FK",
        )
        _safe_add_constraint(
            "tasks", "tasks_issue_id_fkey",
            "FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL",
            requires_tables=("issues",),
            label="tasks.issue_id FK",
        )
    # issues: Date → DateTime + primary/secondary assignee
    if "issues" in inspector.get_table_names():
        issue_col_map = {col["name"]: col["type"].__class__.__name__ for col in inspector.get_columns("issues")}
        for col_name in ("occurred_at", "resolved_at"):
            if col_name in issue_col_map and issue_col_map[col_name].upper() == "DATE":
                _safe_exec(
                    f"ALTER TABLE issues ALTER COLUMN {col_name} TYPE TIMESTAMP WITHOUT TIME ZONE "
                    f"USING {col_name}::TIMESTAMP WITHOUT TIME ZONE",
                    label=f"issues.{col_name} Date→Timestamp",
                )
        # 3-step primary_assignee 마이그레이션 — 각 단계 격리. UPDATE 가 비어도 SET NOT NULL 진행해도 됨
        # (assignee 자체가 NOT NULL 이면 primary_assignee 도 NOT NULL 가능).
        _safe_add_column("issues", "primary_assignee", "VARCHAR(100)")
        _safe_exec(
            "UPDATE issues SET primary_assignee = assignee WHERE primary_assignee IS NULL",
            label="issues.primary_assignee backfill",
        )
        _safe_exec(
            "ALTER TABLE issues ALTER COLUMN primary_assignee SET NOT NULL",
            label="issues.primary_assignee SET NOT NULL",
        )
        _safe_add_column("issues", "secondary_assignee", "VARCHAR(100)")

    if "tasks" in inspector.get_table_names():
        _safe_add_column("tasks", "primary_assignee", "VARCHAR(100)")
        _safe_exec(
            "UPDATE tasks SET primary_assignee = assignee WHERE primary_assignee IS NULL",
            label="tasks.primary_assignee backfill",
        )
        _safe_exec(
            "ALTER TABLE tasks ALTER COLUMN primary_assignee SET NOT NULL",
            label="tasks.primary_assignee SET NOT NULL",
        )
        _safe_add_column("tasks", "secondary_assignee", "VARCHAR(100)")

    # ──────────────────────────────────────────────────────────────────────
    # WorkItem 통합 마이그레이션 — `tasks` 테이블을 work_items 로 rename + type
    # 디스크리미네이터 추가 + 의미 동일 컬럼 통일 (content/category/started_at/
    # closed_at/resolution) + issues 데이터 INSERT + issues DROP.
    #
    # 모든 단계는 _safe_* 헬퍼로 격리되어 한 단계가 실패해도 부팅이 막히지 않는다.
    # 기 마이그레이션된 환경(이미 work_items 가 있고 tasks 가 없는 환경)에서는
    # 각 단계가 자체 가드(inspector 선체크)로 no-op 가 된다.
    # ──────────────────────────────────────────────────────────────────────
    inspector = inspect(engine)  # 위 마이그레이션이 테이블/컬럼을 변경했을 수 있어 재취득
    existing_tables = set(inspector.get_table_names())

    # 1) tasks → work_items rename (work_items 가 아직 없을 때만)
    if "tasks" in existing_tables and "work_items" not in existing_tables:
        _safe_exec("ALTER TABLE tasks RENAME TO work_items", label="rename tasks→work_items")
        # FK constraint 이름도 일관성 위해 rename (실패해도 무해)
        for old, new in (
            ("tasks_parent_id_fkey", "work_items_parent_id_fkey"),
            ("tasks_issue_id_fkey", "work_items_related_id_fkey"),
            ("tasks_cluster_id_fkey", "work_items_cluster_id_fkey"),
        ):
            _safe_exec(
                f"ALTER TABLE work_items RENAME CONSTRAINT {old} TO {new}",
                label=f"rename constraint {old}→{new}",
            )
        existing_tables = set(inspect(engine).get_table_names())

    # 2) 컬럼 rename (Task 측 명칭 → 통일 명칭)
    if "work_items" in existing_tables:
        wi_cols = {c["name"] for c in inspect(engine).get_columns("work_items")}
        renames = (
            ("task_content", "content"),
            ("task_category", "category"),
            ("result_content", "resolution"),
            ("scheduled_at", "started_at"),
            ("completed_at", "closed_at"),
            ("issue_id", "related_work_item_id"),
        )
        for old, new in renames:
            if old in wi_cols and new not in wi_cols:
                _safe_exec(
                    f"ALTER TABLE work_items RENAME COLUMN {old} TO {new}",
                    label=f"rename work_items.{old}→{new}",
                )
        # type 디스크리미네이터 + issue 전용 detail_content 컬럼 추가
        _safe_add_column("work_items", "type", "VARCHAR(20) NOT NULL DEFAULT 'task'")
        _safe_add_column("work_items", "detail_content", "TEXT")
        _safe_create_index("ix_work_items_type", "work_items", "(type)")
        _safe_create_index("ix_work_items_started_at", "work_items", "(started_at DESC)")
        # G-I1: Enterprise audit 픽스 — 자주 필터되는 컬럼 인덱스 5개
        # kanban 보드/멤버별/클러스터별/날짜 필터의 N+ secondary lookup 대비.
        _safe_create_index("ix_work_items_kanban_status", "work_items", "(kanban_status)")
        _safe_create_index("ix_work_items_primary_assignee", "work_items", "(primary_assignee)")
        _safe_create_index("ix_work_items_cluster_id", "work_items", "(cluster_id)")
        _safe_create_index("ix_work_items_closed_at", "work_items", "(closed_at DESC)")
        # 칸반 보드 메인 쿼리용 복합 인덱스 — (status, recency)
        _safe_create_index(
            "ix_work_items_status_started",
            "work_items",
            "(kanban_status, started_at DESC)",
        )
        # Jira 연동 — 가져온 이슈 linkage 컬럼 (구버전 DB 호환). jira_issue_id 가 정규
        # dedup 키이며, 부분 UNIQUE 인덱스로 "Jira 이슈 1건 = work_item 1건" 보장.
        _safe_add_column("work_items", "jira_issue_id", "VARCHAR(50)")
        _safe_add_column("work_items", "jira_issue_key", "VARCHAR(50)")
        _safe_add_column("work_items", "jira_url", "TEXT")
        _safe_add_column("work_items", "jira_status", "VARCHAR(100)")
        _safe_add_column("work_items", "jira_synced_at", "TIMESTAMP WITHOUT TIME ZONE")
        _safe_add_column("work_items", "jira_updated_at", "TIMESTAMP WITHOUT TIME ZONE")
        _safe_add_column("work_items", "jira_watchers", "JSONB")
        _safe_create_index("ix_work_items_jira_issue_key", "work_items", "(jira_issue_key)")
        _safe_exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_work_items_jira_issue_id "
            "ON work_items (jira_issue_id) WHERE jira_issue_id IS NOT NULL",
            label="unique index work_items.jira_issue_id",
        )

    # 3) issues → work_items 백필 (issues 테이블이 존재할 때만)
    existing_tables = set(inspect(engine).get_table_names())
    if "issues" in existing_tables and "work_items" in existing_tables:
        _safe_exec(
            """
            INSERT INTO work_items (
                id, type, assignee, primary_assignee, secondary_assignee,
                cluster_id, cluster_name, service, confluence_url, remarks,
                category, content, resolution, detail_content,
                started_at, closed_at,
                priority, kanban_status,
                created_at, updated_at
            )
            SELECT
                id, 'issue', assignee, primary_assignee, secondary_assignee,
                cluster_id, cluster_name, service, confluence_url, remarks,
                issue_area, issue_content, action_content, detail_content,
                occurred_at, resolved_at,
                'medium',
                CASE WHEN resolved_at IS NOT NULL THEN 'done' ELSE 'todo' END,
                created_at, updated_at
            FROM issues
            ON CONFLICT (id) DO NOTHING
            """,
            label="backfill issues→work_items",
        )
        # related_work_item_id FK 재구성 — 기존엔 issues 를 가리켰음. 이제 work_items 자기참조로 교체.
        _safe_exec(
            "ALTER TABLE work_items DROP CONSTRAINT IF EXISTS tasks_issue_id_fkey",
            label="drop legacy tasks_issue_id_fkey",
        )
        _safe_exec(
            "ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_related_id_fkey",
            label="drop legacy work_items_related_id_fkey",
        )
        _safe_add_constraint(
            "work_items", "work_items_related_work_item_id_fkey",
            "FOREIGN KEY (related_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL",
            requires_tables=("work_items",),
            label="add work_items.related_work_item_id FK→work_items",
        )
        # 백필이 끝났으면 issues 테이블 DROP
        _safe_exec("DROP TABLE IF EXISTS issues CASCADE", label="drop legacy issues table")

    # 4) 통일 컬럼 NOT NULL 보강 — 통합 직후 NULL 값이 없을 때만 가능. 일부 행에 NULL 이
    # 있으면 _safe_exec 가 격리해 건너뛰고 다음 부팅에서 다시 시도된다.
    if "work_items" in set(inspect(engine).get_table_names()):
        wi_col_info = {c["name"]: c.get("nullable", True) for c in inspect(engine).get_columns("work_items")}
        for col in ("category", "content", "started_at", "kanban_status", "priority", "type"):
            if col in wi_col_info and wi_col_info[col]:
                _safe_exec(
                    f"ALTER TABLE work_items ALTER COLUMN {col} SET NOT NULL",
                    label=f"work_items.{col} SET NOT NULL",
                )

    # Phase B (knowledge-workitem-linkage) — service 하위 component 컬럼 추가 +
    # 기존 module 값을 service 로 1회성 backfill (idempotent).
    if "projects" not in set(inspect(engine).get_table_names()):
        try:
            _safe_exec(
                """CREATE TABLE IF NOT EXISTS projects (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name VARCHAR(200) NOT NULL,
                    description TEXT,
                    goal TEXT,
                    color VARCHAR(20) NOT NULL DEFAULT 'blue',
                    start_date DATE,
                    end_date DATE,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )""",
                label="projects table",
            )
        except Exception as e:
            logger.warning(f"migration: projects table skipped ({e})")

    if "work_items" in set(inspect(engine).get_table_names()):
        _safe_add_column("work_items", "project_id", "UUID REFERENCES projects(id) ON DELETE SET NULL")
        _safe_exec(
            "CREATE INDEX IF NOT EXISTS ix_work_items_project_id ON work_items(project_id)",
            label="work_items.project_id index",
        )
        _safe_add_column("work_items", "title", "VARCHAR(200)")
        _safe_add_column("work_items", "component", "VARCHAR(64)")
        # 다중 대상 클러스터 — 같은 업무를 여러 클러스터에서 수행. cluster_id 는 대표값 유지.
        _safe_add_column("work_items", "cluster_ids", "JSONB")
        _safe_add_column("work_items", "cluster_names", "JSONB")
        # 사용자 정의 필드 값
        _safe_add_column("work_items", "custom_values", "JSONB")
        # 전체 참석(회의 등)
        _safe_add_column("work_items", "all_attendees", "BOOLEAN NOT NULL DEFAULT FALSE")
        # 스프린트(반복) 소속 — sprints 테이블은 create_all 로 생성됨.
        _safe_add_column("work_items", "sprint_id", "UUID")
        # 유사 WorkItem 검색용 임베딩(제목+본문) — pgvector 확장 필요 (_ensure_pgvector_extension).
        _safe_add_column("work_items", "embedding", f"VECTOR({settings.embedding_dim})")
        # 스프린트 JIRA 번호 및 Confluence 링크
        _safe_add_column("sprints", "jira_no", "VARCHAR(100)")
        _safe_add_column("sprints", "confluence_link", "VARCHAR(500)")
        _safe_create_index("ix_work_items_sprint_id", "work_items", "(sprint_id)")
        # 등록자(생성자) — 본인이 등록한 work item 을 (담당자가 아니어도) 수정/삭제할 수 있도록.
        _safe_add_column("work_items", "created_by", "VARCHAR(100)")
        _safe_exec(
            "CREATE INDEX IF NOT EXISTS ix_work_items_created_by ON work_items(created_by)",
            label="work_items.created_by index",
        )
        _safe_exec(
            "CREATE INDEX IF NOT EXISTS ix_work_items_component ON work_items(component)",
            label="work_items.component index",
        )
        _backfill_work_items_service_from_module()

    # clusters: statusenum 에 'pending' 값 추가 (PostgreSQL enum 확장)
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TYPE statusenum ADD VALUE IF NOT EXISTS 'pending'"))
    except Exception:
        pass  # 이미 존재하거나 enum 이름이 다를 경우 무시

    # infra_nodes: 물리 서버 노드 테이블 생성
    if "infra_nodes" not in inspector.get_table_names():
        with engine.begin() as conn:
            conn.execute(text('''
                CREATE TABLE infra_nodes (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    cluster_id UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
                    hostname VARCHAR(255) NOT NULL,
                    rack_name VARCHAR(100),
                    ip_address VARCHAR(45),
                    role VARCHAR(20) NOT NULL DEFAULT \'worker\',
                    cpu_cores INTEGER,
                    ram_gb INTEGER,
                    disk_gb INTEGER,
                    os_info VARCHAR(200),
                    switch_name VARCHAR(100),
                    notes TEXT,
                    auto_synced BOOLEAN DEFAULT FALSE,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            '''))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_nodes_cluster_hostname "
                "ON infra_nodes(cluster_id, hostname)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_infra_nodes_cluster_hostname "
                "ON infra_nodes(cluster_id, hostname)"
            ))
    else:
        _safe_add_column("infra_nodes", "version", "INTEGER NOT NULL DEFAULT 1")
        _safe_exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_nodes_cluster_hostname "
            "ON infra_nodes(cluster_id, hostname)",
            label="unique index infra_nodes(cluster_id, hostname)",
        )
        _safe_create_index("ix_infra_nodes_cluster_hostname", "infra_nodes", "(cluster_id, hostname)")

    # isilon_servers / isilon_commands: Isilon NFS 모니터링 (테이블은 create_all 로 생성,
    # 구버전 DB 호환용으로 신규 컬럼 보강). 향후 컬럼 추가 시 여기에 _safe_add_column 추가.
    if "isilon_servers" in inspector.get_table_names():
        _safe_add_column("isilon_servers", "is_default", "BOOLEAN DEFAULT FALSE")
        _safe_add_column("isilon_servers", "encrypted_password", "VARCHAR")
        _safe_add_column("isilon_servers", "encrypted_private_key", "VARCHAR")
    if "isilon_commands" in inspector.get_table_names():
        _safe_add_column("isilon_commands", "show_on_overview", "BOOLEAN DEFAULT TRUE")
        _safe_add_column("isilon_commands", "is_builtin", "BOOLEAN DEFAULT FALSE")
        _safe_create_index("ix_isilon_commands_server", "isilon_commands", "(server_id)")

    # topology_audit_logs: 토폴로지 변경 감사 로그
    if "topology_audit_logs" not in inspector.get_table_names():
        with engine.begin() as conn:
            conn.execute(text('''
                CREATE TABLE topology_audit_logs (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    cluster_id UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
                    entity_type VARCHAR(20) NOT NULL,
                    entity_id VARCHAR(100),
                    action VARCHAR(30) NOT NULL,
                    scope VARCHAR(20) NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'success',
                    reason TEXT,
                    before_data JSONB,
                    after_data JSONB,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            '''))

    # work_guides: 계층 구조 + 정렬 컬럼 추가
    if "work_guides" in inspector.get_table_names():
        _safe_add_column("work_guides", "parent_id", "UUID")
        _safe_add_column("work_guides", "sort_order", "INTEGER NOT NULL DEFAULT 0")
        # 유사 문서 검색용 임베딩(제목+본문) — pgvector 확장 필요 (_ensure_pgvector_extension).
        _safe_add_column("work_guides", "embedding", f"VECTOR({settings.embedding_dim})")

    # 지식베이스(KnowledgePage) 기능 제거 — 더 이상 사용하지 않는 테이블 정리(데이터 불필요).
    # 구버전 DB 에 남아있을 수 있는 3개 테이블을 안전하게 DROP.
    for _kb_table in ("knowledge_presence", "knowledge_page_versions", "knowledge_pages"):
        if _kb_table in inspector.get_table_names():
            _safe_exec(f"DROP TABLE IF EXISTS {_kb_table} CASCADE", label=f"drop {_kb_table}")

    # confluence_url 컬럼 — 모든 작성형 엔티티 (tasks/issues/ops_notes/work_guides/
    # command_entries/workflows/mindmaps)에 공통으로 Confluence 문서 링크를 저장.
    # work_items 는 통합 후 명칭. tasks/issues 는 마이그레이션 이전 환경 호환.
    _current_tables = set(inspect(engine).get_table_names())
    for tbl in (
        "work_items", "tasks", "issues", "ops_notes", "work_guides",
        "command_entries", "workflows", "mindmaps",
    ):
        if tbl in _current_tables:
            _safe_add_column(tbl, "confluence_url", "TEXT")

    # dl_url 컬럼 — 운영 노트(ops_notes) 전용 DL(Data Lake 등) 참고 링크.
    if "ops_notes" in _current_tables:
        _safe_add_column("ops_notes", "dl_url", "TEXT")

    # node_server_specs: 자산 대장 신규 필드
    if "node_server_specs" in inspector.get_table_names():
        _safe_add_column("node_server_specs", "is_ssd", "BOOLEAN")
        _safe_add_column("node_server_specs", "is_vm", "BOOLEAN")
        _safe_add_column("node_server_specs", "current_usage", "VARCHAR(255)")
        _safe_add_column("node_server_specs", "purchase_purpose", "VARCHAR(255)")
        _safe_add_column("node_server_specs", "non_os_disk_gb", "INTEGER")
        # disk_type: VARCHAR(32) → VARCHAR(255). 이미 255 이상이면 _safe_exec 가 no-op.
        _safe_exec(
            "ALTER TABLE node_server_specs ALTER COLUMN disk_type TYPE VARCHAR(255)",
            label="node_server_specs.disk_type extend",
        )

    # daily_check_logs: AI 자동 리뷰 필드 추가 + 구버전 누락 컬럼 방어 보충
    # 각 ALTER 는 _safe_add_column 으로 IF NOT EXISTS + try/except 처리되어 한 컬럼이
    # 실패해도 다른 컬럼은 계속 진행, 부팅 자체는 막히지 않는다.
    if "daily_check_logs" in inspector.get_table_names():
        for col_name, col_type in [
            # 모델에 일찍부터 있던 컬럼들 — 일부 오래된 DB 에는 빠져 있을 수 있음
            ("checked_at", "TIMESTAMP WITHOUT TIME ZONE"),
            ("check_duration_seconds", "INTEGER"),
            ("api_server_details", "JSONB"),
            ("components_status", "JSONB"),
            ("nodes_status", "JSONB"),
            ("system_pods_status", "JSONB"),
            ("resource_summary", "JSONB"),
            ("error_messages", "JSONB"),
            ("warning_messages", "JSONB"),
            # AI 자동 리뷰 (Phase 1)
            ("ai_summary", "TEXT"),
            ("ai_remediation", "TEXT"),
            ("ai_diff", "JSONB"),
            ("ai_trend", "JSONB"),
            ("ai_status", "VARCHAR(20)"),
            ("ai_generated_at", "TIMESTAMP WITHOUT TIME ZONE"),
        ]:
            _safe_add_column("daily_check_logs", col_name, col_type)
        # checked_at 가 방금 추가됐다면 기존 행 backfill — check_date 를 기본값으로 사용.
        _safe_exec(
            "UPDATE daily_check_logs SET checked_at = check_date WHERE checked_at IS NULL",
            label="daily_check_logs.checked_at backfill",
        )
        # 인덱스 — daily_check 결과 라우터가 ORDER BY checked_at DESC 를 자주 함.
        _safe_create_index(
            "ix_daily_check_logs_checked_at", "daily_check_logs", "(checked_at DESC)"
        )
        _safe_create_index(
            "ix_daily_check_logs_cluster_checked", "daily_check_logs",
            "(cluster_id, checked_at DESC)",
        )

    # check_logs: 구버전 누락 컬럼 방어 보충 (history.py 가 checked_at 으로 ORDER BY)
    if "check_logs" in inspector.get_table_names():
        for col_name, col_type in [
            ("checked_at", "TIMESTAMP WITHOUT TIME ZONE"),
            ("addon_id", "UUID"),  # FK 는 따로 추가 — ADD COLUMN IF NOT EXISTS 는 REFERENCES 함께 못 씀
            ("raw_output", "JSONB"),
        ]:
            _safe_add_column("check_logs", col_name, col_type)
        # FK constraint 별도 추가 (이미 있거나 addons 부재 모두 silently skip)
        _safe_add_constraint(
            "check_logs", "check_logs_addon_id_fkey",
            "FOREIGN KEY (addon_id) REFERENCES addons(id)",
            requires_tables=("addons",),
            label="check_logs.addon_id FK",
        )
        _safe_exec(
            "UPDATE check_logs SET checked_at = NOW() WHERE checked_at IS NULL",
            label="check_logs.checked_at backfill",
        )
        # 인덱스 — history.py 가 ORDER BY checked_at DESC 빈번.
        _safe_create_index("ix_check_logs_checked_at", "check_logs", "(checked_at DESC)")
        _safe_create_index("ix_check_logs_cluster_addon", "check_logs", "(cluster_id, addon_id)")

    # deep_check_definitions / deep_check_results — Super Pod 결과 저장.
    # SQLAlchemy create_all 이 이미 생성하지만, 명시적으로 인덱스/idempotent 보장.
    if "deep_check_definitions" in inspector.get_table_names():
        _safe_create_index("ix_deep_check_definitions_cluster", "deep_check_definitions", "(cluster_id)")
        _safe_create_index("ix_deep_check_definitions_type", "deep_check_definitions", "(check_type)")
    if "deep_check_results" in inspector.get_table_names():
        # 구버전 DB 호환 — 테이블이 이미 있으면 create_all 이 컬럼을 추가하지 않으므로
        # 모델에 새로 생긴 컬럼을 명시적으로 보강한다. (index 생성보다 먼저!)
        for col_name, col_type in [
            ("definition_id", "UUID"),
            ("ai_summary", "TEXT"),
            ("ai_remediation", "TEXT"),
            ("duration_ms", "INTEGER"),
            ("checked_at", "TIMESTAMP WITHOUT TIME ZONE"),
        ]:
            _safe_add_column("deep_check_results", col_name, col_type)
        # checked_at 이 방금 추가됐다면 기존 행 backfill (NULL → 현재시각).
        _safe_exec(
            "UPDATE deep_check_results SET checked_at = NOW() WHERE checked_at IS NULL",
            label="deep_check_results.checked_at backfill",
        )
        _safe_create_index("ix_deep_check_results_cluster", "deep_check_results", "(cluster_id)")
        _safe_create_index("ix_deep_check_results_daily_log", "deep_check_results", "(daily_check_log_id)")
        _safe_create_index("ix_deep_check_results_checked_at", "deep_check_results", "(checked_at DESC)")

    # user_jira_credentials: 인증 방식 컬럼 (PAT | 세션 쿠키). 구버전 DB 는 PAT 전용이라 기본 'pat'.
    if "user_jira_credentials" in inspector.get_table_names():
        _safe_add_column("user_jira_credentials", "auth_type", "VARCHAR(16) NOT NULL DEFAULT 'pat'")

    # batch_jobs: 저장형 자격증명 컬럼 추가 (스케줄 실행용)
    if "batch_jobs" in inspector.get_table_names():
        _safe_add_column("batch_jobs", "encrypted_password", "TEXT")
        _safe_add_column("batch_jobs", "encrypted_private_key", "TEXT")
        # 스케줄러 판정 가시화 (왜 스케줄이 안 돌았는지)
        _safe_add_column("batch_jobs", "last_schedule_check_at", "TIMESTAMP")
        _safe_add_column("batch_jobs", "last_schedule_note", "VARCHAR(200)")

    # users: 강제 비밀번호 변경 플래그 + 레거시 role 정규화 + 에디터 개인 설정
    if "users" in inspector.get_table_names():
        _safe_add_column("users", "must_change_password", "BOOLEAN NOT NULL DEFAULT FALSE")
        _safe_add_column("users", "editor_white_bg", "BOOLEAN DEFAULT FALSE")
        # 레거시: 'user' role 을 'viewer' 로 일회성 변환. 신규 코드는 'viewer/operator/admin' 만 사용.
        _safe_exec(
            "UPDATE users SET role='viewer' WHERE role='user'",
            label="users.role 'user' → 'viewer'",
        )
        # 강제 변경 정책 폐기 — 과거 시드/리셋으로 True 였던 사용자를 모두 해제.
        _safe_exec(
            "UPDATE users SET must_change_password = FALSE WHERE must_change_password = TRUE",
            label="users.must_change_password → FALSE (강제 변경 정책 해제)",
        )

    # audit_logs: create_all 이 테이블 자체는 만들지만 보조 인덱스만 명시.
    if "audit_logs" in inspector.get_table_names():
        _safe_create_index("ix_audit_logs_created_at_desc", "audit_logs", "(created_at DESC)")

    # ops_check_*: 운영 점검 콘솔 — 테이블은 create_all 이 생성, 폴링/조회용 인덱스만 보강.
    if "ops_check_runs" in inspector.get_table_names():
        _safe_create_index("ix_ops_check_runs_cluster_created", "ops_check_runs", "(cluster_id, created_at DESC)")
    if "ops_check_run_items" in inspector.get_table_names():
        _safe_create_index("ix_ops_check_run_items_run", "ops_check_run_items", "(run_id)")
        _safe_create_index("ix_ops_check_run_items_ref", "ops_check_run_items", "(source, item_ref_id)")

    # os_param_changes: OS 파라미터 변경 이력 — 테이블은 create_all, 조회 인덱스 보강.
    if "os_param_changes" in inspector.get_table_names():
        _safe_create_index("ix_os_param_changes_to_snap", "os_param_changes", "(node, to_snapshot_id)")

    # cluster_items: 현황 아이템 — 문자형/도메인상태 컬럼은 구버전 DB 호환을 위해 보강.
    if "cluster_items" in inspector.get_table_names():
        _safe_add_column("cluster_items", "current_text", "TEXT")
        _safe_add_column("cluster_items", "previous_text", "TEXT")
        _safe_add_column("cluster_items", "result_status", "VARCHAR(20)")
        _safe_create_index("ix_cluster_items_cluster", "cluster_items", "(cluster_id)")

    # k8s_events: kubewatch 웹훅 수신 이벤트 — 테이블은 create_all, 인덱스 보강.
    if "k8s_events" in inspector.get_table_names():
        _safe_create_index("ix_k8s_events_received_at", "k8s_events", "(received_at DESC)")
        _safe_create_index("ix_k8s_events_severity", "k8s_events", "(severity)")
        _safe_create_index("ix_k8s_events_cluster_received", "k8s_events", "(cluster_id, received_at DESC)")

    # PEP/APP 서비스 카테고리(Runtime/Catalog/Workflow/JupyterLab 등) — service_categories 는
    # create_all 로 신규 생성, lake_service_types/lake_services 에 domain/category_id 보강.
    if "lake_service_types" in inspector.get_table_names():
        _safe_add_column("lake_service_types", "domain", "VARCHAR(10) NOT NULL DEFAULT 'pep'")
        _safe_add_column("lake_service_types", "category_id", "UUID")
        _safe_create_index("ix_lake_types_domain_category", "lake_service_types", "(domain, category_id)")
        _safe_add_constraint(
            "lake_service_types", "lake_service_types_category_id_fkey",
            "FOREIGN KEY (category_id) REFERENCES service_categories(id) ON DELETE SET NULL",
            requires_tables=("service_categories",),
            label="lake_service_types.category_id FK",
        )
    if "lake_services" in inspector.get_table_names():
        _safe_add_column("lake_services", "domain", "VARCHAR(10) NOT NULL DEFAULT 'pep'")
        _safe_create_index("ix_lake_services_domain", "lake_services", "(domain)")


def _seed_default_metric_cards():
    """Seed default PromQL metric cards if the table is empty."""
    from app.models.metric_card import MetricCard

    db = SessionLocal()
    try:
        if db.query(MetricCard).count() > 0:
            return  # already seeded

        defaults = [
            MetricCard(
                title="CrashLoopBackOff Pods",
                description="Number of pods stuck in CrashLoopBackOff",
                icon="🚨",
                promql='sum(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}) OR on() vector(0)',
                unit="count",
                display_type="value",
                category="alert",
                thresholds="warning:1,critical:3",
                sort_order=0,
            ),
            MetricCard(
                title="Failed Pods",
                description="Number of pods in Failed phase",
                icon="💀",
                promql='sum(kube_pod_status_phase{phase="Failed"}) OR on() vector(0)',
                unit="count",
                display_type="value",
                category="alert",
                thresholds="warning:1,critical:5",
                sort_order=1,
            ),
            MetricCard(
                title="Cluster CPU Usage",
                description="Overall cluster CPU utilization",
                icon="⚡",
                promql='100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
                unit="%",
                display_type="gauge",
                category="resource",
                thresholds="warning:70,critical:90",
                sort_order=2,
            ),
            MetricCard(
                title="Cluster Memory Usage",
                description="Overall cluster memory utilization",
                icon="🧠",
                promql="100 * (1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)))",
                unit="%",
                display_type="gauge",
                category="resource",
                thresholds="warning:75,critical:90",
                sort_order=3,
            ),
            MetricCard(
                title="PVC Disk Usage > 80%",
                description="Persistent volumes nearing capacity",
                icon="💾",
                promql="(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) * 100 > 80",
                unit="%",
                display_type="list",
                category="storage",
                thresholds="warning:80,critical:95",
                sort_order=4,
            ),
            MetricCard(
                title="Inbound Network Traffic",
                description="Cluster-wide inbound traffic rate",
                icon="🌐",
                promql="sum(rate(container_network_receive_bytes_total[5m]))",
                unit="bytes/s",
                display_type="value",
                category="network",
                sort_order=5,
            ),
        ]

        db.add_all(defaults)
        db.commit()
    finally:
        db.close()


def _seed_cluster_items():
    """모든 클러스터에 기본(builtin) 아이템(K8s 노드 수 등)을 보장한다.

    신규 클러스터는 생성 시점에 보장되지만, 구버전 데이터/누락 보정을 위해
    부팅 시에도 한 번 점검한다. (idempotent — 이미 있으면 skip)
    """
    from app.models import Cluster
    from app.services import cluster_item_service as cis

    db = SessionLocal()
    try:
        for cluster in db.query(Cluster).all():
            try:
                cis.ensure_builtin_items(db, cluster)
            except Exception:  # noqa: BLE001
                db.rollback()
    finally:
        db.close()


def _seed_default_trend_sources():
    """기본 트렌드 수집 소스 등록 (최초 1회)"""
    from app.models.trend import TrendSource

    db = SessionLocal()
    try:
        if db.query(TrendSource).count() > 0:
            return
        defaults = [
            TrendSource(name="Kubernetes", source_type="github_release", url="kubernetes/kubernetes", category="k8s"),
            TrendSource(name="Cilium",     source_type="github_release", url="cilium/cilium",         category="cilium"),
            TrendSource(name="Linux Kernel", source_type="github_release", url="torvalds/linux",      category="linux"),
            TrendSource(name="Kubernetes 블로그", source_type="rss", url="https://kubernetes.io/feed.xml",       category="k8s"),
            TrendSource(name="Cilium 블로그",     source_type="rss", url="https://cilium.io/blog/rss.xml",      category="cilium"),
            TrendSource(name="CNCF 블로그",       source_type="rss", url="https://www.cncf.io/blog/feed/",      category="cncf"),
            TrendSource(name="LWN.net",           source_type="rss", url="https://lwn.net/headlines/rss",       category="linux"),
            TrendSource(name="kernel.org",        source_type="rss", url="https://www.kernel.org/feeds/all.atom.xml", category="linux"),
        ]
        db.add_all(defaults)
        db.commit()
    finally:
        db.close()


_SAMPLE_PLAYBOOKS = [
    {
        "name": "NTP / Chrony 동기화 점검",
        "description": "각 노드의 시간 동기화 상태와 drift 를 점검 (chronyc tracking / timedatectl).",
        "playbook_path": "ntp_sync_check.yml",
        "extra_vars": {"max_drift_ms": 1000},
        "show_on_dashboard": True,
    },
    {
        "name": "디스크 사용률 점검",
        "description": "df -P 결과를 파싱해 임계 (warn 80%, crit 90%) 초과 파티션 검출.",
        "playbook_path": "disk_usage_check.yml",
        "extra_vars": {"warn_pct": 80, "crit_pct": 90},
        "show_on_dashboard": True,
    },
    {
        "name": "K8s 권장 sysctl 감사",
        "description": "net.bridge.bridge-nf-call-iptables, ip_forward, swappiness 등 권장값 위반 검출.",
        "playbook_path": "kernel_sysctl_audit.yml",
        "extra_vars": None,
        "show_on_dashboard": False,
    },
    {
        "name": "노드 부하 (load average) 점검",
        "description": "load5 / CPU코어 비율로 부하 경고 (warn 0.8, crit 1.5).",
        "playbook_path": "node_load_check.yml",
        "extra_vars": {"warn_ratio": 0.8, "crit_ratio": 1.5},
        "show_on_dashboard": True,
    },
    {
        "name": "K8s 인증서 만료 점검",
        "description": "/etc/kubernetes/pki/*.crt 들의 NotAfter 까지 남은 일수 (warn 60일 · crit 14일).",
        "playbook_path": "cert_expiry_check.yml",
        "extra_vars": {"warn_days": 60, "crit_days": 14},
        "show_on_dashboard": True,
    },
]


def _seed_default_playbooks():
    """샘플 playbook 시드.

    구조: ``ansible/playbooks/*.yml`` 본문을 DB(``ansible_playbook_files``) 에 적재한 뒤,
    각 클러스터에 대해 ``Playbook`` 행을 생성하고 ``playbook_file_id`` 로 연결한다.
    이렇게 하면 사용자가 운영 중 카드 본문을 수정·재배포할 때도 컨테이너 이미지를
    다시 만들 필요 없이 DB 만으로 관리된다.

    이미 같은 name 으로 등록된 playbook 이 있으면 skip — 사용자 변경을 보존.
    """
    from app.models.ansible_assets import AnsiblePlaybookFile
    from app.models.cluster import Cluster
    from app.models.playbook import Playbook

    # 1) 디스크의 .yml 본문을 읽어 ansible_playbook_files 에 upsert.
    base_dir = settings.ansible_playbook_dir.rstrip("/")
    file_id_by_sample: dict[str, "uuid.UUID"] = {}
    db = SessionLocal()
    try:
        for sp in _SAMPLE_PLAYBOOKS:
            disk_path = f"{base_dir}/{sp['playbook_path']}"
            if not os.path.exists(disk_path):
                # 파일이 없으면 스킵 — 컨테이너 빌드 컨텍스트에 ansible/ 가 빠진 경우.
                continue
            try:
                with open(disk_path, "r", encoding="utf-8") as f:
                    body = f.read()
            except OSError:
                continue

            existing = db.query(AnsiblePlaybookFile).filter(
                AnsiblePlaybookFile.name == sp["name"],
            ).first()
            if existing is None:
                row = AnsiblePlaybookFile(
                    name=sp["name"],
                    description=sp["description"],
                    content=body,
                )
                db.add(row)
                db.flush()
                file_id_by_sample[sp["name"]] = row.id
            else:
                # 기존 description 만 갱신 (content 는 사용자 편집 가능성 있어 보존).
                if existing.description != sp["description"]:
                    existing.description = sp["description"]
                file_id_by_sample[sp["name"]] = existing.id
        db.commit()

        # 2) 등록된 클러스터마다 Playbook 행을 생성, playbook_file_id 로 연결.
        clusters = db.query(Cluster).all()
        if not clusters:
            return  # 클러스터가 등록될 때까지 보류 (재기동 시 다시 시도됨)

        added = 0
        for cluster in clusters:
            existing_names = {
                row[0] for row in db.query(Playbook.name)
                .filter(Playbook.cluster_id == cluster.id).all()
            }
            for sp in _SAMPLE_PLAYBOOKS:
                if sp["name"] in existing_names:
                    continue
                pb = Playbook(
                    cluster_id=cluster.id,
                    name=sp["name"],
                    description=sp["description"],
                    # 신 모델: DB 본문을 가리키는 FK 사용. (구 playbook_path 는 더 이상 의존하지 않음)
                    playbook_file_id=file_id_by_sample.get(sp["name"]),
                    inventory_path=None,   # ← K8s 전체 노드를 동적 inventory 로 사용
                    extra_vars=sp.get("extra_vars"),
                    show_on_dashboard=sp.get("show_on_dashboard", False),
                )
                db.add(pb)
                added += 1
        if added:
            db.commit()
    finally:
        db.close()


def _seed_default_deep_check_definitions():
    """Seed default DeepCheckDefinition rows — registry 에 신규 check_type 이 추가되면
    같은 check_type 의 글로벌 정의가 없을 때만 자동 등록.

    사용자가 글로벌 정의를 삭제했다면 다음 부팅 시 다시 채워진다.
    클러스터별 정의 (cluster_id IS NOT NULL) 와 사용자 수정은 영향 없음.
    """
    from app.models.deep_check import DeepCheckDefinition
    from app.services.deep_checkers import REGISTRY

    db = SessionLocal()
    try:
        existing = {
            row[0]
            for row in db.query(DeepCheckDefinition.check_type)
            .filter(DeepCheckDefinition.cluster_id.is_(None))
            .all()
        }
        # 정렬 시작점: 기존 최대 sort_order 다음.
        max_sort = (
            db.query(DeepCheckDefinition.sort_order)
            .order_by(DeepCheckDefinition.sort_order.desc())
            .limit(1)
            .scalar()
        ) or 0
        sort_order = max_sort + 10 if existing else 0
        added = 0
        for ct, (_, spec) in REGISTRY.items():
            if ct in existing:
                continue
            db.add(DeepCheckDefinition(
                cluster_id=None,
                check_type=ct,
                name=spec.display_name,
                description=spec.description,
                enabled=getattr(spec, "default_enabled", True),
                schedule_cron=None,
                thresholds=dict(spec.default_thresholds),
                params=dict(spec.default_params),
                sort_order=sort_order,
            ))
            sort_order += 10
            added += 1
        if added:
            db.commit()
    finally:
        db.close()


def _seed_default_isilon_commands():
    """Isilon NFS 수집용 기본(builtin) 명령을 글로벌 기본(server_id IS NULL)으로 시드.

    isilon_service.BUILTIN_COMMANDS 를 key 기준 idempotent 로 등록한다(같은 글로벌 key 가
    없을 때만). 운영자가 편집/비활성/추가할 수 있고, 삭제한 builtin 은 다음 부팅 시 복구된다.
    시드 전 validate_isi_command 로 읽기전용·무부하 정책을 재확인한다(부하 보호).
    """
    from app.models.isilon_server import IsilonCommand
    from app.services.isilon_service import BUILTIN_COMMANDS, validate_isi_command

    db = SessionLocal()
    try:
        existing = {
            row[0]
            for row in db.query(IsilonCommand.key)
            .filter(IsilonCommand.server_id.is_(None))
            .all()
        }
        added = 0
        for spec in BUILTIN_COMMANDS:
            if spec["key"] in existing:
                continue
            try:
                validate_isi_command(spec["command"])
            except Exception as e:  # noqa: BLE001 — 잘못된 builtin 은 스킵(로그만).
                _startup_log.warning("isilon builtin '%s' skipped (invalid): %s", spec["key"], e)
                continue
            db.add(IsilonCommand(
                server_id=None,
                key=spec["key"],
                label=spec["label"],
                section=spec["section"],
                command=spec["command"],
                parse_mode=spec.get("parse_mode", "text"),
                timeout_seconds=spec.get("timeout_seconds", 15),
                enabled=spec.get("enabled", True),
                show_on_overview=spec.get("show_on_overview", True),
                sort_order=spec.get("sort_order", 100),
                is_builtin=True,
            ))
            added += 1
        if added:
            db.commit()
    finally:
        db.close()


def _seed_default_metric_checklist_items():
    """리소스 수 추세 체크리스트 기본 항목(글로벌) 시드 — item_key 매칭 idempotent.

    운영자가 글로벌 항목을 삭제하면 다음 부팅 시 복구. 클러스터별 정의는 영향 없음.
    """
    from app.models.resource_count import MetricChecklistItem
    from app.services.resource_count_service import DEFAULT_ITEMS

    db = SessionLocal()
    try:
        existing = {
            row[0]
            for row in db.query(MetricChecklistItem.item_key)
            .filter(MetricChecklistItem.cluster_id.is_(None))
            .all()
        }
        added = 0
        for i, (key, label, kind) in enumerate(DEFAULT_ITEMS):
            if key in existing:
                continue
            db.add(MetricChecklistItem(
                cluster_id=None, item_key=key, label=label, resource_kind=kind,
                enabled=True, sort_order=i * 10, params={},
            ))
            added += 1
        if added:
            db.commit()
    finally:
        db.close()


def _seed_default_lake_service_types():
    """LAKE 8 builtin service_type 을 DB 에 자동 등록.

    service_type slug 매칭 idempotent — 이미 있으면 skip (label/category 등은
    운영자가 수정했을 수 있어 보존). 운영자가 builtin row 를 삭제한 경우 부팅 시
    자동 복구.

    PDCA: lake-service-type-management
    """
    from app.models import LakeServiceType
    from app.services.lake_checkers import SERVICE_TYPE_CATALOG

    db = SessionLocal()
    try:
        existing_slugs = {
            row[0] for row in db.query(LakeServiceType.service_type).all()
        }
        added = 0
        for idx, (slug, meta) in enumerate(SERVICE_TYPE_CATALOG.items()):
            if slug in existing_slugs:
                continue
            db.add(LakeServiceType(
                service_type=slug,
                label=meta["label"],
                category=meta["category"],
                default_path=meta["default_path"],
                description=meta.get("description"),
                icon=None,            # frontend ICON_MAP fallback 사용
                is_builtin=True,
                enabled=True,
                sort_order=(idx + 1) * 10,  # 10, 20, ...
            ))
            added += 1
        if added:
            db.commit()
            _log.info("seeded %d builtin lake service types", added)
    finally:
        db.close()


# domain='pep' builtin 카테고리 4개 — key -> (label, icon, sort_order)
# icon 은 frontend CLUSTER_ICON_OPTIONS 화이트리스트(resolveClusterIcon 공용 리졸버)의
# lucide 컴포넌트 이름이어야 렌더된다 — 화이트리스트에 없는 이름은 텍스트로 취급됨에 주의.
_PEP_BUILTIN_CATEGORIES: dict[str, tuple[str, str, int]] = {
    "runtime":    ("Runtime",    "Cpu",      10),
    "catalog":    ("Catalog",    "Database", 20),
    "workflow":   ("Workflow",   "Workflow", 30),
    "jupyterlab": ("JupyterLab", "Code2",    40),
}

# 8 builtin LakeServiceType slug -> 소속 카테고리 key (기존 category 문자열과는 다른 재분류 —
# PEP 서비스 사이드바용 신규 의미: Runtime=실행 엔진, Catalog=테이블/메타 카탈로그, Workflow=오케스트레이션).
_PEP_TYPE_CATEGORY_KEY: dict[str, str] = {
    "spark": "runtime", "starrocks": "runtime", "trino": "runtime", "superset": "runtime",
    "iceberg": "catalog", "polaris": "catalog",
    "airflow": "workflow",
    "jupyterlab": "jupyterlab",
}


def _seed_default_service_categories():
    """PEP 서비스(domain='pep') builtin 카테고리 4개(Runtime/Catalog/Workflow/JupyterLab) 자동 등록 +
    기존 8 builtin LakeServiceType 의 category_id 백필. APP 서비스(domain='app')는 seed 없음 —
    운영자가 Settings 에서 직접 추가.

    idempotent — 이미 있는 카테고리 key 는 skip, category_id 가 이미 설정된 type 은 건드리지 않음
    (운영자가 재분류했을 수 있어 보존).
    """
    from app.models import ServiceCategory, LakeServiceType

    db = SessionLocal()
    try:
        existing = {
            row[0]: row[1] for row in
            db.query(ServiceCategory.key, ServiceCategory.id).filter(ServiceCategory.domain == "pep").all()
        }
        added = 0
        for key, (label, icon, sort_order) in _PEP_BUILTIN_CATEGORIES.items():
            if key in existing:
                continue
            row = ServiceCategory(
                domain="pep", key=key, label=label, icon=icon,
                is_builtin=True, enabled=True, sort_order=sort_order,
            )
            db.add(row)
            db.flush()
            existing[key] = row.id
            added += 1
        if added:
            db.commit()
            _log.info("seeded %d builtin pep service categories", added)

        backfilled = 0
        for slug, cat_key in _PEP_TYPE_CATEGORY_KEY.items():
            cat_id = existing.get(cat_key)
            if cat_id is None:
                continue
            type_row = db.query(LakeServiceType).filter(
                LakeServiceType.service_type == slug, LakeServiceType.category_id.is_(None),
            ).first()
            if type_row is None:
                continue
            type_row.category_id = cat_id
            type_row.domain = "pep"
            backfilled += 1
        if backfilled:
            db.commit()
            _log.info("backfilled category_id for %d builtin lake service types", backfilled)
    finally:
        db.close()


def _seed_default_lake_service_entries():
    """LAKE 8 OSS 서비스의 "기능 동작 특징" 가이드를 ServiceEntry kind=guide 로
    전역 등록. service+title 매칭으로 idempotent — 운영자가 수정하거나 삭제한
    경우는 영향 없음.

    PDCA: lake-service-knowledge-seed
    """
    from app.models.service_entry import ServiceEntry
    from app.data.lake_service_knowledge import LAKE_SERVICE_KNOWLEDGE_ENTRIES

    entries = LAKE_SERVICE_KNOWLEDGE_ENTRIES

    db = SessionLocal()
    try:
        # 같은 (service, title) 기존 행 조회
        existing_keys = {
            (row.service, row.title)
            for row in db.query(ServiceEntry)
            .filter(ServiceEntry.service.in_([e["service"] for e in entries]))
            .filter(ServiceEntry.title.in_([e["title"] for e in entries]))
            .all()
        }
        added = 0
        for e in entries:
            key = (e["service"], e["title"])
            if key in existing_keys:
                continue
            db.add(ServiceEntry(
                service=e["service"],
                cluster_id=None,             # 전역
                kind="guide",
                title=e["title"],
                content=e["content"],
                severity=None,
                pinned=True,                  # ServiceHub 카드 상단
                tags=["lake", "feature", "overview"],
                author="system",
                meta={"seeded_by": "lake-service-knowledge-seed", "category": e["category"]},
            ))
            added += 1
        if added:
            db.commit()
            _log.info("seeded %d lake service knowledge entries", added)
    finally:
        db.close()


def _seed_assignee_users():
    """이미 등록된 담당자(assignees)에 대해 operator 로그인 계정을 보강.

    이 기능 도입 전에 등록된 담당자도 부팅 시 1회 계정을 부여받도록 한다. 멱등 —
    이미 같은 사번(=username) 의 User 가 있으면 건드리지 않는다. 사번이 없는
    담당자는 건너뛴다.
    """
    from app.models.app_setting import AppSetting
    from app.routers.ui_settings import ASSIGNEES_KEY, _normalize_assignee
    from app.services.assignee_accounts import sync_assignee_accounts

    db = SessionLocal()
    try:
        setting = db.query(AppSetting).filter(AppSetting.key == ASSIGNEES_KEY).first()
        if not setting or not isinstance(setting.value, list):
            return
        normalized = [n for a in setting.value if (n := _normalize_assignee(a)) is not None]
        result = sync_assignee_accounts(db, normalized)
        if result["created"]:
            _log.info("seeded %d assignee operator accounts", len(result["created"]))
    finally:
        db.close()


def _seed_check_matrix_items():
    """점검 매트릭스 기본 행 시드 — 테이블이 비어있을 때만(사용자 삭제/추가는 보존)."""
    from app.services import check_matrix_service as cms

    db = SessionLocal()
    try:
        added = cms.seed_default_items(db)
        if added:
            _log.info("seeded %d check matrix items", added)
    finally:
        db.close()


def _seed_check_matrix_schedules():
    """시드된 deep_check 행 중 REGISTRY.default_enabled 인 것만 클러스터별 기본 cron 부여."""
    from app.services import check_matrix_service as cms

    db = SessionLocal()
    try:
        added = cms.seed_default_schedules(db)
        if added:
            _log.info("seeded %d check matrix schedules", added)
    finally:
        db.close()


def _seed_initial_admin():
    """Create the bootstrap admin if no users exist yet. Idempotent."""
    db = SessionLocal()
    try:
        if db.query(User).count() > 0:
            return
        admin = User(
            username=settings.initial_admin_username,
            hashed_password=hash_password(settings.initial_admin_password),
            role="admin",
            display_name="Administrator",
        )
        db.add(admin)
        db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: DB 테이블 생성 + 마이그레이션 + seed.
    # 각 단계는 개별 try/except 로 격리해 한 군데 실패가 backend 전체를 막아
    # CrashLoopBackOff 가 되는 일을 방지한다. 실패는 로그로 남기되 부팅은 계속.
    _startup_log = logging.getLogger("k8s_monitor.startup")
    try:
        _ensure_pgvector_extension()
    except Exception as e:  # noqa: BLE001
        _startup_log.exception("pgvector extension step failed — continuing: %s", e)
    try:
        Base.metadata.create_all(bind=engine)
    except Exception as e:  # noqa: BLE001
        _startup_log.exception("create_all failed — continuing: %s", e)
    for step_name, step in [
        ("migrations", _run_migrations),
        ("seed_metric_cards", _seed_default_metric_cards),
        ("seed_cluster_items", _seed_cluster_items),
        ("seed_trend_sources", _seed_default_trend_sources),
        ("seed_playbooks", _seed_default_playbooks),
        ("seed_deep_check_definitions", _seed_default_deep_check_definitions),
        ("seed_isilon_commands", _seed_default_isilon_commands),
        ("seed_check_matrix_items", _seed_check_matrix_items),
        ("seed_check_matrix_schedules", _seed_check_matrix_schedules),
        ("seed_metric_checklist_items", _seed_default_metric_checklist_items),
        ("seed_lake_service_types", _seed_default_lake_service_types),
        ("seed_service_categories", _seed_default_service_categories),
        ("seed_lake_service_entries", _seed_default_lake_service_entries),
        ("seed_initial_admin", _seed_initial_admin),
        ("seed_assignee_users", _seed_assignee_users),
    ]:
        try:
            step()
        except Exception as e:  # noqa: BLE001
            _startup_log.exception("startup step '%s' failed — continuing: %s", step_name, e)
    yield
    # Shutdown: 필요한 정리 작업


# FastAPI 앱 생성
app = FastAPI(
    title=settings.app_name,
    description="DevOps K8s Daily Monitoring Dashboard API",
    version="1.5.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# CORS 설정 - Kubernetes 환경 지원
allowed_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://frontend",
    "http://frontend:80",
]

# 환경변수로 추가 origin 설정 가능
extra_origins = os.getenv("ALLOWED_ORIGINS", "")
if extra_origins:
    allowed_origins.extend([o.strip() for o in extra_origins.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Public routers (no auth) — login + liveness/readiness probes.
app.include_router(auth_router, prefix="/api/v1")
app.include_router(health_router, prefix="/api/v1")
# Super pod ingest 는 bearer 토큰만 자체 검증 — JWT 의존성 없음.
app.include_router(deep_check_ingest_router, prefix="/api/v1")

# Protected routers — every endpoint below requires a valid JWT.
_auth = [Depends(get_current_user)]
app.include_router(clusters_router, prefix="/api/v1", dependencies=_auth)
app.include_router(history_router, prefix="/api/v1", dependencies=_auth)
app.include_router(daily_check_router, prefix="/api/v1", dependencies=_auth)
app.include_router(check_matrix_router, prefix="/api/v1", dependencies=_auth)
app.include_router(playbooks_router, prefix="/api/v1", dependencies=_auth)
app.include_router(agent_router, prefix="/api/v1", dependencies=_auth)
app.include_router(promql_router, prefix="/api/v1", dependencies=_auth)
app.include_router(work_items_router, prefix="/api/v1", dependencies=_auth)
app.include_router(jira_router, prefix="/api/v1", dependencies=_auth)
app.include_router(projects_router, prefix="/api/v1", dependencies=_auth)
app.include_router(sprints_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ui_settings_router, prefix="/api/v1", dependencies=_auth)
app.include_router(node_labels_router, prefix="/api/v1", dependencies=_auth)
app.include_router(node_images_router, prefix="/api/v1", dependencies=_auth)
app.include_router(workflows_router, prefix="/api/v1", dependencies=_auth)
app.include_router(work_guide_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ops_note_router, prefix="/api/v1", dependencies=_auth)
app.include_router(voc_router, prefix="/api/v1", dependencies=_auth)
app.include_router(reactions_router, prefix="/api/v1", dependencies=_auth)
app.include_router(mindmap_router, prefix="/api/v1", dependencies=_auth)
app.include_router(management_server_router, prefix="/api/v1", dependencies=_auth)
app.include_router(isilon_nfs_router, prefix="/api/v1", dependencies=_auth)
app.include_router(infra_nodes_router, prefix="/api/v1", dependencies=_auth)
app.include_router(topology_trace_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ontology_router, prefix="/api/v1", dependencies=_auth)
app.include_router(analyze_router, prefix="/api/v1", dependencies=_auth)
app.include_router(trends_router, prefix="/api/v1", dependencies=_auth)
app.include_router(versions_router, prefix="/api/v1", dependencies=_auth)
app.include_router(bulk_exec_router, prefix="/api/v1", dependencies=_auth)
app.include_router(etcdctl_router, prefix="/api/v1", dependencies=_auth)
app.include_router(cilium_trace_router, prefix="/api/v1", dependencies=_auth)
app.include_router(mc_client_router, prefix="/api/v1", dependencies=_auth)
app.include_router(node_server_specs_router, prefix="/api/v1", dependencies=_auth)
app.include_router(cluster_custom_fields_router, prefix="/api/v1", dependencies=_auth)
app.include_router(work_item_custom_fields_router, prefix="/api/v1", dependencies=_auth)
app.include_router(backup_router, prefix="/api/v1", dependencies=_auth)
app.include_router(service_entries_router, prefix="/api/v1", dependencies=_auth)
app.include_router(batch_jobs_router, prefix="/api/v1", dependencies=_auth)
app.include_router(commands_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ansible_files_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ansible_inventories_router, prefix="/api/v1", dependencies=_auth)
# Deep check 결과 조회/관리/이력 — JWT 보호.
app.include_router(deep_check_router, prefix="/api/v1", dependencies=_auth)
app.include_router(deep_check_definitions_router, prefix="/api/v1", dependencies=_auth)
app.include_router(notifications_router, prefix="/api/v1", dependencies=_auth)
app.include_router(audit_logs_router, prefix="/api/v1", dependencies=_auth)
# lake-service-monitoring (신규 PDCA) — LAKE OSS 서비스 모니터링.
app.include_router(lake_services_router, prefix="/api/v1", dependencies=_auth)
# pod-bottleneck-analyzer (신규 PDCA) — pod-to-pod 병목 진단 (4-Probe Strategy).
app.include_router(bottleneck_router, prefix="/api/v1", dependencies=_auth)
# lake-service-type-management (신규 PDCA) — DB-driven service_type 카탈로그.
app.include_router(lake_service_types_router, prefix="/api/v1", dependencies=_auth)
# PEP/APP 서비스 상위 카테고리 카탈로그 (Runtime/Catalog/Workflow/JupyterLab 등, Settings 관리).
app.include_router(service_categories_router, prefix="/api/v1", dependencies=_auth)
# ops-checks (운영 점검 통합 콘솔) — 여러 점검 소스를 골라 일괄/개별 실행.
app.include_router(ops_check_router, prefix="/api/v1", dependencies=_auth)
# k8s-resources (Lens 식 상세 관리) — 리소스 탐색 + 쓰기 액션(require_operator) + RBAC/CRD.
app.include_router(k8s_resources_router, prefix="/api/v1", dependencies=_auth)
# k8s-allocation (자원 관리) — 노드/NS/워크로드/파드 단위 request vs 사용량(slack) 가시화(읽기 전용).
app.include_router(k8s_allocation_router, prefix="/api/v1", dependencies=_auth)
# cluster-trends — per-node 메트릭 추이(Prometheus range query, 노드 명시선택+상한).
app.include_router(cluster_trends_router, prefix="/api/v1", dependencies=_auth)
# helm 릴리스 뷰어(읽기 전용).
app.include_router(k8s_helm_router, prefix="/api/v1", dependencies=_auth)
# pod exec 터미널(WebSocket) — 전역 _auth 미적용, 핸들러 내부에서 토큰 직접 검증.
app.include_router(k8s_exec_router, prefix="/api/v1")
# metric-trend — 일일점검 리뷰: 리소스 수 추세 체크리스트(자동/수동 스냅샷 + 체크 + 항목 CRUD).
app.include_router(metric_trend_router, prefix="/api/v1", dependencies=_auth)
# service-topology — 서비스 동작 플로우 가시화(자동 그래프 + 수동 연계 + 실트래픽).
app.include_router(service_topology_router, prefix="/api/v1", dependencies=_auth)
app.include_router(cluster_items_router, prefix="/api/v1", dependencies=_auth)
# terminal-appearance — 모든 로그 화면(LogViewer) 공유 글꼴/색상 테마(개인화 + admin 공용 배포).
app.include_router(terminal_appearance_router, prefix="/api/v1", dependencies=_auth)
# k8s_events — kubewatch 웹훅 수신(토큰 인증) + 이벤트 조회(JWT)
app.include_router(k8s_events_ingest_router, prefix="/api/v1")
app.include_router(k8s_events_router, prefix="/api/v1", dependencies=_auth)
app.include_router(release_notes_router, prefix="/api/v1", dependencies=_auth)


@app.get("/")
def root():
    return {
        "name": settings.app_name,
        "version": "1.5.0",
        "status": "running"
    }


@app.get("/health")
def health_check():
    """Kubernetes liveness/readiness probe endpoint"""
    return {"status": "healthy"}


@app.get("/health/live")
def liveness_check():
    """Kubernetes liveness probe - checks if app is running"""
    return {"status": "alive"}


@app.get("/health/ready")
def readiness_check():
    """Kubernetes readiness probe - checks if app is ready to serve traffic"""
    try:
        # Check database connection
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        return {"status": "ready", "database": "connected"}
    except Exception as e:
        return {"status": "not_ready", "database": "disconnected", "error": str(e)}
