"""서버 오류 조회 — admin only. 화면 오류 토스트의 "요청 ID" 로 원인(스택·파드·버전)을 찾는다."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.system_error_log import SystemErrorLog
from app.models.user import User

router = APIRouter(prefix="/system-errors", tags=["system-errors"])


def _out(r: SystemErrorLog) -> dict[str, Any]:
    return {
        "id": r.id,
        "request_id": r.request_id,
        "method": r.method,
        "path": r.path,
        "status_code": r.status_code,
        "username": r.username,
        "pod": r.pod,
        "app_version": r.app_version,
        "error_type": r.error_type,
        "message": r.message,
        "traceback": r.traceback,
        "duration_ms": r.duration_ms,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("")
def list_system_errors(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
    request_id: str | None = Query(None, max_length=64, description="요청 ID — 앞부분만 넣어도 찾는다"),
    path: str | None = Query(None, max_length=200, description="경로에 포함된 문자열"),
    status_code: int | None = Query(None, ge=500, le=599),
    date_from: datetime | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """최근 서버 오류 목록. ``request_id`` 를 주면 같은 요청이 남긴 감사 로그도 함께 돌려준다."""
    q = db.query(SystemErrorLog)
    rid = (request_id or "").strip()
    if rid:
        q = q.filter(SystemErrorLog.request_id.like(rid.replace("%", "").replace("_", r"\_") + "%"))
    if path:
        q = q.filter(SystemErrorLog.path.contains(path.strip()))
    if status_code:
        q = q.filter(SystemErrorLog.status_code == status_code)
    if date_from:
        q = q.filter(SystemErrorLog.created_at >= date_from)
    total = q.count()
    rows = (
        q.order_by(SystemErrorLog.created_at.desc())
        .offset((page - 1) * page_size).limit(page_size).all()
    )
    related_audit: list[dict[str, Any]] = []
    if rid:
        try:
            audits = (
                db.query(AuditLog)
                .filter(AuditLog.details["request_id"].astext.like(rid.replace("%", "") + "%"))
                .order_by(AuditLog.created_at.desc()).limit(20).all()
            )
            related_audit = [{
                "id": a.id, "action": a.action, "status": a.status, "actor_username": a.actor_username,
                "target_type": a.target_type, "target_id": a.target_id,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            } for a in audits]
        except Exception:  # noqa: BLE001 — 부가 정보라 실패해도 목록은 돌려준다
            db.rollback()
    return {
        "total": total, "page": page, "page_size": page_size,
        "items": [_out(r) for r in rows],
        "related_audit": related_audit,
    }
