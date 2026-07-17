from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class VocCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: Optional[str] = None
    category: str = Field(default="문의", pattern="^(문의|개선|불만|제안)$")


class VocUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = None
    category: Optional[str] = Field(None, pattern="^(문의|개선|불만|제안)$")


class VocReply(BaseModel):
    """관리자 답변 / 상태 변경."""
    admin_reply: Optional[str] = None
    status: Optional[str] = Field(None, pattern="^(접수|검토중|완료)$")


class VocResponse(BaseModel):
    id: str
    title: str
    content: Optional[str] = None
    category: str
    status: str
    author: Optional[str] = None
    created_by: Optional[str] = None
    admin_reply: Optional[str] = None
    admin_reply_by: Optional[str] = None
    admin_reply_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class VocListResponse(BaseModel):
    data: list[VocResponse]
    total: int
