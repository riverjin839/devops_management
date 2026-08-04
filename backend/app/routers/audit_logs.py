"""감사 로그 조회 — admin only."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.auth.deps import require_admin
from app.schemas.audit_log import AuditLogListResponse, AuditLogOut


router = APIRouter(prefix="/audit-logs", tags=["audit-logs"])


@router.get("", response_model=AuditLogListResponse)
def list_audit_logs(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    action: str | None = Query(None),
    action_prefix: str | None = Query(
        None, description="액션 패밀리 필터 — 예: 'batch_job.' 이면 batch_job.* 전부"
    ),
    target_type: str | None = Query(None),
    actor_username: str | None = Query(None),
    status: str | None = Query(None),
    date_from: datetime | None = Query(None),
    date_to: datetime | None = Query(None),
):
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    elif action_prefix:
        # LIKE 와일드카드 이스케이프 — 사용자가 % / _ 를 넣어도 리터럴로 매칭
        escaped = action_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        q = q.filter(AuditLog.action.like(f"{escaped}%", escape="\\"))
    if target_type:
        q = q.filter(AuditLog.target_type == target_type)
    if actor_username:
        q = q.filter(AuditLog.actor_username == actor_username)
    if status:
        q = q.filter(AuditLog.status == status)
    if date_from:
        q = q.filter(AuditLog.created_at >= date_from)
    if date_to:
        q = q.filter(AuditLog.created_at <= date_to)
    total = q.count()
    rows = (
        q.order_by(AuditLog.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return AuditLogListResponse(
        items=[AuditLogOut.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )
