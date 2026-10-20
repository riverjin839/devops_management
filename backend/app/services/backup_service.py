"""데이터 백업 / 복구 서비스.

JSON 기반 애플리케이션-레벨 백업. pg_dump 이 아닌 SQLAlchemy 모델 순회로
포팅 가능한 구조 (PostgreSQL 버전 무관, 다른 환경 이식 가능).

- 모든 테이블을 Base.metadata.sorted_tables 순서로 순회 → FK 의존성 자동 보장.
- UUID / datetime / Enum / bytes / Decimal 은 JSON 친화 형식으로 직렬화.
- 민감 필드 (kubeconfig_content, SSH 비밀번호 없음 — 이미 저장 안 함) 는
  옵션으로 제외 가능.
- 대용량 로그성 테이블 (check_logs, daily_check_logs, cluster_config_snapshots,
  trend_*, ontology_events, topology_audit_logs) 은 옵션으로 포함/제외.

## 부팅/스키마 드리프트 안전성 (Fault tolerance)
prod DB 가 model 보다 컬럼이 적거나(누락 마이그레이션) 추가 컬럼이 있을 수 있다.
모든 테이블 순회는 **per-table 단위로 try/except** 격리해서 한 테이블이 실패해도
나머지는 정상 export/import 된다. 실패 테이블은 envelope.errors 와 응답의
``errors`` 배열에 사유와 함께 기록되어 사용자가 알 수 있도록 한다.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import uuid
from datetime import date, datetime, time, timezone
from decimal import Decimal
from enum import Enum
from typing import IO, Any, Iterator, Optional

from sqlalchemy import Table, inspect, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.database import Base
from app.services.backup_reader import BackupIndex, index_backup, iter_table_rows

_log = logging.getLogger("k8s_monitor.backup")

BACKUP_VERSION = "1.0"

# 대용량/로그성 — 옵션으로 제외 가능
LOG_TABLES: frozenset[str] = frozenset({
    "check_logs",
    "daily_check_logs",
    "cluster_config_snapshots",
    "topology_audit_logs",
    "ontology_events",
    "trend_items",
    "trend_digests",
    "audit_logs",
    "ops_check_runs",
    "ops_check_run_items",
    "os_param_changes",
    "resource_count_snapshots",
    "metric_check_states",
    "deep_check_results",
    "check_matrix_result_logs",
    "check_matrix_runs",
    # 알람 인박스 / 관측 스냅샷 — 대용량 로그성. 설정(observability_modules /
    # observability_metrics / alert_notify_rules)은 로그가 아니므로 제외하지 않는다.
    "alert_events",
    "observability_snapshots",
    "k8s_events",
    # AI 자동 분석 이력 — 알람과 함께 무한 증가하는 로그성 테이블.
    "incident_analyses",
    # AI 챗봇 대화 이력 — 로그성.
    "agent_conversations",
    "agent_messages",
    # k8s 자원 효율화 — 샘플 시계열/실행 로그(대용량).
    "k8s_ns_samples",
    "k8s_workload_samples",
    "k8s_efficiency_runs",
    # 서버 오류 기록(요청 ID 추적) — 로그성.
    "system_error_logs",
})

# 민감 컬럼을 마스킹할 때 쓰는 센티널. ``None`` 을 쓰면 "값이 원래 없었다"와
# "export 시 마스킹됐다"를 구분할 수 없어, 마스킹된 백업을 merge import 하면
# 실제 kubeconfig/비밀번호/토큰이 NULL 로 덮어써진다(데이터 유실). import 쪽에서
# 이 센티널을 만나면 해당 컬럼을 아예 갱신 대상에서 제외해 기존 값을 보존한다.
MASKED_SENTINEL = "__pep_backup_masked_v1__"

# 민감 정보 포함 — 옵션으로 마스킹
SENSITIVE_COLUMNS: dict[str, list[str]] = {
    "clusters": ["kubeconfig_content", "kubeconfig_path"],
    # bcrypt 해시지만 외부 유출 시 오프라인 브루트포스 가능성이 있어 기본 마스킹.
    "users": ["hashed_password"],
    # Jira PAT/세션쿠키 + 저장된 SSO 로그인 정보 — 암호문이지만 export 기본 마스킹
    # (SECRET_KEY 유출 시 복호 방지).
    "user_jira_credentials": ["token_encrypted", "sso_login_encrypted", "confluence_cookie_encrypted", "servicenow_cookie_encrypted"],
    # Isilon SSH 자격증명 — 암호문이지만 export 기본 마스킹.
    "isilon_servers": ["encrypted_password", "encrypted_private_key"],
    # 사내 LLM 서비스 API 키 — 암호문이지만 export 기본 마스킹 (SECRET_KEY 유출 대비).
    "llm_credentials": ["api_key"],
}

# JSON 컬럼 안의 민감 키 — 컬럼 전체가 아니라 그 키만 마스킹한다(설정 나머지는 백업돼야 한다).
# import 시 센티널 키는 기존 행 값을 유지하고, 기존 행이 없으면 비운다.
SENSITIVE_JSON_KEYS: dict[str, dict[str, list[str]]] = {
    # 사내 SSO(OIDC) client secret 암호문 — AppSetting ``auth.oidc``.
    "app_settings": {"value": ["client_secret_encrypted"]},
}


def _sort_key_for_table(t: Table) -> tuple[int, str]:
    """sorted_tables 보조 키 — FK depth + name. sorted_tables 가 기본이라 그대로 사용."""
    return (len(t.foreign_keys), t.name)


def _serialize_value(v: Any) -> Any:
    """JSON 직렬화 가능 값으로 변환."""
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, time):
        return v.isoformat()
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, Enum):
        return v.value
    if isinstance(v, bytes):
        return {"__bytes__": base64.b64encode(v).decode("ascii")}
    if isinstance(v, (list, tuple)):
        return [_serialize_value(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _serialize_value(val) for k, val in v.items()}
    # fallback
    return str(v)


def _deserialize_value(v: Any, col_type_name: str) -> Any:
    if v is None:
        return None
    if isinstance(v, dict) and "__bytes__" in v:
        return base64.b64decode(v["__bytes__"])
    if isinstance(v, str):
        t = col_type_name.upper()
        try:
            if t in ("UUID",):
                return uuid.UUID(v)
            if t in ("DATETIME", "TIMESTAMP"):
                return datetime.fromisoformat(v.replace("Z", "+00:00"))
            if t == "DATE":
                return date.fromisoformat(v)
            if t == "TIME":
                return time.fromisoformat(v)
        except (ValueError, TypeError):
            pass
    return v


def _mask_sensitive(table_name: str, row: dict, include_sensitive: bool) -> dict:
    if include_sensitive:
        return row
    cols = SENSITIVE_COLUMNS.get(table_name, [])
    json_keys = SENSITIVE_JSON_KEYS.get(table_name, {})
    if not cols and not json_keys:
        return row
    out = dict(row)
    for c in cols:
        if c in out and out[c] is not None:
            out[c] = MASKED_SENTINEL
    for c, keys in json_keys.items():
        v = out.get(c)
        if isinstance(v, dict) and any(v.get(k) is not None for k in keys):
            out[c] = {k: (MASKED_SENTINEL if k in keys and val is not None else val) for k, val in v.items()}
    return out


def _restore_masked_json(table_name: str, values: dict, existing: Any) -> dict:
    """JSON 컬럼의 마스킹된 키를 기존 행 값(없으면 None)으로 되돌린다."""
    for c, keys in SENSITIVE_JSON_KEYS.get(table_name, {}).items():
        v = values.get(c)
        if not isinstance(v, dict) or not any(v.get(k) == MASKED_SENTINEL for k in keys):
            continue
        prev = getattr(existing, c, None) if existing is not None else None
        prev = prev if isinstance(prev, dict) else {}
        values[c] = {k: (prev.get(k) if val == MASKED_SENTINEL and k in keys else val) for k, val in v.items()}
    return values


def _filter_tables(include_logs: bool) -> list[Table]:
    all_tables = list(Base.metadata.sorted_tables)
    if include_logs:
        return all_tables
    return [t for t in all_tables if t.name not in LOG_TABLES]


# ── Export ───────────────────────────────────────────────────────────────

def _safe_select_rows(db: Session, t: Table) -> tuple[list[dict] | None, str | None]:
    """단일 테이블 SELECT * — 실패 시 (None, error_str). 트랜잭션을 오염시키지 않도록
    실패 후 rollback 까지 처리. 한 테이블 실패가 다음 테이블로 전파되지 않게 한다.
    """
    try:
        rows = db.execute(t.select()).mappings().all()
        return list(rows), None
    except Exception as e:  # noqa: BLE001
        # PostgreSQL 은 트랜잭션이 abort 되면 후속 query 모두 InFailedSqlTransaction 으로
        # 막히므로 rollback 으로 트랜잭션 초기화.
        try:
            db.rollback()
        except Exception:
            pass
        msg = f"{type(e).__name__}: {str(e)[:300]}"
        _log.warning("backup: SELECT %s failed — %s", t.name, msg)
        return None, msg


def export_all(
    db: Session,
    *,
    include_logs: bool = False,
    include_sensitive: bool = False,
) -> dict:
    """현재 DB 를 JSON envelope 으로 export. **per-table fault-tolerant** —
    한 테이블이 실패해도 다른 테이블은 정상 export 되며 ``errors`` 필드에 사유 기록.
    """
    tables = _filter_tables(include_logs)
    data: dict[str, list[dict]] = {}
    counts: dict[str, int] = {}
    errors: dict[str, str] = {}
    skipped: list[str] = []

    for t in tables:
        rows, err = _safe_select_rows(db, t)
        if err is not None:
            errors[t.name] = err
            skipped.append(t.name)
            data[t.name] = []
            counts[t.name] = 0
            continue
        try:
            serialized: list[dict] = []
            for r in rows or []:
                row_dict = {k: _serialize_value(v) for k, v in dict(r).items()}
                serialized.append(_mask_sensitive(t.name, row_dict, include_sensitive))
            data[t.name] = serialized
            counts[t.name] = len(serialized)
        except Exception as e:  # noqa: BLE001
            msg = f"serialize {type(e).__name__}: {str(e)[:200]}"
            _log.exception("backup: serialize %s failed", t.name)
            errors[t.name] = msg
            skipped.append(t.name)
            data[t.name] = []
            counts[t.name] = 0

    return {
        "version": BACKUP_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "options": {
            "include_logs": include_logs,
            "include_sensitive": include_sensitive,
        },
        "counts": counts,
        "tables": data,
        # 신규 필드 — 일부 테이블이 실패했어도 export 자체는 성공.
        # 사용자가 응답에서 어떤 테이블이 빠졌는지 확인 가능.
        "errors": errors,
        "skipped_tables": skipped,
    }


def export_to_bytes(db: Session, **kwargs) -> tuple[bytes, str]:
    """export_all 결과를 JSON bytes + 파일명 으로. **소규모·테스트 전용** — 전체 DB 를 메모리에
    올리므로 운영 엔드포인트는 `iter_export_json()` 스트리밍을 쓴다."""
    envelope = export_all(db, **kwargs)
    raw = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    return raw, export_filename()


def export_filename() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"k8s-monitor-backup-{ts}.json"


# 스트리밍 export — 서버측 커서로 테이블당 이 행 수만큼씩 읽고, 출력은 이 크기쯤 모아 흘려보낸다.
# 메모리 상한 ≈ (chunk 행 수 × 행 크기) + flush 버퍼. 전체 DB 크기와 무관하다.
EXPORT_YIELD_PER = 500
EXPORT_FLUSH_BYTES = 256 * 1024


def iter_export_json(
    db: Session,
    *,
    include_logs: bool = False,
    include_sensitive: bool = False,
    summary: dict | None = None,
):
    """`export_all()` 과 같은 envelope 을 **조각(bytes)으로 흘려보내는** 생성기.

    예전 export 는 모든 테이블 행 → 직렬화 dict → JSON 문자열(indent 2) → bytes 를 한 워커 메모리에
    동시에 들고 있어, 운영 DB 에서는 수백 MB~GB 가 돼 backend 파드가 OOMKilled 됐다. 여기서는
    테이블마다 서버측 커서(`stream_results` + `yield_per`)로 조금씩 읽어 행 단위로 쓰고 바로 내보낸다.

    - 파일 모양은 그대로다(복구 `parse_backup` 이 그대로 읽는다). 단 ``counts``·``errors``·
      ``skipped_tables`` 는 다 흘려보낸 뒤에야 알 수 있어 **파일 끝**에 온다(JSON 키 순서는 무의미).
    - per-table fault-tolerant 유지: 한 테이블이 실패하면 rollback 하고 다음 테이블로 간다. 행을
      일부 내보낸 뒤 실패하면 그 테이블 배열을 닫고 ``errors`` 에 "partial" 로 남긴다(JSON 은 항상 유효).
    - ``summary`` 를 넘기면 끝난 뒤 counts/errors/bytes 를 채운다(감사 로그용).
    """
    tables = _filter_tables(include_logs)
    counts: dict[str, int] = {}
    errors: dict[str, str] = {}
    skipped: list[str] = []
    total = 0
    buf: list[str] = []
    buf_len = 0

    def _emit(piece: str):
        nonlocal buf_len
        buf.append(piece)
        buf_len += len(piece)

    def _flush() -> bytes:
        nonlocal buf_len
        out = "".join(buf).encode("utf-8")
        buf.clear()
        buf_len = 0
        return out

    head = {
        "version": BACKUP_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "options": {"include_logs": include_logs, "include_sensitive": include_sensitive},
    }
    _emit(json.dumps(head, ensure_ascii=False)[:-1] + ', "tables": {')

    for ti, t in enumerate(tables):
        _emit(("," if ti else "") + f"\n{json.dumps(t.name)}: [")
        n = 0
        try:
            result = db.execute(t.select().execution_options(stream_results=True, yield_per=EXPORT_YIELD_PER))
            for r in result.mappings():
                row_dict = {k: _serialize_value(v) for k, v in dict(r).items()}
                row_dict = _mask_sensitive(t.name, row_dict, include_sensitive)
                _emit(("," if n else "") + "\n" + json.dumps(row_dict, ensure_ascii=False))
                n += 1
                if buf_len >= EXPORT_FLUSH_BYTES:
                    chunk = _flush()
                    total += len(chunk)
                    yield chunk
        except Exception as e:  # noqa: BLE001 — 한 테이블 실패가 전체 export 를 죽이지 않게
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
            msg = f"{type(e).__name__}: {str(e)[:300]}"
            if n:
                msg = f"partial ({n} rows written) — {msg}"
            _log.warning("backup: export %s failed — %s", t.name, msg)
            errors[t.name] = msg
            skipped.append(t.name)
        _emit("]")
        counts[t.name] = n

    tail = {"counts": counts, "errors": errors, "skipped_tables": skipped}
    _emit("\n}, " + json.dumps(tail, ensure_ascii=False)[1:] + "\n")
    chunk = _flush()
    total += len(chunk)
    if summary is not None:
        summary.update({"counts": counts, "errors": errors, "skipped_tables": skipped, "bytes": total})
    yield chunk


# ── Import (preview + apply) ─────────────────────────────────────────────

def parse_backup(raw: bytes) -> dict:
    try:
        env = json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise ValueError(f"백업 파일 JSON 파싱 실패: {e}") from e
    if not isinstance(env, dict) or "tables" not in env or "version" not in env:
        raise ValueError("유효한 백업 파일이 아닙니다 (version + tables 필수).")
    return env


def _row_pk_values(table: Table, row: dict) -> tuple:
    """백업 JSON(문자열 PK)을 DB 네이티브 타입으로 역직렬화해 비교 가능하게 한다.

    비교 대상인 ``existing_pks`` (DB 에서 직접 SELECT 한 값)는 UUID 등 네이티브
    파이썬 타입인데, 여기서 역직렬화 없이 문자열 그대로 반환하면 UUID PK 테이블
    전체가 항상 "일치 없음"으로 판정돼 diff 미리보기가 항상 전부 insert/전체
    삭제후보로 잘못 표시된다.
    """
    return tuple(
        _deserialize_value(row.get(pk.name), str(pk.type))
        for pk in table.primary_key.columns
    )


class BackupSource:
    """가져오기 입력 — 테이블별 행을 하나씩 내준다. 파일 전체를 객체로 만들지 않기 위한 추상화.

    - ``EnvelopeSource``: 이미 메모리에 있는 dict(테스트·소규모).
    - ``FileBackupSource``: 디스크 임시 파일 + ``backup_reader.index_backup`` 위치 색인(라우터 경로).

    레거시 ``issues``/``tasks`` 행은 ``rows("work_items")`` 가 work_items 모양으로 바꿔 이어서 내준다.
    """

    meta: dict

    def _raw_rows(self, name: str) -> Iterator[Any]:  # pragma: no cover — 하위 클래스 구현
        raise NotImplementedError

    def rows(self, name: str) -> Iterator[dict]:
        for r in self._raw_rows(name):
            if isinstance(r, dict):
                yield r
        if name == "work_items":
            for r in self._raw_rows("issues"):
                if isinstance(r, dict):
                    yield _legacy_issue_to_work_item(r)
            for r in self._raw_rows("tasks"):
                if isinstance(r, dict):
                    yield _legacy_task_to_work_item(r)


class EnvelopeSource(BackupSource):
    def __init__(self, envelope: dict):
        self.meta = {k: v for k, v in envelope.items() if k != "tables"}
        tables = envelope.get("tables")
        self._tables = tables if isinstance(tables, dict) else {}

    def _raw_rows(self, name: str) -> Iterator[Any]:
        yield from self._tables.get(name) or []


class FileBackupSource(BackupSource):
    def __init__(self, fobj: IO[bytes], index: BackupIndex):
        self.meta = index.meta
        self._f = fobj
        self._index = index

    def _raw_rows(self, name: str) -> Iterator[Any]:
        span = self._index.tables.get(name)
        if span is not None and span.count:
            yield from iter_table_rows(self._f, span)


def open_backup_file(fobj: IO[bytes]) -> FileBackupSource:
    """업로드 임시 파일을 검증·색인한다(형식 오류는 ``ValueError``). 파일 내용을 메모리에 올리지 않는다."""
    return FileBackupSource(fobj, index_backup(fobj))


def _as_source(src: BackupSource | dict) -> BackupSource:
    return src if isinstance(src, BackupSource) else EnvelopeSource(src)


def _safe_select_pks(db: Session, t: Table) -> tuple[set[tuple], str | None]:
    """기존 PK 집합만 서버측 커서로 읽는다 — 예전엔 미리보기가 테이블 전체 행(모든 컬럼)을 올렸다."""
    pk_cols = list(t.primary_key.columns)
    out: set[tuple] = set()
    if not pk_cols:
        return out, None
    try:
        result = db.execute(
            select(*pk_cols).execution_options(stream_results=True, yield_per=EXPORT_YIELD_PER)
        )
        for r in result:
            out.add(tuple(r))
        return out, None
    except Exception as e:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:
            pass
        msg = f"{type(e).__name__}: {str(e)[:300]}"
        _log.warning("backup: SELECT pk %s failed — %s", t.name, msg)
        return set(), msg


class _ErrorLog(list):
    """행 단위 오류 기록 — 수만 행이 실패해도 응답이 폭주하지 않게 앞쪽 ``limit`` 건만 남기고 개수만 센다."""

    def __init__(self, limit: int):
        super().__init__()
        self._limit = limit
        self.dropped = 0

    def add(self, msg: str) -> None:
        if len(self) < self._limit:
            self.append(msg)
        else:
            self.dropped += 1

    def finish(self) -> list[str]:
        out = list(self)
        if self.dropped:
            out.append(f"… 외 {self.dropped}건 생략 (앞쪽 {self._limit}건만 표시)")
        return out


IMPORT_ERRORS_LIMIT = 500


def compute_diff(db: Session, source: BackupSource | dict, *, include_logs: bool) -> dict:
    """import 없이 diff 만 계산 — UI 미리보기용. **per-table fault-tolerant** —
    한 테이블 SELECT 실패는 해당 테이블만 0/0 으로 표시, 다른 테이블 진행.

    백업 행은 하나씩 흘려 읽고 PK 만 모은다(행 전체를 쌓지 않는다).
    """
    src = _as_source(source)
    tables = _filter_tables(include_logs)
    report: list[dict] = []
    errors: list[str] = []
    total_in = 0
    total_ex = 0

    for t in tables:
        existing_pks, err = _safe_select_pks(db, t)
        if err is not None:
            errors.append(f"{t.name}: {err}")
        total_ex += len(existing_pks)

        in_pks: set[tuple] = set()
        incoming = 0
        inserts = 0
        for r in src.rows(t.name):
            incoming += 1
            pk = _row_pk_values(t, r)
            in_pks.add(pk)
            if pk not in existing_pks:
                inserts += 1
        total_in += incoming
        updates = len(in_pks & existing_pks)
        unchanged = 0   # 세부 비교까지 하면 비쌈 — updates 에 포함
        delete_candidates = len(existing_pks - in_pks)

        report.append({
            "name": t.name,
            "incoming": incoming,
            "existing": len(existing_pks),
            "insert_count": inserts,
            "update_count": updates,
            "unchanged_count": unchanged,
            "delete_candidates": delete_candidates,
        })

    return {
        "version": src.meta.get("version"),
        "created_at": src.meta.get("created_at"),
        "backup_options": src.meta.get("options", {}),
        "total_incoming": total_in,
        "total_existing": total_ex,
        "tables": report,
        # 미리보기 단계에서 어떤 테이블이 읽을 수 없었는지 노출.
        "errors": errors,
    }


# 레거시 백업 호환 — 통합 이전(`issues` / `tasks` 테이블) 시점의 백업 행을 `work_items` 행으로 바꾼다.
# 매핑 규칙은 main.py 의 backfill SQL 과 동일:
# - issues: type='issue', issue_area→category, issue_content→content,
#   action_content→resolution, occurred_at→started_at, resolved_at→closed_at,
#   kanban_status='done' if resolved_at else 'todo', priority='medium' 기본.
# - tasks: type='task', task_category→category, task_content→content,
#   result_content→resolution, scheduled_at→started_at, completed_at→closed_at,
#   issue_id→related_work_item_id.

def _legacy_issue_to_work_item(row: dict) -> dict:
    resolved = row.get("resolved_at")
    return {
        "id": row.get("id"),
        "type": "issue",
        "assignee": row.get("assignee"),
        "primary_assignee": row.get("primary_assignee") or row.get("assignee"),
        "secondary_assignee": row.get("secondary_assignee"),
        "cluster_id": row.get("cluster_id"),
        "cluster_name": row.get("cluster_name"),
        "category": row.get("issue_area"),
        "content": row.get("issue_content"),
        "resolution": row.get("action_content"),
        "detail_content": row.get("detail_content"),
        "started_at": row.get("occurred_at"),
        "closed_at": resolved,
        "remarks": row.get("remarks"),
        "service": row.get("service"),
        "confluence_url": row.get("confluence_url"),
        "priority": "medium",
        "kanban_status": "done" if resolved else "todo",
        "module": None,
        "type_label": None,
        "effort_hours": None,
        "done_condition": None,
        "parent_id": None,
        "related_work_item_id": None,
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _legacy_task_to_work_item(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "type": "task",
        "assignee": row.get("assignee"),
        "primary_assignee": row.get("primary_assignee") or row.get("assignee"),
        "secondary_assignee": row.get("secondary_assignee"),
        "cluster_id": row.get("cluster_id"),
        "cluster_name": row.get("cluster_name"),
        "category": row.get("task_category"),
        "content": row.get("task_content"),
        "resolution": row.get("result_content"),
        "detail_content": None,
        "started_at": row.get("scheduled_at"),
        "closed_at": row.get("completed_at"),
        "remarks": row.get("remarks"),
        "service": row.get("service"),
        "confluence_url": row.get("confluence_url"),
        "priority": row.get("priority") or "medium",
        "kanban_status": row.get("kanban_status") or "todo",
        "module": row.get("module"),
        "type_label": row.get("type_label"),
        "effort_hours": row.get("effort_hours"),
        "done_condition": row.get("done_condition"),
        "parent_id": row.get("parent_id"),
        "related_work_item_id": row.get("issue_id"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def apply_import(
    db: Session,
    source: BackupSource | dict,
    *,
    mode: str = "merge",          # "merge" | "replace"
    include_logs: bool = False,
    dry_run: bool = False,
) -> dict:
    """백업 적용.

    - merge: PK 로 upsert. 기존 DB 에만 있고 백업에 없는 row 는 유지.
    - replace: 대상 테이블 전체 DELETE 후 INSERT (FK 때문에 역순 삭제).
    - dry_run: DB 변경 없이 compute_diff 만 반환.

    ``source`` 는 ``open_backup_file()`` 결과(디스크 파일에서 행을 흘려 읽음) 또는 dict envelope.
    레거시 issues/tasks 행은 source 가 work_items 로 바꿔 내준다.

    행/테이블 단위로 개별 SAVEPOINT(``db.begin_nested()``) 를 열어 처리한다 — 한
    행(예: FK 누락, 마스킹된 PK 등)이 실패해도 그 SAVEPOINT 만 롤백되고 이미
    처리된 다른 행/테이블은 유지된다. 응답의 inserted/updated/deleted 는 실제로
    커밋되는 카운트와 항상 일치한다. 행 오류는 앞쪽 ``IMPORT_ERRORS_LIMIT`` 건만 응답에 싣는다.
    """
    if mode not in ("merge", "replace"):
        raise ValueError(f"unknown mode: {mode}")

    src = _as_source(source)
    diff = compute_diff(db, src, include_logs=include_logs)
    if dry_run:
        return {"dry_run": True, "mode": mode, "diff": diff}

    tables = _filter_tables(include_logs)
    inserted = 0
    updated = 0
    deleted = 0
    errors = _ErrorLog(IMPORT_ERRORS_LIMIT)

    engine: Engine = db.get_bind()
    insp = inspect(engine)

    if mode == "replace":
        # FK 역순 삭제 — 테이블 단위 SAVEPOINT 로 격리. 한 테이블이 FK 위반 등으로
        # 실패해도 그 SAVEPOINT 만 롤백되고, 이미 삭제에 성공한 다른 테이블은 유지된다.
        for t in reversed(tables):
            try:
                with db.begin_nested():
                    res = db.execute(t.delete())
                    deleted += res.rowcount or 0
            except Exception as e:
                errors.add(f"{t.name} DELETE 실패 ({type(e).__name__}): {str(e)[:120]}")

    for t in tables:
        col_types = {c.name: str(c.type) for c in t.columns}
        col_names = set(col_types.keys())

        for row in src.rows(t.name):
            # 현재 스키마에 없는 컬럼 키는 무시(버전 차이 대응). MASKED_SENTINEL 값은
            # export 시 마스킹된 민감 컬럼이므로 갱신 대상에서 아예 제외한다 —
            # 그래야 merge import 시 기존 kubeconfig/비밀번호/토큰이 보존된다
            # (신규 insert 라면 마스킹된 컬럼은 DB 기본값/NULL 로 남는다 — 원본이
            # 없으므로 복원 불가능한 건 불가피).
            clean: dict = {}
            for k, v in row.items():
                if k not in col_names:
                    continue
                dv = _deserialize_value(v, col_types[k])
                if dv == MASKED_SENTINEL:
                    continue
                clean[k] = dv
            if not clean:
                continue

            pk_cols = [pk.name for pk in t.primary_key.columns]
            pk_vals = {k: clean.get(k) for k in pk_cols}
            if any(v is None for v in pk_vals.values()):
                # PK 자체가 없거나(구버전 백업) 마스킹돼 upsert 불가 — 스킵.
                errors.add(f"{t.name} row skipped: PK missing ({pk_vals})")
                continue

            try:
                # 행 단위 SAVEPOINT — 이 행이 실패해도(FK 위반, 타입 불일치 등)
                # 이전에 커밋된 행들은 롤백되지 않는다. 실패 시 예외가 이 with
                # 블록을 빠져나가면서 SAVEPOINT 만 롤백되고, 아래 except 가 잡는다.
                with db.begin_nested():
                    if mode == "replace":
                        db.execute(t.insert().values(**_restore_masked_json(t.name, clean, None)))
                        inserted += 1
                    else:  # merge — upsert by PK
                        where = None
                        for k, v in pk_vals.items():
                            cond = t.c[k] == v
                            where = cond if where is None else where & cond
                        existing = db.execute(t.select().where(where)).first() if where is not None else None
                        clean = _restore_masked_json(t.name, clean, existing)
                        if existing is None:
                            db.execute(t.insert().values(**clean))
                            inserted += 1
                        else:
                            non_pk = {k: v for k, v in clean.items() if k not in pk_cols}
                            if non_pk:
                                db.execute(t.update().where(where).values(**non_pk))
                                updated += 1
            except Exception as e:
                errors.add(
                    f"{t.name} row {pk_vals}: {type(e).__name__}: {str(e)[:120]}"
                )

    # 시퀀스 동기화 — PostgreSQL 전용 (serial/identity 컬럼이 있는 경우).
    # 컬럼 단위 SAVEPOINT 로 격리 — setval 실패가 앞서 커밋된 insert/update 를
    # 되돌리지 않게 한다.
    if insp.dialect.name == "postgresql":
        for t in tables:
            for c in t.columns:
                # serial / identity 컬럼 판단 — server_default 가 nextval 이거나 identity
                if getattr(c, "server_default", None) is None and not getattr(c, "autoincrement", False):
                    continue
                try:
                    with db.begin_nested():
                        db.execute(text(
                            f"SELECT setval(pg_get_serial_sequence('{t.name}', '{c.name}'), "
                            f"COALESCE((SELECT MAX({c.name}) FROM {t.name}), 1), "
                            f"(SELECT MAX({c.name}) FROM {t.name}) IS NOT NULL)"
                        ))
                except Exception:
                    pass  # serial 없는 컬럼은 무시

    db.commit()

    return {
        "dry_run": False,
        "mode": mode,
        "inserted": inserted,
        "updated": updated,
        "deleted": deleted,
        "errors": errors.finish(),
        "diff": diff,
    }


# ── Meta ────────────────────────────────────────────────────────────────

def current_meta(db: Session) -> dict:
    """현재 DB 의 테이블 별 row 수 + 전체 요약. per-table 실패는 0 으로 표시 +
    실패 후 트랜잭션 rollback 으로 후속 쿼리 보호.
    """
    tables = list(Base.metadata.sorted_tables)
    counts: dict[str, int] = {}
    for t in tables:
        try:
            r = db.execute(text(f"SELECT count(*) FROM {t.name}")).scalar()
            counts[t.name] = int(r or 0)
        except Exception:
            counts[t.name] = 0
            try:
                db.rollback()
            except Exception:
                pass
    total = sum(counts.values())
    return {
        "version": BACKUP_VERSION,
        "tables": [
            {"name": n, "rows": counts[n], "is_log": n in LOG_TABLES}
            for n in sorted(counts.keys())
        ],
        "total_rows": total,
        "log_tables": sorted(LOG_TABLES),
    }


# Helpers for routing layer
def bytes_from_upload(fobj: io.IOBase | bytes) -> bytes:
    if isinstance(fobj, bytes):
        return fobj
    data = fobj.read()
    if isinstance(data, str):
        return data.encode("utf-8")
    return data


def _unused() -> Optional[bool]:
    return None
