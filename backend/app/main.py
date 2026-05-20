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
    openclaw_router,
    playbooks_router,
    promql_router,
    work_items_router,
    ui_settings_router,
    workflows_router,
    work_guide_router,
    ops_note_router,
    mindmap_router,
    management_server_router,
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
)
from app.auth.deps import get_current_user
from app.auth.security import hash_password
from app.models.user import User


_log = logging.getLogger("k8s_monitor.migration")


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
        _safe_exec(
            "ALTER TABLE playbooks ADD CONSTRAINT playbooks_playbook_file_id_fkey "
            "FOREIGN KEY (playbook_file_id) REFERENCES ansible_playbook_files(id)",
            label="playbooks.playbook_file_id FK",
        )
        _safe_exec(
            "ALTER TABLE playbooks ADD CONSTRAINT playbooks_inventory_id_fkey "
            "FOREIGN KEY (inventory_id) REFERENCES ansible_inventories(id)",
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
        ]
        for col_name, col_type in new_cluster_cols:
            _safe_add_column("clusters", col_name, col_type)

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
        _safe_exec(
            "ALTER TABLE tasks ADD CONSTRAINT tasks_parent_id_fkey "
            "FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE",
            label="tasks.parent_id FK",
        )
        _safe_exec(
            "ALTER TABLE tasks ADD CONSTRAINT tasks_issue_id_fkey "
            "FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL",
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
        _safe_exec(
            "ALTER TABLE work_items ADD CONSTRAINT work_items_related_work_item_id_fkey "
            "FOREIGN KEY (related_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL",
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
        _safe_exec(
            "ALTER TABLE check_logs ADD CONSTRAINT check_logs_addon_id_fkey "
            "FOREIGN KEY (addon_id) REFERENCES addons(id)",
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
        _safe_create_index("ix_deep_check_results_cluster", "deep_check_results", "(cluster_id)")
        _safe_create_index("ix_deep_check_results_daily_log", "deep_check_results", "(daily_check_log_id)")
        _safe_create_index("ix_deep_check_results_checked_at", "deep_check_results", "(checked_at DESC)")

    # batch_jobs: 저장형 자격증명 컬럼 추가 (스케줄 실행용)
    if "batch_jobs" in inspector.get_table_names():
        _safe_add_column("batch_jobs", "encrypted_password", "TEXT")
        _safe_add_column("batch_jobs", "encrypted_private_key", "TEXT")

    # users: 강제 비밀번호 변경 플래그 + 레거시 role 정규화
    if "users" in inspector.get_table_names():
        _safe_add_column("users", "must_change_password", "BOOLEAN NOT NULL DEFAULT FALSE")
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
                enabled=True,
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
        Base.metadata.create_all(bind=engine)
    except Exception as e:  # noqa: BLE001
        _startup_log.exception("create_all failed — continuing: %s", e)
    for step_name, step in [
        ("migrations", _run_migrations),
        ("seed_metric_cards", _seed_default_metric_cards),
        ("seed_trend_sources", _seed_default_trend_sources),
        ("seed_playbooks", _seed_default_playbooks),
        ("seed_deep_check_definitions", _seed_default_deep_check_definitions),
        ("seed_initial_admin", _seed_initial_admin),
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
    version="0.1.0",
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
app.include_router(playbooks_router, prefix="/api/v1", dependencies=_auth)
app.include_router(agent_router, prefix="/api/v1", dependencies=_auth)
app.include_router(promql_router, prefix="/api/v1", dependencies=_auth)
app.include_router(openclaw_router, prefix="/api/v1", dependencies=_auth)
app.include_router(work_items_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ui_settings_router, prefix="/api/v1", dependencies=_auth)
app.include_router(node_labels_router, prefix="/api/v1", dependencies=_auth)
app.include_router(node_images_router, prefix="/api/v1", dependencies=_auth)
app.include_router(workflows_router, prefix="/api/v1", dependencies=_auth)
app.include_router(work_guide_router, prefix="/api/v1", dependencies=_auth)
app.include_router(ops_note_router, prefix="/api/v1", dependencies=_auth)
app.include_router(mindmap_router, prefix="/api/v1", dependencies=_auth)
app.include_router(management_server_router, prefix="/api/v1", dependencies=_auth)
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


@app.get("/")
def root():
    return {
        "name": settings.app_name,
        "version": "0.1.0",
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
