from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

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
