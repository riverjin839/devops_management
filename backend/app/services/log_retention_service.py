"""로그성 테이블 리텐션 정리 — 무한 증가 방지.

``check_matrix_result_logs``/``deep_check_results`` 는 이미 각자 도메인 서비스
(``check_matrix_service.purge_expired_logs`` / ``deep_check_service.purge_expired_results``)
에 청크 삭제 purge 가 있다. 이 모듈은 그 패턴을 나머지 로그성 테이블에도 동일하게
적용한다 — ``daily_check_logs``/``check_logs``/``k8s_events``/``user_notifications`` 는
지금까지 purge 대상이 아니어서 무기한 증가했고, ``audit_logs`` 는 감사 추적 목적상
더 긴 기간을 둔다.

보관 일수는 테이블 성격에 따라 하드코딩한다(운영자가 조정하려면 이 상수만 바꾸면
됨) — check_matrix/deep_check 의 사용자 설정 가능한 ``retention_days`` 와는 별개다
(그쪽은 "점검 이력 조회 기간"이라는 다른 목적의 UI 설정).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.check_log import CheckLog
from app.models.daily_check import DailyCheckLog
from app.models.k8s_event import K8sEvent
from app.models.user_notification import UserNotification

# daily_check_logs/check_logs 는 점검 이력 조회 UX 를 감안해 90일, k8s_events 는
# 변경 이벤트라 회전이 빨라 21일, audit_logs 는 감사 추적 목적상 1년,
# user_notifications 는 알림 배지 성격이라 90일이면 충분하다.
RETENTION_DAYS: dict[str, int] = {
    "daily_check_logs": 90,
    "check_logs": 90,
    "k8s_events": 21,
    "audit_logs": 365,
    "user_notifications": 90,
}

_MAX_BATCHES = 50
_BATCH_SIZE = 5000


def _purge_simple(db: Session, model, ts_column, retention_days: int) -> int:
    """자식 FK 참조가 없는 테이블용 — 청크 단위 삭제 + 배치 상한
    (check_matrix_service.purge_expired_logs 와 동일 패턴)."""
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    total_deleted = 0
    for _ in range(_MAX_BATCHES):
        ids = [
            row[0]
            for row in db.query(model.id).filter(ts_column < cutoff).limit(_BATCH_SIZE).all()
        ]
        if not ids:
            break
        db.query(model).filter(model.id.in_(ids)).delete(synchronize_session=False)
        db.commit()
        total_deleted += len(ids)
        if len(ids) < _BATCH_SIZE:
            break
    return total_deleted


def _purge_daily_check_logs(db: Session, retention_days: int) -> int:
    """``daily_check_logs`` 청크 삭제.

    ``deep_check_results.daily_check_log_id`` / ``notification_logs.daily_check_log_id``
    가 이 테이블을 참조하지만(FK, ondelete 없음, nullable) 각자 별도 리텐션을 가지므로,
    삭제 대상 배치의 참조만 먼저 NULL 처리해 FK 위반 없이 안전하게 지운다(참조하는
    행 자체는 보존 — 그쪽은 자기 리텐션에 따라 별도로 정리된다).
    """
    from app.models.deep_check import DeepCheckResult, NotificationLog

    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    total_deleted = 0
    for _ in range(_MAX_BATCHES):
        ids = [
            row[0]
            for row in db.query(DailyCheckLog.id)
            .filter(DailyCheckLog.check_date < cutoff)
            .limit(_BATCH_SIZE)
            .all()
        ]
        if not ids:
            break
        db.query(DeepCheckResult).filter(DeepCheckResult.daily_check_log_id.in_(ids)).update(
            {"daily_check_log_id": None}, synchronize_session=False,
        )
        db.query(NotificationLog).filter(NotificationLog.daily_check_log_id.in_(ids)).update(
            {"daily_check_log_id": None}, synchronize_session=False,
        )
        db.query(DailyCheckLog).filter(DailyCheckLog.id.in_(ids)).delete(synchronize_session=False)
        db.commit()
        total_deleted += len(ids)
        if len(ids) < _BATCH_SIZE:
            break
    return total_deleted


def purge_all(db: Session) -> dict[str, Any]:
    """모든 로그성 테이블을 순회하며 개별 try/except 로 격리 정리.

    한 테이블 실패가 나머지 테이블 정리를 막지 않도록 fault-tolerant 하게 처리한다
    (backup_service 의 per-table 격리 컨벤션과 동일).
    """
    results: dict[str, Any] = {}

    try:
        deleted = _purge_daily_check_logs(db, RETENTION_DAYS["daily_check_logs"])
        results["daily_check_logs"] = {
            "deleted": deleted, "retention_days": RETENTION_DAYS["daily_check_logs"],
        }
    except Exception as e:  # noqa: BLE001
        db.rollback()
        results["daily_check_logs"] = {"error": str(e)[:200]}

    simple_targets = [
        ("check_logs", CheckLog, CheckLog.checked_at),
        ("k8s_events", K8sEvent, K8sEvent.received_at),
        ("audit_logs", AuditLog, AuditLog.created_at),
        ("user_notifications", UserNotification, UserNotification.created_at),
    ]
    for name, model, ts_column in simple_targets:
        try:
            deleted = _purge_simple(db, model, ts_column, RETENTION_DAYS[name])
            results[name] = {"deleted": deleted, "retention_days": RETENTION_DAYS[name]}
        except Exception as e:  # noqa: BLE001
            db.rollback()
            results[name] = {"error": str(e)[:200]}

    return results
