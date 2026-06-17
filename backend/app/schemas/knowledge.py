from datetime import datetime
from typing import Optional, List
from uuid import UUID

from pydantic import BaseModel, Field


class KnowledgePageBase(BaseModel):
    service: Optional[str] = Field(None, max_length=64)
    parent_id: Optional[UUID] = None
    kind: str = "doc"
    category: Optional[str] = Field(None, max_length=32)
    title: str = Field(..., min_length=1, max_length=200)
    icon: Optional[str] = Field(None, max_length=64)
    content: Optional[str] = None
    summary: Optional[str] = Field(None, max_length=500)
    tags: Optional[List[str]] = None
    status: str = "active"
    visibility: str = "part"
    pinned: bool = False
    sort_order: int = 0
    confluence_url: Optional[str] = Field(None, max_length=2048)
    jira_url: Optional[str] = Field(None, max_length=2048)
    start_at: Optional[datetime] = None
    due_at: Optional[datetime] = None
    sprint_id: Optional[UUID] = None


class KnowledgePageCreate(KnowledgePageBase):
    pass


class KnowledgePageUpdate(BaseModel):
    service: Optional[str] = Field(None, max_length=64)
    parent_id: Optional[UUID] = None
    kind: Optional[str] = None
    category: Optional[str] = Field(None, max_length=32)
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    icon: Optional[str] = Field(None, max_length=64)
    content: Optional[str] = None
    summary: Optional[str] = Field(None, max_length=500)
    tags: Optional[List[str]] = None
    status: Optional[str] = None
    visibility: Optional[str] = None
    pinned: Optional[bool] = None
    sort_order: Optional[int] = None
    confluence_url: Optional[str] = Field(None, max_length=2048)
    jira_url: Optional[str] = Field(None, max_length=2048)
    start_at: Optional[datetime] = None
    due_at: Optional[datetime] = None
    sprint_id: Optional[UUID] = None


class KnowledgePageResponse(KnowledgePageBase):
    id: UUID
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class KnowledgePageNode(KnowledgePageResponse):
    """트리 응답 — children 중첩."""
    children: List["KnowledgePageNode"] = []


KnowledgePageNode.model_rebuild()


class KnowledgePageListResponse(BaseModel):
    data: List[KnowledgePageResponse]


class KnowledgeTreeResponse(BaseModel):
    data: List[KnowledgePageNode]


class KnowledgePageMove(BaseModel):
    parent_id: Optional[UUID] = None
    sort_order: int = 0


class MilestoneCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=200)


class KnowledgeVersionResponse(BaseModel):
    id: UUID
    page_id: UUID
    version_no: int
    kind: str
    label: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class KnowledgeVersionDetail(KnowledgeVersionResponse):
    content: Optional[str] = None


class KnowledgeVersionListResponse(BaseModel):
    data: List[KnowledgeVersionResponse]
