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

    # 클러스터 — cluster_id 는 대표(첫 번째). cluster_ids 가 다중 대상 전체.
    cluster_id: Optional[UUID] = None
    cluster_name: Optional[str] = Field(None, max_length=100)
    cluster_ids: Optional[list[UUID]] = None

    # 프로젝트 소속 (nullable)
    project_id: Optional[UUID] = None

    # 공통 의미
    title: Optional[str] = Field(None, max_length=200)
    category: str = Field(..., min_length=1, max_length=100)
    content: str = Field(..., min_length=1)
    resolution: Optional[str] = None
    started_at: datetime
    closed_at: Optional[datetime] = None

    remarks: Optional[str] = None
    service: Optional[str] = Field(None, max_length=64)
    # Phase B — service 하위 component (예: k8s→api-server). frontend COMPONENT_BY_SERVICE 추천.
    component: Optional[str] = Field(None, max_length=64)
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
    cluster_ids: Optional[list[UUID]] = None
    project_id: Optional[UUID] = None
    title: Optional[str] = Field(None, max_length=200)
    category: Optional[str] = Field(None, min_length=1, max_length=100)
    content: Optional[str] = Field(None, min_length=1)
    resolution: Optional[str] = None
    started_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    remarks: Optional[str] = None
    service: Optional[str] = Field(None, max_length=64)
    component: Optional[str] = Field(None, max_length=64)
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
    cluster_names: Optional[list[str]] = None   # cluster_ids 와 1:1 표시용 이름
    created_by: Optional[str] = None   # 등록자 username (구버전 데이터는 null)
    created_at: datetime
    updated_at: datetime
    subtasks: list["WorkItemResponse"] = []

    class Config:
        from_attributes = True

    @model_validator(mode="before")
    @classmethod
    def _drop_circular_subtask_children(cls, data):
        """ORM 객체에서 직렬화될 때 무한 재귀를 방지하기 위해 subtask 자체의 subtasks
        는 비운다. (1레벨 nested 만 노출 — 기존 TaskResponse 와 동일 정책)

        G-I3 픽스: 이전 `return data` 만 하던 stub 을 실제 동작하도록 보강.
        Pydantic v2 의 mode='before' 는 ORM 인스턴스 또는 dict 를 받음 — 둘 다 처리.
        """
        # ORM 인스턴스인 경우: hasattr 로 subtasks 접근 후 각 child 의 subtasks 비움
        if hasattr(data, "subtasks"):
            try:
                for st in (data.subtasks or []):
                    # 자식 ORM 객체의 subtasks 를 안전하게 빈 list 로 — relationship 자체는
                    # lazy loaded 라 setattr 가 가능. 실패하면 silent (validator 가 직렬화
                    # 막으면 안 되므로).
                    try:
                        setattr(st, "subtasks", [])
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
        # dict 인 경우 (테스트/수동 호출): 같은 패턴
        elif isinstance(data, dict) and isinstance(data.get("subtasks"), list):
            for st in data["subtasks"]:
                if isinstance(st, dict):
                    st["subtasks"] = []
        return data


class WorkItemStatusResponse(BaseModel):
    """칸반 상태 변경 응답 — WIP 초과 경고 포함"""
    data: WorkItemResponse
    wip_warning: bool = False


class WorkItemListResponse(BaseModel):
    """G-I6: offset/limit/has_more 필드 추가 — 클라이언트 페이지네이션 메타.
    `total` 은 진짜 DB COUNT (G-C2 의 router 변경과 페어).
    """
    data: list[WorkItemResponse]
    total: int
    offset: int = 0
    limit: int = 0
    has_more: bool = False


WorkItemResponse.model_rebuild()
