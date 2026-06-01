from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field

ProjectStatus = str  # active / completed / paused


class ProjectBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    goal: Optional[str] = None
    color: str = Field("blue", max_length=20)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    status: ProjectStatus = "active"


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    goal: Optional[str] = None
    color: Optional[str] = Field(None, max_length=20)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    status: Optional[ProjectStatus] = None


class ProjectResponse(ProjectBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    # computed stats (populated by router)
    total_items: int = 0
    done_items: int = 0
    achievement_rate: float = 0.0
    assignees: list[str] = []

    class Config:
        from_attributes = True


class ProjectListResponse(BaseModel):
    data: list[ProjectResponse]
    total: int
