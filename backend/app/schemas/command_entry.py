from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator


Importance = Literal["info", "low", "medium", "high", "critical"]


class CommandEntryBase(BaseModel):
    category: Optional[str] = Field(default=None, max_length=50)
    command: str = Field(..., min_length=1)
    description: Optional[str] = None
    caution: Optional[str] = None
    importance: Importance = "medium"
    examples: Optional[str] = None
    tags: Optional[str] = Field(default=None, max_length=255)
    pinned: bool = False
    sort_order: int = 1000
    author: Optional[str] = Field(default=None, max_length=100)
    confluence_url: Optional[str] = Field(default=None, max_length=2048)


class CommandEntryCreate(CommandEntryBase):
    pass


class CommandEntryUpdate(BaseModel):
    category: Optional[str] = Field(default=None, max_length=50)
    command: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    caution: Optional[str] = None
    importance: Optional[Importance] = None
    examples: Optional[str] = None
    tags: Optional[str] = Field(default=None, max_length=255)
    pinned: Optional[bool] = None
    sort_order: Optional[int] = None
    author: Optional[str] = Field(default=None, max_length=100)
    confluence_url: Optional[str] = Field(default=None, max_length=2048)

    # D-144 — 부분 수정(exclude_unset)에서 `null` 은 "값 비우기"다. 카테고리·의미·주의사항·예시·태그·
    # Confluence 는 null 로 비우고, NOT NULL 컬럼에 null 이 오면 500 대신 422 로 거부한다.
    @field_validator("command", "importance", "pinned", "sort_order")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class CommandEntryResponse(CommandEntryBase):
    id: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CommandEntryListResponse(BaseModel):
    data: list[CommandEntryResponse]
    total: int
