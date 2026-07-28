"""CheckMatrixService — 점검 매트릭스(행 × 열) 그리드 빌드, 셀 이력, 기본 항목 시드,
cron 디스패치 실행, 이력 리텐션 정리.

행(CheckMatrixItem)은 3가지 실행 소스를 가진다:
  - core_bundle : DailyChecker.run_daily_check() 원자 실행 결과 투영. cron 은
                  Cluster.check_cron_expr (Cluster.status authority 보존을 위해 항목별이 아님).
  - deep_check  : deep_checkers.REGISTRY 의 check_type 을 DeepCheckService 로 실행.
  - addon       : Addon.type 매칭 인스턴스를 HealthChecker 로 실행.
  - manual      : 자동 실행 없음 — record_manual_entry() 로만 값이 채워진다.

deep_check/addon 행의 source_ref 는 "논리 키"(check_type / addon.type 문자열)이며, 클러스터별
실제 인스턴스(DeepCheckDefinition/Addon)는 실행 시점에 이 키로 해석한다(OpsCheckService 의
``f"type:{check_type}"`` fallback 패턴과 동일 사고).
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import asc
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Addon,
    CheckMatrixItem,
    CheckMatrixResult,
    CheckMatrixResultLog,
    CheckMatrixRun,
    CheckMatrixRunState,
    CheckMatrixSchedule,
    CheckMatrixSourceType,
    CheckMatrixTrigger,
    Cluster,
    DeepCheckDefinition,
    StatusEnum,
)

logger = logging.getLogger(__name__)

# Ollama AI 리뷰(core_bundle)와 deep-check 부하 보호 — 이보다 짧은 평균 간격의 cron 은 거부.
MIN_CRON_INTERVAL_MINUTES = 5
RETENTION_SETTINGS_KEY = "check_matrix.settings"
DEFAULT_RETENTION_DAYS = 90
CORE_BUNDLE_ITEM_NAME = "K8S API-SERVER 응답시간"

_ADDON_LABELS: dict[str, str] = {
    "etcd-leader": "ETCD Leader",
    "node-check": "노드 상태",
    "control-plane": "컨트롤 플레인",
    "system-pod": "시스템 파드",
    "nexus": "Nexus",
    "jenkins": "Jenkins",
    "argocd": "ArgoCD",
    "keycloak": "Keycloak",
}


# ──────────────────────────────────────────────────────────────
# 설정(이력 보관 주기)
# ──────────────────────────────────────────────────────────────
def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == RETENTION_SETTINGS_KEY).first()
    val = (row.value if row and isinstance(row.value, dict) else None) or {}
    return {"retention_days": int(val.get("retention_days") or DEFAULT_RETENTION_DAYS)}


def set_settings(db: Session, retention_days: int) -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    retention_days = max(1, int(retention_days))
    row = db.query(AppSetting).filter(AppSetting.key == RETENTION_SETTINGS_KEY).first()
    val = {"retention_days": retention_days}
    if row:
        row.value = val
    else:
        db.add(AppSetting(key=RETENTION_SETTINGS_KEY, value=val))
    db.commit()
    return val


def validate_cron_min_interval(cron_expr: Optional[str]) -> None:
    """평균 실행 간격이 MIN_CRON_INTERVAL_MINUTES 미만이면 거부."""
    if not cron_expr:
        return
    try:
        from croniter import croniter
    except ImportError:
        return
    if not croniter.is_valid(cron_expr):
        raise ValueError("올바르지 않은 cron 표현식입니다.")
    base = datetime(2024, 1, 1, 0, 0, 0)
    itr = croniter(cron_expr, base)
    first = itr.get_next(datetime)
    second = itr.get_next(datetime)
    if (second - first).total_seconds() < MIN_CRON_INTERVAL_MINUTES * 60:
        raise ValueError(f"cron 최소 간격은 {MIN_CRON_INTERVAL_MINUTES}분입니다.")


# ──────────────────────────────────────────────────────────────
# 그리드 / 이력
# ──────────────────────────────────────────────────────────────
def _item_to_dict(item: CheckMatrixItem) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "name": item.name,
        "description": item.description,
        "unit": item.unit,
        "source_type": item.source_type.value,
        "source_ref": item.source_ref,
        "is_system": item.is_system,
        "enabled": item.enabled,
        "sort_order": item.sort_order,
    }


def build_grid(db: Session) -> dict[str, Any]:
    items = (
        db.query(CheckMatrixItem)
        .order_by(CheckMatrixItem.sort_order.asc(), CheckMatrixItem.created_at.asc())
        .all()
    )
    clusters = db.query(Cluster).order_by(Cluster.seq.asc(), Cluster.name.asc()).all()

    result_by_cell: dict[tuple[str, str], CheckMatrixResult] = {
        (str(r.item_id), str(r.cluster_id)): r for r in db.query(CheckMatrixResult).all()
    }
    schedule_by_cell: dict[tuple[str, str], CheckMatrixSchedule] = {
        (str(s.item_id), str(s.cluster_id)): s for s in db.query(CheckMatrixSchedule).all()
    }

    cells: dict[str, dict[str, dict[str, Any]]] = {}
    for item in items:
        row: dict[str, Any] = {}
        for cluster in clusters:
            key = (str(item.id), str(cluster.id))
            r = result_by_cell.get(key)
            if item.source_type == CheckMatrixSourceType.core_bundle:
                cron_expr = cluster.check_cron_expr
                schedule_enabled = bool(cron_expr)
            else:
                sch = schedule_by_cell.get(key)
                cron_expr = sch.cron_expr if sch else None
                schedule_enabled = bool(sch and sch.enabled and sch.cron_expr)
            row[str(cluster.id)] = {
                # r 이 없으면 "미실행" — Addon.status 기본값(healthy) 등으로 오인 표시하지 않도록
                # status 를 None 으로 명시 내려보낸다(프론트에서 "—" 렌더).
                "status": r.status.value if r else None,
                "value": r.value if r else None,
                "message": r.message if r else None,
                "checked_at": r.checked_at.isoformat() if r and r.checked_at else None,
                "cron_expr": cron_expr,
                "schedule_enabled": schedule_enabled,
                "has_result": r is not None,
            }
        cells[str(item.id)] = row

    return {
        "items": [_item_to_dict(i) for i in items],
        "clusters": [
            {"id": str(c.id), "name": c.name, "check_cron_expr": c.check_cron_expr}
            for c in clusters
        ],
        "cells": cells,
    }


def get_cell_history(db: Session, item_id, cluster_id, days: int = 30) -> dict[str, Any]:
    cutoff = datetime.utcnow() - timedelta(days=days)
    logs = (
        db.query(CheckMatrixResultLog)
        .filter(
            CheckMatrixResultLog.item_id == item_id,
            CheckMatrixResultLog.cluster_id == cluster_id,
            CheckMatrixResultLog.checked_at >= cutoff,
        )
        .order_by(asc(CheckMatrixResultLog.checked_at))
        .all()
    )
    points = [
        {"checked_at": l.checked_at.isoformat(), "status": l.status.value, "value": l.value}
        for l in logs
    ]
    changes: list[dict[str, Any]] = []
    prev_status: Optional[StatusEnum] = None
    for l in logs:
        if l.status != prev_status:
            changes.append({
                "checked_at": l.checked_at.isoformat(),
                "status": l.status.value,
                "message": l.message,
            })
            prev_status = l.status
    return {"points": points, "changes": list(reversed(changes))}


# ──────────────────────────────────────────────────────────────
# 결과 upsert(레이스 방지: ON CONFLICT DO UPDATE) + 이력 append
# ──────────────────────────────────────────────────────────────
def _upsert_result(
    db: Session,
    item_id,
    cluster_id,
    status: StatusEnum,
    value: Optional[float],
    message: Optional[str],
    details: Optional[dict],
    checked_at: Optional[datetime] = None,
) -> None:
    checked_at = checked_at or datetime.utcnow()
    stmt = pg_insert(CheckMatrixResult).values(
        id=uuid.uuid4(),
        item_id=item_id,
        cluster_id=cluster_id,
        status=status,
        value=value,
        message=message,
        details=details,
        checked_at=checked_at,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["item_id", "cluster_id"],
        set_={
            "status": status,
            "value": value,
            "message": message,
            "details": details,
            "checked_at": checked_at,
        },
    )
    db.execute(stmt)
    db.add(CheckMatrixResultLog(
        item_id=item_id, cluster_id=cluster_id, status=status,
        value=value, message=message, details=details, checked_at=checked_at,
    ))


def record_manual_entry(
    db: Session, item_id, cluster_id, status: StatusEnum,
    value: Optional[float], message: Optional[str],
    *, triggered_by: Optional[str] = None,
) -> None:
    """수동 입력 — 값 기록과 함께 '누가 언제 무엇을 넣었는지'를 실행 로그에도 남긴다.
    자동 점검과 수동 입력을 같은 로그 뷰에서 함께 추적할 수 있어야 하기 때문이다."""
    now = datetime.utcnow()
    _upsert_result(db, item_id, cluster_id, status, value, message, details=None, checked_at=now)
    db.add(CheckMatrixRun(
        item_id=item_id,
        cluster_id=cluster_id,
        trigger=CheckMatrixTrigger.manual_entry,
        triggered_by=triggered_by,
        run_state=CheckMatrixRunState.success,
        status=status,
        value=value,
        message=message,
        details={"_manual": True},
        duration_ms=0,
        queued_at=now,
        started_at=now,
        finished_at=now,
    ))
    db.commit()


def project_core_bundle_result(db: Session, cluster: Cluster, log: Any) -> None:
    """DailyChecker 가 커밋한 DailyCheckLog 에서 API 응답시간을 core_bundle 행에 투영."""
    item = (
        db.query(CheckMatrixItem)
        .filter(CheckMatrixItem.source_type == CheckMatrixSourceType.core_bundle)
        .first()
    )
    if item is None:
        return
    value = float(log.api_server_response_time_ms) if log.api_server_response_time_ms is not None else None
    message = f"API 서버 응답시간 {value:.0f}ms" if value is not None else "API 서버 응답 없음"
    _upsert_result(
        db, item.id, cluster.id, log.api_server_status, value, message,
        log.api_server_details, checked_at=log.checked_at,
    )
    db.commit()


# ──────────────────────────────────────────────────────────────
# 논리 키 → 클러스터별 실제 인스턴스 해석 + 실행
# ──────────────────────────────────────────────────────────────
def _resolve_deep_check_definition(db: Session, check_type: str, cluster_id) -> Optional[DeepCheckDefinition]:
    """클러스터 전용 정의 우선, 없으면 글로벌 정의로 fallback."""
    d = (
        db.query(DeepCheckDefinition)
        .filter(DeepCheckDefinition.check_type == check_type, DeepCheckDefinition.cluster_id == cluster_id)
        .first()
    )
    if d is not None:
        return d
    return (
        db.query(DeepCheckDefinition)
        .filter(DeepCheckDefinition.check_type == check_type, DeepCheckDefinition.cluster_id.is_(None))
        .first()
    )


def _resolve_addon(db: Session, addon_type: str, cluster_id) -> Optional[Addon]:
    return (
        db.query(Addon)
        .filter(Addon.type == addon_type, Addon.cluster_id == cluster_id)
        .first()
    )


def execute_item_for_cluster(db: Session, item: CheckMatrixItem, cluster: Cluster) -> bool:
    """due 한 item × cluster 셀을 실행하고 결과를 upsert.

    실행 로그(CheckMatrixRun)를 함께 남기는 ``execute_run`` 의 얇은 래퍼다 — 기존
    호출부(수동 트리거 없는 경로)의 bool 계약을 유지한다. 실행 대상(정의/애드온)이
    해당 클러스터에 없으면 False 이고, 셀은 "미실행" 상태로 남는다.
    """
    run = create_run(db, item, cluster, trigger=CheckMatrixTrigger.cron)
    outcome = execute_run(db, run.id)
    return outcome["run_state"] == CheckMatrixRunState.success.value


def run_core_bundle(db: Session, cluster: Cluster) -> None:
    """core_bundle(DailyChecker 원자 실행) — 실행 로그와 함께."""
    item = (
        db.query(CheckMatrixItem)
        .filter(CheckMatrixItem.source_type == CheckMatrixSourceType.core_bundle)
        .first()
    )
    if item is None:
        _run_core_bundle_raw(db, cluster)
        return
    run = create_run(db, item, cluster, trigger=CheckMatrixTrigger.cron)
    execute_run(db, run.id)


def _run_core_bundle_raw(db: Session, cluster: Cluster):
    import asyncio
    from app.models import CheckScheduleType
    from app.services.daily_checker import DailyChecker

    log = asyncio.run(DailyChecker(db).run_daily_check(str(cluster.id), CheckScheduleType.manual))
    project_core_bundle_result(db, cluster, log)
    return log


# ──────────────────────────────────────────────────────────────
# 실행 로그(CheckMatrixRun) — 모든 수행의 개별 기록
# ──────────────────────────────────────────────────────────────
def create_run(
    db: Session,
    item: CheckMatrixItem,
    cluster: Cluster,
    *,
    trigger: CheckMatrixTrigger,
    triggered_by: Optional[str] = None,
    batch_id: Optional[uuid.UUID] = None,
    forced_definition_id: Optional[str] = None,
) -> CheckMatrixRun:
    """queued 상태의 수행 레코드를 만든다 — 큐잉 직후부터 UI 에 보이게 하려는 것.

    비동기 일괄 실행에서 "몇 건 중 몇 건이 끝났나"를 셀 수 있는 근거가 된다.

    ``forced_definition_id`` 는 "이 정의를 돌린 결과"임이 이미 확정된 경우(정의별
    cron 이 발화한 경로)에 쓴다 — 체크타입만으로 다시 해석하면 클러스터 전용/글로벌
    중 다른 정의를 집을 수 있어서, 실행된 정의를 run 에 못박아 celery 경계를 넘긴다.
    """
    run = CheckMatrixRun(
        batch_id=batch_id,
        item_id=item.id,
        cluster_id=cluster.id,
        trigger=trigger,
        triggered_by=triggered_by,
        run_state=CheckMatrixRunState.queued,
        queued_at=datetime.utcnow(),
        details={"_definition_id": forced_definition_id} if forced_definition_id else None,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _finish_run(
    run: CheckMatrixRun,
    state: CheckMatrixRunState,
    *,
    status: Optional[StatusEnum] = None,
    value: Optional[float] = None,
    message: Optional[str] = None,
    details: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    run.run_state = state
    run.status = status
    run.value = value
    run.message = message
    run.details = details
    run.error = error
    run.finished_at = datetime.utcnow()
    if run.started_at:
        run.duration_ms = int((run.finished_at - run.started_at).total_seconds() * 1000)


def execute_run(db: Session, run_id) -> dict[str, Any]:
    """수행 레코드 1건을 실제로 실행하고 결과를 기록한다.

    항상 run 을 종료 상태로 만들고 예외를 삼킨다 — 한 셀의 실패가 일괄 실행 전체를
    중단시키면 안 되고, 실패 자체도 로그로 남아야 하기 때문이다.
    """
    run = db.query(CheckMatrixRun).filter(CheckMatrixRun.id == run_id).first()
    if run is None:
        return {"error": "run not found", "run_id": str(run_id)}
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == run.item_id).first()
    cluster = db.query(Cluster).filter(Cluster.id == run.cluster_id).first()

    run.run_state = CheckMatrixRunState.running
    run.started_at = datetime.utcnow()
    db.commit()

    if item is None or cluster is None:
        _finish_run(run, CheckMatrixRunState.failed, error="항목 또는 클러스터가 삭제되었습니다.")
        db.commit()
        return _run_to_dict(run)

    try:
        _execute_into_run(db, run, item, cluster)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        # rollback 이 run 을 만료시키므로 다시 읽어 실패로 마감한다.
        run = db.query(CheckMatrixRun).filter(CheckMatrixRun.id == run_id).first()
        if run is not None:
            _finish_run(run, CheckMatrixRunState.failed, error=str(e)[:1000])
            db.commit()
        logger.exception("check-matrix run failed run_id=%s", run_id)
    return _run_to_dict(run) if run is not None else {"error": "run lost", "run_id": str(run_id)}


def _execute_into_run(
    db: Session, run: CheckMatrixRun, item: CheckMatrixItem, cluster: Cluster,
) -> None:
    from app.services.check_matrix_runbook import build_runbook

    runbook = build_runbook(db, item, cluster)
    base_details: dict[str, Any] = {"_runbook": runbook}
    forced_definition_id = (run.details or {}).get("_definition_id")

    if item.source_type == CheckMatrixSourceType.manual:
        _finish_run(
            run, CheckMatrixRunState.skipped,
            message="수동 입력 항목이라 자동 실행 대상이 아닙니다 — 셀 상세에서 값을 입력하세요.",
            details=base_details,
        )
        db.commit()
        return

    if item.source_type == CheckMatrixSourceType.core_bundle:
        log = _run_core_bundle_raw(db, cluster)
        value = (
            float(log.api_server_response_time_ms)
            if log.api_server_response_time_ms is not None else None
        )
        _finish_run(
            run, CheckMatrixRunState.success,
            status=log.api_server_status,
            value=value,
            message=(f"API 서버 응답시간 {value:.0f}ms" if value is not None else "API 서버 응답 없음"),
            details={
                **base_details,
                "overall_status": log.overall_status.value if log.overall_status else None,
                "api_server_details": log.api_server_details,
                "components_status": log.components_status,
                "nodes_status": log.nodes_status,
                "system_pods_status": log.system_pods_status,
                "error_messages": log.error_messages,
                "warning_messages": log.warning_messages,
                "daily_check_log_id": str(log.id),
            },
        )
        db.commit()
        return

    if item.source_type == CheckMatrixSourceType.deep_check:
        definition = None
        if forced_definition_id:
            definition = (
                db.query(DeepCheckDefinition)
                .filter(DeepCheckDefinition.id == forced_definition_id)
                .first()
            )
        if definition is None:
            definition = _resolve_deep_check_definition(db, item.source_ref, cluster.id)
        if definition is None:
            _finish_run(
                run, CheckMatrixRunState.skipped,
                message=runbook.get("blocked_reason") or f"`{item.source_ref}` 점검 정의가 없습니다.",
                details=base_details,
            )
            db.commit()
            return
        from app.services.deep_check_service import DeepCheckService
        from app.services.deep_checkers.registry import extract_cell_value

        res = DeepCheckService(db).run_definition_once(definition.id, cluster=cluster, persist=True)
        try:
            status = StatusEnum(res.get("status", "pending"))
        except ValueError:
            status = StatusEnum.pending
        # 셀 대표값(잔여일/실패율/건수 등) — "정상" 라벨 대신 숫자가 보이게 한다.
        value = extract_cell_value(item.source_ref, res.get("details"))
        details = {**base_details, **(res.get("details") or {}), "_step_plan": res.get("step_plan") or []}
        _upsert_result(db, item.id, cluster.id, status, value, res.get("message") or "", res.get("details"))
        _finish_run(
            run, CheckMatrixRunState.success,
            status=status, value=value, message=res.get("message") or "", details=details,
        )
        db.commit()
        return

    if item.source_type == CheckMatrixSourceType.addon:
        addon = _resolve_addon(db, item.source_ref, cluster.id)
        if addon is None:
            _finish_run(
                run, CheckMatrixRunState.skipped,
                message=runbook.get("blocked_reason") or f"`{item.source_ref}` 애드온이 없습니다.",
                details=base_details,
            )
            db.commit()
            return
        from app.services.health_checker import HealthChecker
        result = HealthChecker(db).run_single_addon_check(cluster.id, addon.id)
        if result is None:
            _finish_run(
                run, CheckMatrixRunState.skipped,
                message="애드온 실행 대상을 해석하지 못했습니다.", details=base_details,
            )
            db.commit()
            return
        _upsert_result(
            db, item.id, cluster.id, result.status, result.response_time,
            result.message or "", result.details,
        )
        _finish_run(
            run, CheckMatrixRunState.success,
            status=result.status, value=result.response_time,
            message=result.message or "",
            details={**base_details, **(result.details or {})},
        )
        db.commit()
        return

    _finish_run(
        run, CheckMatrixRunState.skipped,
        message=f"지원하지 않는 실행 방식입니다: {item.source_type.value}", details=base_details,
    )
    db.commit()


# ──────────────────────────────────────────────────────────────
# 실행 트리거 — 셀 / 클러스터(열) / 항목(행)
# ──────────────────────────────────────────────────────────────
def _batch_targets_for_cluster(db: Session, cluster: Cluster) -> list[CheckMatrixItem]:
    """클러스터 단위 일괄 실행 대상 — 활성 항목 중 자동 실행 가능한 것.

    manual 항목은 자동 실행 개념이 없어 제외한다. 대상 정의/애드온이 없는 항목은
    제외하지 않는다 — 'skipped' 로 로그에 남아야 셀이 왜 비어 있는지 알 수 있다.
    """
    return (
        db.query(CheckMatrixItem)
        .filter(CheckMatrixItem.enabled.is_(True))
        .filter(CheckMatrixItem.source_type != CheckMatrixSourceType.manual)
        .order_by(CheckMatrixItem.sort_order.asc(), CheckMatrixItem.created_at.asc())
        .all()
    )


def execute_definition_for_cluster(db: Session, definition_id, cluster: Cluster) -> dict[str, Any]:
    """정의별 cron(`DeepCheckDefinition.schedule_cron`)이 발화한 실행.

    같은 check_type 의 매트릭스 행이 있으면 그 셀의 수행으로 로그를 남긴다 — 사용자
    입장에서는 매트릭스 셀이 갱신된 것이므로, 자동/수동을 막론하고 한 곳에서 이력을
    볼 수 있어야 한다. 매트릭스에 없는 커스텀 정의는 DeepCheckResult 에만 남는다.
    """
    definition = (
        db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == definition_id).first()
    )
    if definition is None:
        return {"error": "definition not found", "definition_id": str(definition_id)}

    item = (
        db.query(CheckMatrixItem)
        .filter(
            CheckMatrixItem.source_type == CheckMatrixSourceType.deep_check,
            CheckMatrixItem.source_ref == definition.check_type,
        )
        .first()
    )
    if item is None:
        from app.services.deep_check_service import DeepCheckService
        DeepCheckService(db).run_definition_once(definition.id, cluster=cluster, persist=True)
        return {"definition_id": str(definition.id), "cluster_id": str(cluster.id), "logged": False}

    run = create_run(
        db, item, cluster,
        trigger=CheckMatrixTrigger.cron, forced_definition_id=str(definition.id),
    )
    result = execute_run(db, run.id)
    return {**result, "logged": True}


def run_cell_now(
    db: Session, item: CheckMatrixItem, cluster: Cluster, *, triggered_by: Optional[str] = None,
) -> dict[str, Any]:
    """셀 1건 동기 실행 — 즉시 결과를 돌려준다(요청 스레드에서 실행)."""
    run = create_run(
        db, item, cluster,
        trigger=CheckMatrixTrigger.manual_cell, triggered_by=triggered_by, batch_id=uuid.uuid4(),
    )
    return execute_run(db, run.id)


def start_batch(
    db: Session,
    pairs: list[tuple[CheckMatrixItem, Cluster]],
    *,
    trigger: CheckMatrixTrigger,
    triggered_by: Optional[str] = None,
) -> dict[str, Any]:
    """여러 셀을 queued 로 만들고 Celery 로 fan-out 한다.

    큐잉만 하고 즉시 반환하므로 요청이 오래 물리지 않는다. 호출자는 batch_id 로
    진행 상황(queued → running → success/failed)을 폴링한다. Celery 가 없거나
    큐잉이 실패하면 해당 run 은 failed 로 마감돼 UI 에서 원인을 볼 수 있다.
    """
    batch_id = uuid.uuid4()
    runs = [
        create_run(db, item, cluster, trigger=trigger, triggered_by=triggered_by, batch_id=batch_id)
        for item, cluster in pairs
    ]
    queued = 0
    errors: list[str] = []
    for run in runs:
        try:
            from app.celery_app import run_check_matrix_run_one
            run_check_matrix_run_one.apply_async(args=[str(run.id)])
            queued += 1
        except Exception as e:  # noqa: BLE001
            logger.exception("check-matrix batch queue failed run_id=%s", run.id)
            _finish_run(
                run, CheckMatrixRunState.failed,
                error=f"실행 큐잉 실패 — Celery 워커/브로커 상태를 확인하세요: {str(e)[:200]}",
            )
            db.commit()
            errors.append(str(e)[:150])
    return {
        "batch_id": str(batch_id),
        "total": len(runs),
        "queued": queued,
        "errors": errors,
        "run_ids": [str(r.id) for r in runs],
    }


def run_cluster_now(
    db: Session, cluster: Cluster, *, triggered_by: Optional[str] = None,
) -> dict[str, Any]:
    """클러스터(열) 단위 — 이 클러스터의 모든 자동 점검 항목을 일괄 수행."""
    items = _batch_targets_for_cluster(db, cluster)
    return start_batch(
        db, [(i, cluster) for i in items],
        trigger=CheckMatrixTrigger.manual_cluster, triggered_by=triggered_by,
    )


def run_item_now(
    db: Session, item: CheckMatrixItem, *, triggered_by: Optional[str] = None,
) -> dict[str, Any]:
    """공통 점검 항목(행) 단위 — 등록된 모든 클러스터에 같은 점검을 일괄 수행."""
    clusters = db.query(Cluster).order_by(Cluster.seq.asc(), Cluster.name.asc()).all()
    return start_batch(
        db, [(item, c) for c in clusters],
        trigger=CheckMatrixTrigger.manual_item, triggered_by=triggered_by,
    )


# ──────────────────────────────────────────────────────────────
# 소스 설정 편집 — 기본 등록 항목의 params/thresholds/config 를 매트릭스에서 직접 수정
# ──────────────────────────────────────────────────────────────
def _coerce_field_value(raw: str, field_type: str) -> Any:
    """편집 폼의 문자열 값을 spec 필드 타입으로 강제. 빈 문자열은 None(=오버라이드 제거)."""
    import json as _json

    raw = (raw or "").strip()
    if raw == "":
        return None
    if field_type == "int":
        try:
            return int(float(raw))
        except ValueError:
            raise ValueError(f"'{raw}' 는 정수 값이 아닙니다.")
    if field_type == "float":
        try:
            return float(raw)
        except ValueError:
            raise ValueError(f"'{raw}' 는 숫자 값이 아닙니다.")
    if field_type == "boolean":
        return raw.lower() in ("true", "1", "yes", "on", "y")
    if field_type == "list":
        # JSON 배열 우선, 아니면 줄바꿈/쉼표 구분 문자열 목록.
        try:
            parsed = _json.loads(raw)
            if isinstance(parsed, list):
                return parsed
        except ValueError:
            pass
        return [tok.strip() for tok in raw.replace("\n", ",").split(",") if tok.strip()]
    return raw  # string


def update_source_config(
    db: Session,
    item: CheckMatrixItem,
    cluster: Cluster,
    entries: list[dict[str, str]],
) -> dict[str, Any]:
    """셀의 실행 소스 설정을 갱신한다 — 기본 등록 항목의 확인·수정 요건.

    - deep_check: 해석된 정의(클러스터 전용 우선, 없으면 글로벌)의 thresholds/params 를
      spec 필드 타입으로 강제해 저장. 알 수 없는 필드명은 400 (오타로 조용히 무시되는 것 방지).
      값을 비우면 해당 오버라이드를 제거해 spec 기본값으로 되돌린다.
    - addon: 해석된 애드온 인스턴스의 config 를 갱신(JSON 파싱 시도 후 실패 시 문자열).
    - entries 는 {group, name, value(문자열)} — 응답/요청 키 케이스 변환이 실제 파라미터
      이름을 건드리지 못하도록 이름을 값 자리에 둔 런북 inputs 와 같은 형태다.

    글로벌 정의 수정은 전 클러스터에 적용된다 — 호출 전 UI 가 경고를 띄운다.
    """
    if item.source_type == CheckMatrixSourceType.deep_check:
        from app.services.deep_checkers.registry import REGISTRY

        entry = REGISTRY.get(item.source_ref or "")
        if entry is None:
            raise ValueError(f"알 수 없는 check_type: {item.source_ref}")
        spec = entry[1]
        field_types: dict[tuple[str, str], str] = {}
        for f in spec.threshold_fields:
            field_types[("thresholds", f.name)] = f.type
        for f in spec.param_fields:
            field_types[("params", f.name)] = f.type

        definition = _resolve_deep_check_definition(db, item.source_ref, cluster.id)
        if definition is None:
            raise ValueError(
                f"이 클러스터에 `{item.source_ref}` 점검 정의가 없습니다 — "
                "운영 점검(Ops Checks) 화면에서 정의를 먼저 만드세요."
            )

        thresholds = dict(definition.thresholds or {})
        params = dict(definition.params or {})
        for e in entries:
            group, name, raw = e["group"], e["name"], e.get("value", "")
            if group not in ("thresholds", "params"):
                raise ValueError(f"알 수 없는 설정 그룹: {group}")
            ftype = field_types.get((group, name))
            if ftype is None:
                raise ValueError(f"`{item.source_ref}` 에 없는 {group} 필드: {name}")
            coerced = _coerce_field_value(raw, ftype)
            target = thresholds if group == "thresholds" else params
            if coerced is None:
                target.pop(name, None)  # 기본값으로 복귀
            else:
                target[name] = coerced
        definition.thresholds = thresholds
        definition.params = params
        db.commit()
        return {
            "updated": "definition",
            "definition_id": str(definition.id),
            "scope": "cluster" if definition.cluster_id else "global",
        }

    if item.source_type == CheckMatrixSourceType.addon:
        import json as _json

        addon = _resolve_addon(db, item.source_ref, cluster.id)
        if addon is None:
            raise ValueError(
                f"이 클러스터에 `{item.source_ref}` 애드온이 등록돼 있지 않습니다."
            )
        config = dict(addon.config or {})
        for e in entries:
            if e["group"] != "config":
                raise ValueError(f"애드온은 config 그룹만 수정할 수 있습니다: {e['group']}")
            name, raw = e["name"], (e.get("value") or "").strip()
            if raw == "":
                config.pop(name, None)
                continue
            try:
                config[name] = _json.loads(raw)
            except ValueError:
                config[name] = raw
        addon.config = config
        db.commit()
        return {"updated": "addon", "addon_id": str(addon.id), "scope": "cluster"}

    raise ValueError("core_bundle/manual 항목에는 편집할 소스 설정이 없습니다.")


# ──────────────────────────────────────────────────────────────
# 실행 로그 조회
# ──────────────────────────────────────────────────────────────
def _run_to_dict(run: CheckMatrixRun, *, include_details: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(run.id),
        "batch_id": str(run.batch_id) if run.batch_id else None,
        "item_id": str(run.item_id),
        "cluster_id": str(run.cluster_id),
        "trigger": run.trigger.value if run.trigger else None,
        "triggered_by": run.triggered_by,
        "run_state": run.run_state.value if run.run_state else None,
        "status": run.status.value if run.status else None,
        "value": run.value,
        "message": run.message,
        "error": run.error,
        "duration_ms": run.duration_ms,
        "queued_at": run.queued_at.isoformat() if run.queued_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }
    if include_details:
        details = dict(run.details or {})
        out["steps"] = details.pop("_steps", []) or []
        out["step_plan"] = details.pop("_step_plan", []) or []
        out["commands"] = details.pop("_commands", []) or []
        out["runbook"] = details.pop("_runbook", None)
        out["details"] = details
    return out


def list_runs(
    db: Session,
    *,
    item_id=None,
    cluster_id=None,
    batch_id=None,
    trigger: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    q = db.query(CheckMatrixRun)
    if item_id:
        q = q.filter(CheckMatrixRun.item_id == item_id)
    if cluster_id:
        q = q.filter(CheckMatrixRun.cluster_id == cluster_id)
    if batch_id:
        q = q.filter(CheckMatrixRun.batch_id == batch_id)
    if trigger:
        q = q.filter(CheckMatrixRun.trigger == trigger)
    total = q.count()
    rows = (
        q.order_by(CheckMatrixRun.queued_at.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 200)))
        .all()
    )
    # 이름 조인은 N+1 을 피하려 한 번에 맵으로 만든다.
    item_names = {str(i.id): i.name for i in db.query(CheckMatrixItem).all()}
    cluster_names = {str(c.id): c.name for c in db.query(Cluster).all()}
    runs = []
    for r in rows:
        d = _run_to_dict(r)
        d["item_name"] = item_names.get(str(r.item_id))
        d["cluster_name"] = cluster_names.get(str(r.cluster_id))
        runs.append(d)
    return {"total": total, "limit": limit, "offset": offset, "runs": runs}


def get_run(db: Session, run_id) -> Optional[dict[str, Any]]:
    run = db.query(CheckMatrixRun).filter(CheckMatrixRun.id == run_id).first()
    if run is None:
        return None
    out = _run_to_dict(run, include_details=True)
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == run.item_id).first()
    cluster = db.query(Cluster).filter(Cluster.id == run.cluster_id).first()
    out["item_name"] = item.name if item else None
    out["cluster_name"] = cluster.name if cluster else None
    return out


# ──────────────────────────────────────────────────────────────
# 매분 cron 디스패치 (Celery Beat → run_check_matrix_dispatch 태스크가 호출)
# ──────────────────────────────────────────────────────────────
def _resolve_tz():
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        return ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return ZoneInfo("Asia/Seoul")


def _anchor_naive(last_run_at: Optional[datetime], now_utc: datetime, tz) -> datetime:
    from datetime import timezone as _tz
    raw = last_run_at or (now_utc - timedelta(days=1))
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=_tz.utc)
    return raw.astimezone(tz).replace(tzinfo=None)


def dispatch_due(db: Session, *, jitter_seconds: float = 20.0) -> dict[str, Any]:
    """due 한 core_bundle/cell/definition 을 평가해 **개별 Celery 태스크로 큐잉**한다.

    과거에는 이 함수 자체가(=디스패처 태스크 본체가) due 한 모든 점검을 동기·직렬로
    실행했다 — 클러스터가 여러 개거나 느린 클러스터가 하나만 섞여 있어도 디스패처
    태스크가 ``task_time_limit``(5분) 을 넘겨 SIGKILL 당하고, 그 시점 이후 클러스터의
    점검은 재시도 없이 통째로 유실됐다(``last_run_at`` 은 실행 *전에* 커밋되므로).
    이제 디스패처는 cron 평가 + 큐잉만 하고 수 초 내 끝나며, 실제 실행은
    ``run_check_matrix_core_bundle_one`` / ``_cell_one`` / ``_definition_one`` 개별
    태스크가 각자의 time_limit 안에서 담당한다 — 한 클러스터가 느려도 다른 클러스터
    점검에 영향을 주지 않는다.

    ``jitter_seconds`` 는 동일 분에 due 한 여러 클러스터가 정확히 같은 순간에
    kubectl/K8s API 를 두드리는 thundering herd 를 완화하기 위해 큐잉 시점에 랜덤
    countdown 을 준다(0 이면 즉시 실행).
    """
    from datetime import timezone as _tz

    try:
        from croniter import croniter
    except ImportError:
        return {"dispatched": 0, "reason": "croniter_missing"}

    # lazy import — celery_app 이 이 모듈을 함수 내부에서 import 하는 순환 의존을 피한다.
    from app.celery_app import (
        run_check_matrix_cell_one,
        run_check_matrix_core_bundle_one,
        run_check_matrix_definition_one,
    )

    tz = _resolve_tz()
    now_utc = datetime.now(_tz.utc)
    now_aware = now_utc.astimezone(tz)
    now_naive = now_aware.replace(tzinfo=None)
    check_at = now_utc.replace(tzinfo=None)

    def _countdown() -> float:
        return random.uniform(0, jitter_seconds) if jitter_seconds > 0 else 0

    core_queued = 0
    cell_queued = 0
    errors: list[str] = []

    # 1) core_bundle — Cluster.check_cron_expr (Cluster.status authority 는 여기서만 갱신)
    for cluster in db.query(Cluster).filter(Cluster.check_cron_expr.isnot(None)).all():
        cron_expr = (cluster.check_cron_expr or "").strip()
        if not cron_expr or not croniter.is_valid(cron_expr):
            continue
        anchor = _anchor_naive(cluster.check_last_run_at, now_utc, tz)
        try:
            next_fire = croniter(cron_expr, anchor).get_next(datetime)
        except Exception:  # noqa: BLE001
            continue
        if next_fire > now_naive:
            continue
        cluster.check_last_run_at = check_at
        db.commit()
        try:
            run_check_matrix_core_bundle_one.apply_async(
                args=[str(cluster.id)], countdown=_countdown(),
            )
            core_queued += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"core:{cluster.name}:{str(e)[:150]}")
            logger.exception("check-matrix core dispatch queue failed cluster=%s", cluster.name)

    # 2) deep_check / addon 행 — CheckMatrixSchedule
    schedules = (
        db.query(CheckMatrixSchedule)
        .filter(CheckMatrixSchedule.enabled.is_(True))
        .filter(CheckMatrixSchedule.cron_expr.isnot(None))
        .all()
    )
    for sch in schedules:
        cron_expr = (sch.cron_expr or "").strip()
        if not cron_expr or not croniter.is_valid(cron_expr):
            continue
        anchor = _anchor_naive(sch.last_run_at, now_utc, tz)
        try:
            next_fire = croniter(cron_expr, anchor).get_next(datetime)
        except Exception:  # noqa: BLE001
            continue
        if next_fire > now_naive:
            continue

        item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == sch.item_id).first()
        cluster = db.query(Cluster).filter(Cluster.id == sch.cluster_id).first()
        sch.last_run_at = check_at
        db.commit()
        if item is None or cluster is None:
            continue
        try:
            run_check_matrix_cell_one.apply_async(
                args=[str(item.id), str(cluster.id)], countdown=_countdown(),
            )
            cell_queued += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"cell:{item.name}:{cluster.name}:{str(e)[:150]}")
            logger.exception(
                "check-matrix cell dispatch queue failed item=%s cluster=%s", item.name, cluster.name,
            )

    # 3) DeepCheckDefinition.schedule_cron — 정의별 단독 cron (custom_* 정의의 주 스케줄).
    #    글로벌 정의(cluster_id NULL)는 전체 클러스터 대상으로 실행한다.
    definition_queued = 0
    due_defs = (
        db.query(DeepCheckDefinition)
        .filter(DeepCheckDefinition.enabled.is_(True))
        .filter(DeepCheckDefinition.schedule_cron.isnot(None))
        .all()
    )
    for d in due_defs:
        cron_expr = (d.schedule_cron or "").strip()
        if not cron_expr or not croniter.is_valid(cron_expr):
            continue
        anchor = _anchor_naive(d.last_run_at, now_utc, tz)
        try:
            next_fire = croniter(cron_expr, anchor).get_next(datetime)
        except Exception:  # noqa: BLE001
            continue
        if next_fire > now_naive:
            continue
        d.last_run_at = check_at
        db.commit()

        if d.cluster_id is not None:
            targets = db.query(Cluster).filter(Cluster.id == d.cluster_id).all()
        else:
            targets = db.query(Cluster).all()
        for cluster in targets:
            try:
                run_check_matrix_definition_one.apply_async(
                    args=[str(d.id), str(cluster.id)], countdown=_countdown(),
                )
                definition_queued += 1
            except Exception as e:  # noqa: BLE001
                errors.append(f"definition:{d.name}:{cluster.name}:{str(e)[:150]}")
                logger.exception(
                    "check-matrix definition dispatch queue failed def=%s cluster=%s", d.name, cluster.name,
                )

    return {
        "mode": "fan_out",
        "core_fired": core_queued,
        "cell_fired": cell_queued,
        "definition_fired": definition_queued,
        "errors": errors,
        "executed_at": now_aware.isoformat(),
    }


# ──────────────────────────────────────────────────────────────
# 리텐션 정리 (일 1회 Celery Beat)
# ──────────────────────────────────────────────────────────────
def purge_expired_logs(db: Session, *, max_batches: int = 50, batch_size: int = 5000) -> dict[str, Any]:
    """task_time_limit(5분) 보호 — 청크 단위 삭제 + 배치 상한."""
    retention_days = get_settings(db)["retention_days"]
    cutoff = datetime.utcnow() - timedelta(days=retention_days)

    def _purge(model, ts_col) -> int:
        deleted = 0
        for _ in range(max_batches):
            ids = [
                row[0]
                for row in db.query(model.id).filter(ts_col < cutoff).limit(batch_size).all()
            ]
            if not ids:
                break
            db.query(model).filter(model.id.in_(ids)).delete(synchronize_session=False)
            db.commit()
            deleted += len(ids)
            if len(ids) < batch_size:
                break
        return deleted

    # 실행 로그(runs)는 details 에 명령 출력 발췌를 담아 행이 크므로 값 이력과 함께 정리한다.
    total_deleted = _purge(CheckMatrixResultLog, CheckMatrixResultLog.checked_at)
    runs_deleted = _purge(CheckMatrixRun, CheckMatrixRun.queued_at)
    return {
        "retention_days": retention_days,
        "deleted": total_deleted,
        "runs_deleted": runs_deleted,
    }


# ──────────────────────────────────────────────────────────────
# 기본 항목 시드 (main.py lifespan, 테이블 비어있을 때만)
# ──────────────────────────────────────────────────────────────
def seed_default_items(db: Session) -> int:
    if db.query(CheckMatrixItem).count() > 0:
        return 0

    added = 0
    sort_order = 0

    db.add(CheckMatrixItem(
        name=CORE_BUNDLE_ITEM_NAME,
        description=(
            "DailyChecker 원자 실행(API 서버/컴포넌트/노드/시스템파드) 결과 중 API 응답시간 투영. "
            "cron 은 클러스터 열 헤더에서 설정(Cluster.status 산정과 직결 — 삭제 불가)."
        ),
        unit="ms",
        source_type=CheckMatrixSourceType.core_bundle,
        source_ref=None,
        is_system=True,
        sort_order=sort_order,
    ))
    sort_order += 10
    added += 1

    from app.services.deep_checkers import REGISTRY
    from app.services.deep_checkers.registry import get_cell_value_unit
    for check_type, (_, spec) in REGISTRY.items():
        # custom_* 템플릿형 타입은 check_type→정의 1:1 매핑이 성립하지 않으므로 매트릭스 제외.
        if not getattr(spec, "seed_default", True):
            continue
        db.add(CheckMatrixItem(
            name=spec.display_name,
            description=spec.description,
            unit=get_cell_value_unit(check_type),
            source_type=CheckMatrixSourceType.deep_check,
            source_ref=check_type,
            is_system=False,
            sort_order=sort_order,
        ))
        sort_order += 10
        added += 1

    addon_types = sorted({row[0] for row in db.query(Addon.type).distinct().all() if row[0]})
    for addon_type in addon_types:
        db.add(CheckMatrixItem(
            name=_ADDON_LABELS.get(addon_type, addon_type),
            source_type=CheckMatrixSourceType.addon,
            source_ref=addon_type,
            is_system=False,
            sort_order=sort_order,
        ))
        sort_order += 10
        added += 1

    db.commit()
    return added


def backfill_item_units(db: Session) -> int:
    """기존 DB 의 deep_check 행에 셀 값 단위를 보강한다 (idempotent — unit 이 빈 행만).

    seed 는 테이블이 비어 있을 때만 돌기 때문에, 단위 도입 이전에 시드된 설치본은
    unit 없이 남아 값이 `361` 처럼 단위 없이 표시된다. 매 부팅 시 호출해도 안전하다.
    운영자가 unit 을 직접 지운 행까지 다시 채우지는 않는다 — NULL/'' 만 대상.
    """
    from app.services.deep_checkers.registry import CELL_VALUE_SPECS

    updated = 0
    rows = (
        db.query(CheckMatrixItem)
        .filter(CheckMatrixItem.source_type == CheckMatrixSourceType.deep_check)
        .all()
    )
    for row in rows:
        if row.unit:
            continue
        entry = CELL_VALUE_SPECS.get(row.source_ref or "")
        if entry and entry[0]:
            row.unit = entry[0]
            updated += 1
    if updated:
        db.commit()
    return updated


def seed_default_schedules(db: Session) -> int:
    """시드 직후 1회 — deep_check 행 중 REGISTRY.default_enabled=True 인 항목만
    기존 +15분 오프셋 cron 으로 클러스터마다 활성화(기존 자동 실행 동작 보존).
    addon 행은 기존에도 자동 cron 이 없었으므로 스케줄을 만들지 않는다(수동 트리거만).
    """
    from app.services.deep_checkers import REGISTRY

    items = (
        db.query(CheckMatrixItem)
        .filter(CheckMatrixItem.source_type == CheckMatrixSourceType.deep_check)
        .all()
    )
    if not items:
        return 0
    clusters = db.query(Cluster).all()
    if not clusters:
        return 0

    existing = {(str(s.item_id), str(s.cluster_id)) for s in db.query(CheckMatrixSchedule).all()}
    added = 0
    for item in items:
        entry = REGISTRY.get(item.source_ref)
        default_enabled = bool(entry[1].default_enabled) if entry else True
        if not default_enabled:
            continue
        for cluster in clusters:
            key = (str(item.id), str(cluster.id))
            if key in existing:
                continue
            db.add(CheckMatrixSchedule(
                item_id=item.id,
                cluster_id=cluster.id,
                cron_expr="15 9,13,18 * * *",
                enabled=True,
            ))
            added += 1
    if added:
        db.commit()
    return added
