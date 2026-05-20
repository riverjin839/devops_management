from datetime import datetime
from typing import Any

from pydantic import BaseModel


class AuditLogOut(BaseModel):
    id: str
    actor_user_id: str | None = None
    actor_username: str
    action: str
    target_type: str | None = None
    target_id: str | None = None
    status: str
    ip: str | None = None
    user_agent: str | None = None
    details: dict[str, Any] | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class AuditLogListResponse(BaseModel):
    items: list[AuditLogOut]
    total: int
    page: int
    page_size: int
