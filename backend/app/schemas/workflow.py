from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from uuid import UUID
from typing import Optional, List


class WorkflowStepCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    completed: bool = False
    step_type: str = 'action'
    status: str = 'todo'
    pos_x: float = 100.0
    pos_y: float = 100.0
    order_index: int = 0
    reference_type: Optional[str] = None
    reference_id: Optional[str] = None


class WorkflowStepUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    completed: Optional[bool] = None
    step_type: Optional[str] = None
    status: Optional[str] = None
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    order_index: Optional[int] = None
    reference_type: Optional[str] = None
    reference_id: Optional[str] = None

    # 수정에서 `null` 은 "비우기"다(D-162) — 설명·참조 유형/ID 는 null 로 해제할 수 있다.
    # NOT NULL 컬럼은 null 이 오면 500(IntegrityError) 대신 422 로 거부한다.
    @field_validator("title", "completed", "step_type", "status", "pos_x", "pos_y", "order_index")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class WorkflowStepResponse(BaseModel):
    id: UUID
    workflow_id: UUID
    title: str
    description: Optional[str] = None
    completed: bool
    step_type: str
    status: str
    pos_x: float
    pos_y: float
    order_index: int
    reference_type: Optional[str] = None
    reference_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkflowEdgeCreate(BaseModel):
    source_step_id: UUID
    target_step_id: UUID


class WorkflowEdgeResponse(BaseModel):
    id: UUID
    workflow_id: UUID
    source_step_id: UUID
    target_step_id: UUID
    created_at: datetime

    class Config:
        from_attributes = True


class WorkflowCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    confluence_url: Optional[str] = Field(None, max_length=2048)


class WorkflowUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    confluence_url: Optional[str] = Field(None, max_length=2048)

    # 설명·Confluence URL 은 null 로 비울 수 있고(D-162), 제목은 비울 수 없다(422).
    @field_validator("title")
    @classmethod
    def _reject_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} 은(는) 비울 수 없습니다")
        return v


class WorkflowResponse(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    confluence_url: Optional[str] = None
    steps: List[WorkflowStepResponse] = []
    edges: List[WorkflowEdgeResponse] = []
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkflowListResponse(BaseModel):
    data: List[WorkflowResponse]
