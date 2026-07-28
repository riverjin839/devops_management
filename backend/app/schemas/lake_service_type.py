"""LakeServiceType Pydantic schemas."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$")


def _validate_slug(v: str) -> str:
    v = v.strip().lower()
    if not _SLUG_RE.match(v):
        raise ValueError("service_type 은 영문 소문자/숫자/하이픈 1-32자 (시작/끝은 알파뉴메릭)")
    return v


def _validate_path(v: str) -> str:
    v = v.strip()
    if not v.startswith("/"):
        raise ValueError("default_path 는 '/' 로 시작해야 합니다")
    return v


class LakeServiceTypeCreate(BaseModel):
    """POST /lake-service-types — custom type 만 (is_builtin 강제 false)."""
    service_type: str = Field(..., min_length=1, max_length=32)
    label: str = Field(..., min_length=1, max_length=100)
    category: str = Field(default="other", max_length=20)
    default_path: str = Field(default="/health", min_length=1, max_length=255)
    description: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=64)
    color: Optional[str] = Field(None, max_length=20)
    enabled: bool = True
    sort_order: int = Field(default=100, ge=0, le=10000)
    # PEP/APP 서비스 사이드바 2단 네비게이션용 — domain(pep|app) + 상위 카테고리 FK
    domain: str = Field(default="pep", max_length=10)
    category_id: Optional[UUID] = None

    @field_validator("service_type")
    @classmethod
    def _slug(cls, v: str) -> str:
        return _validate_slug(v)

    @field_validator("default_path")
    @classmethod
    def _path(cls, v: str) -> str:
        return _validate_path(v)


class LakeServiceTypeUpdate(BaseModel):
    """PUT /lake-service-types/{id} — builtin 은 enabled/sort_order/description/icon/category_id 만 의미.
    label/category/default_path/domain 변경은 builtin 에 대해 router 가 거부."""
    label: Optional[str] = Field(None, min_length=1, max_length=100)
    category: Optional[str] = Field(None, max_length=20)
    default_path: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=64)
    color: Optional[str] = Field(None, max_length=20)
    enabled: Optional[bool] = None
    sort_order: Optional[int] = Field(None, ge=0, le=10000)
    domain: Optional[str] = Field(None, max_length=10)
    category_id: Optional[UUID] = None

    @field_validator("default_path")
    @classmethod
    def _path(cls, v: Optional[str]) -> Optional[str]:
        return _validate_path(v) if v else None


class LakeServiceTypeToggle(BaseModel):
    """PATCH /lake-service-types/{id}/enabled — 토글 편의."""
    enabled: bool


class LakeServiceTypeResponse(BaseModel):
    id: UUID
    service_type: str
    label: str
    category: str
    default_path: str
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    is_builtin: bool
    enabled: bool
    sort_order: int
    domain: str
    category_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class LakeServiceTypeListResponse(BaseModel):
    """List 응답 — 직전 사이클 baseline (offset/limit/has_more) 패턴."""
    data: list[LakeServiceTypeResponse]
    total: int
    offset: int = 0
    limit: int = 0
    has_more: bool = False
