from datetime import datetime
from typing import Optional
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class OpsNoteCreate(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    service: str = Field(..., min_length=1, max_length=50)
    title: str = Field(..., min_length=1, max_length=200)
    content: Optional[str] = None
    back_content: Optional[str] = None
    color: str = Field(default="yellow", pattern="^(yellow|green|blue|pink|purple)$")
    author: Optional[str] = Field(None, max_length=100)
    pinned: bool = False
    confluence_url: Optional[str] = Field(None, max_length=2048)
    dl_url: Optional[str] = Field(None, max_length=2048)


class OpsNoteUpdate(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    service: Optional[str] = Field(None, min_length=1, max_length=50)
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = None
    back_content: Optional[str] = None
    color: Optional[str] = Field(None, pattern="^(yellow|green|blue|pink|purple)$")
    author: Optional[str] = Field(None, max_length=100)
    pinned: Optional[bool] = None
    confluence_url: Optional[str] = Field(None, max_length=2048)
    dl_url: Optional[str] = Field(None, max_length=2048)

    # D-144 — 부분 수정(exclude_unset)에서 `null` 은 "값 비우기"다. 본문·답변·작성자·링크처럼
    # nullable 컬럼은 null 로 비우고, NOT NULL 컬럼에 null 이 오면 500(IntegrityError) 대신 422 로 거부한다.
    @field_validator("service", "title", "color", "pinned")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class OpsNoteResponse(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    id: str
    service: str
    title: str
    content: Optional[str] = None
    back_content: Optional[str] = None
    color: str
    author: Optional[str] = None
    pinned: bool
    confluence_url: Optional[str] = None
    dl_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OpsNoteListResponse(BaseModel):
    data: list[OpsNoteResponse]
    total: int
