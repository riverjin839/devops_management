from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

WorkItemType = Literal["task", "issue", "meeting", "training", "etc"]
KanbanStatus = Literal["backlog", "todo", "in_progress", "review_test", "done"]
Priority = Literal["high", "medium", "low"]
ModuleName = Literal[
    "k8s", "keycloak", "nexus", "cilium", "argocd", "jenkins",
    "backend", "frontend", "monitoring", "infra",
]
TypeLabel = Literal["feature", "bug", "chore", "docs", "security"]


class WorkItemBase(BaseModel):
    type: WorkItemType

    # 담당자
    assignee: str = Field(..., min_length=1, max_length=100)
    primary_assignee: str = Field(..., min_length=1, max_length=100)
    secondary_assignee: Optional[str] = Field(None, min_length=1, max_length=100)

    # 클러스터
    cluster_id: Optional[UUID] = None
    cluster_name: Optional[str] = Field(None, max_length=100)

    # 공통 의미
    category: str = Field(..., min_length=1, max_length=100)
    content: str = Field(..., min_length=1)
    resolution: Optional[str] = None
    started_at: datetime
    closed_at: Optional[datetime] = None

    remarks: Optional[str] = None
    service: Optional[str] = Field(None, max_length=64)
    confluence_url: Optional[str] = Field(None, max_length=2048)

    # Issue 전용
    detail_content: Optional[str] = None

    # Task 전용
    priority: Priority = "medium"
    kanban_status: KanbanStatus = "todo"
    module: Optional[ModuleName] = None
    type_label: Optional[TypeLabel] = None
    effort_hours: Optional[int] = Field(None, ge=1, le=999)
    done_condition: Optional[str] = None
    parent_id: Optional[UUID] = None
    related_work_item_id: Optional[UUID] = None


class WorkItemCreate(WorkItemBase):
    pass


class WorkItemUpdate(BaseModel):
    # type 은 생성 시 정하고 변경 불가 (별도 엔드포인트로만 변환 허용하는 정책)
    assignee: Optional[str] = Field(None, min_length=1, max_length=100)
    primary_assignee: Optional[str] = Field(None, min_length=1, max_length=100)
    secondary_assignee: Optional[str] = Field(None, min_length=1, max_length=100)
    cluster_id: Optional[UUID] = None
    cluster_name: Optional[str] = Field(None, max_length=100)
    category: Optional[str] = Field(None, min_length=1, max_length=100)
    content: Optional[str] = Field(None, min_length=1)
    resolution: Optional[str] = None
    started_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    remarks: Optional[str] = None
    service: Optional[str] = Field(None, max_length=64)
    confluence_url: Optional[str] = Field(None, max_length=2048)
    detail_content: Optional[str] = None
    priority: Optional[Priority] = None
    kanban_status: Optional[KanbanStatus] = None
    module: Optional[ModuleName] = None
    type_label: Optional[TypeLabel] = None
    effort_hours: Optional[int] = Field(None, ge=1, le=999)
    done_condition: Optional[str] = None
    related_work_item_id: Optional[UUID] = None


class WorkItemStatusPatch(BaseModel):
    """칸반 컬럼 이동 전용 (PATCH /work-items/{id}/status)"""
    kanban_status: KanbanStatus


class WorkItemResponse(WorkItemBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    subtasks: list["WorkItemResponse"] = []

    class Config:
        from_attributes = True

    @model_validator(mode="before")
    @classmethod
    def _drop_circular_subtask_children(cls, data):
        # ORM 객체에서 직렬화될 때 무한 재귀를 방지하기 위해 subtask 자체의 subtasks
        # 는 비운다. (1레벨 nested 만 노출 — 기존 TaskResponse 와 동일 정책)
        return data


class WorkItemStatusResponse(BaseModel):
    """칸반 상태 변경 응답 — WIP 초과 경고 포함"""
    data: WorkItemResponse
    wip_warning: bool = False


class WorkItemListResponse(BaseModel):
    data: list[WorkItemResponse]
    total: int


WorkItemResponse.model_rebuild()
