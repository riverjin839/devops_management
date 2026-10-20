from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

ScriptLanguage = Literal["bash", "python"]


class SavedScriptBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    language: ScriptLanguage = "bash"
    content: str = Field(..., min_length=1)
    description: Optional[str] = Field(default=None, max_length=500)


class SavedScriptCreate(SavedScriptBase):
    pass


class SavedScriptUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    language: Optional[ScriptLanguage] = None
    content: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = Field(default=None, max_length=500)

    # D-162 — 부분 수정(exclude_unset)에서 `null` 은 "값 비우기"다. 설명(nullable)은 null 로 비우고,
    # NOT NULL 컬럼(이름·언어·본문)에 null 이 오면 500(IntegrityError) 대신 422 로 거부한다.
    @field_validator("name", "language", "content")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class SavedScriptResponse(SavedScriptBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
