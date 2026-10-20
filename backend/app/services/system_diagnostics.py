"""시스템 진단 — "지금 어디가 문제인가" 를 한 번에 모은다(Settings ▸ 시스템 진단, admin).

섹션마다 독립적으로 수집하고 실패하면 ``status="offline"`` + 사유로 돌려준다(fail-safe) — 진단 화면이
진단 대상(DB·Redis·Celery)이 죽었다고 같이 죽으면 안 된다.

섹션별 상태: ``ok`` | ``warning`` | ``critical`` | ``offline``. 판정 기준은 ``THRESHOLDS`` 로 응답에 함께
실어 화면에 보여 준다(무엇을 근거로 경고했는지 운영자가 알 수 있게).
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.config import settings
from app.services import boot_state, pod_heartbeat

_log = logging.getLogger("k8s_monitor.diagnostics")

THRESHOLDS = {
    "long_transaction_seconds": 300,  # 이보다 오래 열린 트랜잭션은 DDL·다른 쿼리를 막을 수 있다
    "lock_wait_critical_seconds": 5,  # lock 을 이만큼 넘게 기다리는 세션이 있으면 위험
    "connection_usage_warning": 0.8,  # max_connections 대비 사용률
    "queue_length_warning": 100,  # Celery 큐 적체
    "stale_queued_minutes": 10,  # 점검 수행이 이보다 오래 대기 중이면 워커 미처리 의심
    "stale_running_minutes": 30,
    "errors_1h_critical": 20,
}
_RANK = {"ok": 0, "warning": 1, "offline": 2, "critical": 3}
_LITERAL = re.compile(r"'(?:[^']|'')*'")


def _worst(*statuses: str) -> str:
    return max(statuses or ("ok",), key=lambda s: _RANK.get(s, 0))


def _mask_query(q: str | None) -> str | None:
    """쿼리 문자열 리터럴을 가린다 — psycopg2 는 파라미터를 문자열로 박아 보내 비밀값이 섞일 수 있다."""
    if not q:
        return q
    return _LITERAL.sub("'?'", q)[:300]


def _section(name: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        out = fn()
    except Exception as e:  # noqa: BLE001 — 진단은 절대 500 을 내지 않는다
        _log.warning("diagnostics section %s failed: %s", name, e)
        out = {"status": "offline", "error": f"{type(e).__name__}: {str(e)[:300]}"}
    out["collected_ms"] = int((time.monotonic() - started) * 1000)
    return out


# ── 섹션 ─────────────────────────────────────────────────────────────────────
def responding_pod(app_version: str | None) -> dict[str, Any]:
    from app.services.memory_watch import current_rss

    rss = current_rss()
    now = datetime.now(timezone.utc)
    return {
        "status": "ok",
        "pod": boot_state.POD_NAME,
        "version": app_version,
        "process_started_at": boot_state.PROCESS_STARTED_AT.isoformat(),
        "uptime_seconds": int((now - boot_state.PROCESS_STARTED_AT).total_seconds()),
        "rss_mb": round(rss / 1048576, 1) if rss else None,
    }


def pods_section(app_version: str | None) -> dict[str, Any]:
    pods = pod_heartbeat.list_pods()
    versions = sorted({p.get("version") or "?" for p in pods})
    problems: list[str] = []
    if len(versions) > 1:
        problems.append(f"backend 파드 버전이 섞여 있다({', '.join(versions)}) — 롤링 배포 중이거나 새 파드가 기동하지 못했다")
    if app_version and versions and app_version not in versions:
        problems.append("응답한 파드의 heartbeat 가 아직 없다(방금 기동했거나 Redis 기록 실패)")
    for p in pods:
        if p.get("pending_ddl"):
            problems.append(f"{p.get('pod')}: 미룬 DDL {len(p['pending_ddl'])}건")
        if p.get("failed_steps"):
            problems.append(f"{p.get('pod')}: 부팅 단계 실패 {', '.join(p['failed_steps'])}")
    return {
        "status": "warning" if problems or not pods else "ok",
        "pods": pods,
        "versions": versions,
        "problems": problems or ([] if pods else ["heartbeat 를 남긴 파드가 없다 — Redis 연결 또는 heartbeat 기동 확인"]),
    }


def boot_section() -> dict[str, Any]:
    snap = boot_state.snapshot()
    flags = ["ok"]
    if snap["failed_steps"] or snap["advisory_lock"] in ("timeout", "failed") or snap["started_at"] is None:
        flags.append("warning")
    if snap["pending_ddl"]:
        flags.append("critical")  # 모델에는 있는데 DB 에 없는 컬럼 — 해당 테이블 조회가 실패한다
    return {"status": _worst(*flags), **snap}


def celery_section() -> dict[str, Any]:
    import redis as _redis

    from app.celery_app import celery_app

    broker = _redis.Redis.from_url(settings.celery_broker_url, socket_connect_timeout=1, socket_timeout=2)
    try:
        broker.ping()
    except Exception as e:  # noqa: BLE001
        return {"status": "critical", "broker_ok": False, "error": f"브로커(Redis) 연결 실패: {e}", "workers": [], "queues": {}}
    queues = {q: int(broker.llen(q)) for q in ("celery", "llm")}
    insp = celery_app.control.inspect(timeout=1.5)
    active = insp.active() or {}
    reserved = insp.reserved() or {}
    workers = [
        {"name": name, "active": len(active.get(name) or []), "reserved": len(reserved.get(name) or [])}
        for name in sorted(set(active) | set(reserved))
    ]
    problems: list[str] = []
    if not workers:
        problems.append("응답한 Celery 워커가 없다 — 실행·점검이 대기열에서 멈춘다")
    for q, n in queues.items():
        if n >= THRESHOLDS["queue_length_warning"]:
            problems.append(f"큐 '{q}' 적체 {n}건")
    return {
        "status": "critical" if not workers else ("warning" if problems else "ok"),
        "broker_ok": True,
        "workers": workers,
        "queues": queues,
        "problems": problems,
    }


def database_section(db: Session) -> dict[str, Any]:
    from app.database import engine

    db.execute(text("SET LOCAL statement_timeout = 3000"))
    rows = db.execute(text("""
        SELECT pid, state, application_name, client_addr::text AS client,
               EXTRACT(EPOCH FROM now() - xact_start)::int AS xact_age,
               EXTRACT(EPOCH FROM now() - query_start)::int AS query_age,
               wait_event_type, wait_event, query, pg_blocking_pids(pid) AS blocked_by
          FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
    """)).mappings().all()
    max_conn = int(db.execute(text("SHOW max_connections")).scalar() or 0)
    total = len(rows) + 1
    long_tx = [
        {"pid": r["pid"], "state": r["state"], "age_seconds": r["xact_age"], "application": r["application_name"],
         "client": r["client"], "query": _mask_query(r["query"])}
        for r in rows if (r["xact_age"] or 0) >= THRESHOLDS["long_transaction_seconds"]
    ]
    lock_waits = [
        {"pid": r["pid"], "wait_seconds": r["query_age"], "wait_event": r["wait_event"],
         "blocked_by": list(r["blocked_by"] or []), "query": _mask_query(r["query"])}
        for r in rows if r["wait_event_type"] == "Lock"
    ]
    pool = engine.pool
    usage = (total / max_conn) if max_conn else 0
    problems: list[str] = []
    critical = any((w["wait_seconds"] or 0) >= THRESHOLDS["lock_wait_critical_seconds"] for w in lock_waits)
    if lock_waits:
        problems.append(f"lock 대기 세션 {len(lock_waits)}개 — 막는 세션 pid: "
                        + ", ".join(sorted({str(p) for w in lock_waits for p in w["blocked_by"]})))
    if long_tx:
        problems.append(f"{THRESHOLDS['long_transaction_seconds']}초 넘게 열린 트랜잭션 {len(long_tx)}개")
    if usage >= THRESHOLDS["connection_usage_warning"]:
        problems.append(f"연결 사용률 {usage:.0%} ({total}/{max_conn})")
    return {
        "status": "critical" if critical else ("warning" if problems else "ok"),
        "connections": {"total": total, "max": max_conn, "usage": round(usage, 3)},
        "pool": {
            "size": pool.size() if hasattr(pool, "size") else None,
            "checked_out": pool.checkedout() if hasattr(pool, "checkedout") else None,
            "overflow": pool.overflow() if hasattr(pool, "overflow") else None,
        },
        "long_transactions": long_tx,
        "lock_waits": lock_waits,
        "problems": problems,
    }


def runs_section(db: Session) -> dict[str, Any]:
    from app.models.check_matrix import CheckMatrixRun, CheckMatrixRunState

    now = datetime.utcnow()
    q_cut = now - timedelta(minutes=THRESHOLDS["stale_queued_minutes"])
    r_cut = now - timedelta(minutes=THRESHOLDS["stale_running_minutes"])
    base = db.query(func.count(CheckMatrixRun.id))
    queued = base.filter(CheckMatrixRun.run_state == CheckMatrixRunState.queued).scalar() or 0
    running = base.filter(CheckMatrixRun.run_state == CheckMatrixRunState.running).scalar() or 0
    stale_q = base.filter(CheckMatrixRun.run_state == CheckMatrixRunState.queued,
                          CheckMatrixRun.queued_at < q_cut).scalar() or 0
    stale_r = base.filter(CheckMatrixRun.run_state == CheckMatrixRunState.running,
                          CheckMatrixRun.started_at < r_cut).scalar() or 0
    problems = []
    if stale_q:
        problems.append(f"{THRESHOLDS['stale_queued_minutes']}분 넘게 대기 중인 점검 수행 {stale_q}건 — 워커가 집지 않는다")
    if stale_r:
        problems.append(f"{THRESHOLDS['stale_running_minutes']}분 넘게 실행 중인 점검 수행 {stale_r}건")
    return {
        "status": "warning" if problems else "ok",
        "queued": queued, "running": running, "stale_queued": stale_q, "stale_running": stale_r,
        "problems": problems,
    }


def errors_section(db: Session) -> dict[str, Any]:
    from app.models.system_error_log import SystemErrorLog

    now = datetime.utcnow()
    last_1h = db.query(func.count(SystemErrorLog.id)).filter(SystemErrorLog.created_at >= now - timedelta(hours=1)).scalar() or 0
    last_24h = db.query(func.count(SystemErrorLog.id)).filter(SystemErrorLog.created_at >= now - timedelta(hours=24)).scalar() or 0
    top = (
        db.query(SystemErrorLog.path, func.count(SystemErrorLog.id).label("n"))
        .filter(SystemErrorLog.created_at >= now - timedelta(hours=24))
        .group_by(SystemErrorLog.path).order_by(func.count(SystemErrorLog.id).desc()).limit(5).all()
    )
    latest = (
        db.query(SystemErrorLog).order_by(SystemErrorLog.created_at.desc()).limit(5).all()
    )
    return {
        "status": "critical" if last_1h >= THRESHOLDS["errors_1h_critical"] else ("warning" if last_1h else "ok"),
        "last_1h": last_1h,
        "last_24h": last_24h,
        "top_paths": [{"path": p, "count": n} for p, n in top],
        "latest": [{
            "request_id": e.request_id, "method": e.method, "path": e.path, "status_code": e.status_code,
            "error_type": e.error_type, "created_at": e.created_at.isoformat() if e.created_at else None,
        } for e in latest],
    }


def _with_session(fn: Callable[[Session], dict[str, Any]]) -> Callable[[], dict[str, Any]]:
    def run() -> dict[str, Any]:
        from app.database import SessionLocal

        s = SessionLocal()
        try:
            return fn(s)
        finally:
            s.rollback()
            s.close()
    return run


def collect(app_version: str | None) -> dict[str, Any]:
    """모든 섹션을 모은다. 섹션마다 별도 세션 — 한 섹션의 DB 오류가 다른 섹션 트랜잭션을 깨지 않게."""
    sections = {
        "responding_pod": _section("responding_pod", lambda: responding_pod(app_version)),
        "pods": _section("pods", lambda: pods_section(app_version)),
        "boot": _section("boot", boot_section),
        "celery": _section("celery", celery_section),
        "database": _section("database", _with_session(database_section)),
        "runs": _section("runs", _with_session(runs_section)),
        "errors": _section("errors", _with_session(errors_section)),
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "overall": _worst(*(s["status"] for s in sections.values())),
        "thresholds": THRESHOLDS,
        **sections,
    }
