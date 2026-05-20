"""감사 로그 기록 헬퍼.

내부 try/except 로 감싸 호출부를 깨뜨리지 않는다 — 감사 로그 기록 실패가
실제 비즈니스 동작 (로그인, 클러스터 삭제 등) 을 막아선 안 된다.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.user import User

_log = logging.getLogger("k8s_monitor.audit")


def _extract_client(request: Request | None) -> tuple[str | None, str | None]:
    if request is None:
        return None, None
    ip: str | None = None
    try:
        # X-Forwarded-For (proxy/ingress 뒤일 때) 우선, 없으면 client.host
        xff = request.headers.get("x-forwarded-for")
        if xff:
            ip = xff.split(",")[0].strip()[:64] or None
        elif request.client:
            ip = request.client.host[:64]
    except Exception:  # noqa: BLE001
        ip = None
    ua: str | None = None
    try:
        raw_ua = request.headers.get("user-agent")
        ua = raw_ua[:255] if raw_ua else None
    except Exception:  # noqa: BLE001
        ua = None
    return ip, ua


def record(
    db: Session,
    *,
    action: str,
    actor: User | None = None,
    actor_username: str | None = None,
    status: str = "success",
    target_type: str | None = None,
    target_id: str | Any | None = None,
    details: dict[str, Any] | None = None,
    request: Request | None = None,
) -> None:
    """감사 로그 한 행 기록. 실패해도 호출부를 막지 않는다."""
    try:
        ip, ua = _extract_client(request)
        username = actor.username if actor is not None else (actor_username or "-")
        entry = AuditLog(
            actor_user_id=actor.id if actor is not None else None,
            actor_username=(username or "-")[:64],
            action=action[:64],
            target_type=target_type[:32] if target_type else None,
            target_id=None if target_id is None else str(target_id)[:64],
            status=(status or "success")[:16],
            ip=ip,
            user_agent=ua,
            details=details,
        )
        db.add(entry)
        db.commit()
    except Exception as e:  # noqa: BLE001
        _log.warning("audit: failed to record action=%s status=%s — %s", action, status, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
