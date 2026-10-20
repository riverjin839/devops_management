from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

SprintStatus = str  # planning / active / completed


class SprintBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    goal: Optional[str] = None
    jira_no: Optional[str] = Field(None, max_length=100)
    confluence_link: Optional[str] = Field(None, max_length=500)
    start_date: date
    end_date: date
    status: SprintStatus = "active"


class SprintCreate(SprintBase):
    pass


class SprintUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    goal: Optional[str] = None
    jira_no: Optional[str] = Field(None, max_length=100)
    confluence_link: Optional[str] = Field(None, max_length=500)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    status: Optional[SprintStatus] = None

    # D-144 — 부분 수정(exclude_unset)에서 `null` 은 "값 비우기"다. 목표·JIRA NO·Confluence 는 null 로
    # 비우고, NOT NULL 컬럼(이름·기간·상태)에 null 이 오면 500 대신 422 로 거부한다.
    @field_validator("name", "start_date", "end_date", "status")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class SprintResponse(SprintBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    # computed stats (router 가 채움)
    total_items: int = 0
    done_items: int = 0
    achievement_rate: float = 0.0
    total_effort_hours: int = 0
    assignees: list[str] = []

    class Config:
        from_attributes = True


class SprintListResponse(BaseModel):
    data: list[SprintResponse]
    total: int
