"""ServiceCategory Pydantic schemas."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$")
_DOMAINS = {"pep", "app"}


def _validate_key(v: str) -> str:
    v = v.strip().lower()
    if not _SLUG_RE.match(v):
        raise ValueError("key 는 영문 소문자/숫자/하이픈 1-50자 (시작/끝은 알파뉴메릭)")
    return v


def _validate_domain(v: str) -> str:
    v = v.strip().lower()
    if v not in _DOMAINS:
        raise ValueError(f"domain 은 {sorted(_DOMAINS)} 중 하나여야 합니다")
    return v


class ServiceCategoryCreate(BaseModel):
    """POST /service-categories."""
    domain: str = Field(default="pep", max_length=10)
    key: str = Field(..., min_length=1, max_length=50)
    label: str = Field(..., min_length=1, max_length=100)
    icon: Optional[str] = Field(None, max_length=64)
    enabled: bool = True
    sort_order: int = Field(default=100, ge=0, le=10000)

    @field_validator("domain")
    @classmethod
    def _domain(cls, v: str) -> str:
        return _validate_domain(v)

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        return _validate_key(v)


class ServiceCategoryUpdate(BaseModel):
    """PUT /service-categories/{id} — builtin 은 label/icon/enabled/sort_order 만 의미.
    key/domain 변경은 builtin 에 대해 router 가 거부."""
    label: Optional[str] = Field(None, min_length=1, max_length=100)
    icon: Optional[str] = Field(None, max_length=64)
    enabled: Optional[bool] = None
    sort_order: Optional[int] = Field(None, ge=0, le=10000)


class ServiceCategoryResponse(BaseModel):
    id: UUID
    domain: str
    key: str
    label: str
    icon: Optional[str] = None
    is_builtin: bool
    enabled: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ServiceCategoryListResponse(BaseModel):
    data: list[ServiceCategoryResponse]
    total: int
    offset: int = 0
    limit: int = 0
    has_more: bool = False
