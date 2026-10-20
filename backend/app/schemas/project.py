from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

ProjectStatus = str  # active / completed / paused


class ProjectBase(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
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
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    goal: Optional[str] = None
    color: Optional[str] = Field(None, max_length=20)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    status: Optional[ProjectStatus] = None

    # D-162: 선택 필드(설명·목표·시작일·종료일·테넌트)는 명시적 null 로 비울 수 있다(키 생략 = 유지).
    # 필수 컬럼(이름·색·상태)은 null 로 비울 수 없다 — DB NOT NULL 위반 500 대신 422.
    @field_validator("name", "color", "status")
    @classmethod
    def _required_not_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


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
