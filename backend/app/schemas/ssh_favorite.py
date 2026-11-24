from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

RunMode = Literal["insert", "run"]


class SshFavoriteCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    command: str = Field(..., min_length=1, max_length=8000)
    run_mode: RunMode = "insert"


class SshFavoriteUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    command: Optional[str] = Field(default=None, min_length=1, max_length=8000)
    run_mode: Optional[RunMode] = None

    # 부분 수정(exclude_unset)에서 NOT NULL 컬럼에 null 이 오면 500 대신 422 (saved_script 와 같은 규칙).
    @field_validator("name", "command", "run_mode")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class SshFavoriteReorder(BaseModel):
    ids: list[UUID] = Field(..., min_length=1, max_length=500)


class SshFavoriteResponse(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = None
    command: str
    run_mode: RunMode
    sort_order: int
    preset_key: Optional[str] = None
    # 기본 명령인데 기본값과 이름·설명·명령·누름 동작 중 하나라도 다르면 True.
    modified: bool = False
    created_at: datetime
    updated_at: datetime
