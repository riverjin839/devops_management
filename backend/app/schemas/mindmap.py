from pydantic import BaseModel, Field
from datetime import datetime
from uuid import UUID
from typing import Optional, Any


class MindMapNodeBase(BaseModel):
    label: str
    note: Optional[str] = None
    color: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    collapsed: bool = False
    sort_order: float = 0.0
    extra: Optional[dict[str, Any]] = None


class MindMapNodeCreate(MindMapNodeBase):
    mindmap_id: UUID
    parent_id: Optional[UUID] = None


class MindMapNodeUpdate(BaseModel):
    label: Optional[str] = None
    note: Optional[str] = None
    color: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    collapsed: Optional[bool] = None
    sort_order: Optional[float] = None
    parent_id: Optional[UUID] = None
    extra: Optional[dict[str, Any]] = None


class MindMapNodeResponse(MindMapNodeBase):
    id: UUID
    mindmap_id: UUID
    parent_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class MindMapBase(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    title: str
    description: Optional[str] = None
    confluence_url: Optional[str] = Field(default=None, max_length=2048)


class MindMapCreate(MindMapBase):
    pass


class MindMapUpdate(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    title: Optional[str] = None
    description: Optional[str] = None
    confluence_url: Optional[str] = Field(default=None, max_length=2048)


class MindMapResponse(MindMapBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    nodes: list[MindMapNodeResponse] = []

    class Config:
        from_attributes = True


class MindMapListItem(MindMapBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    node_count: int = 0

    class Config:
        from_attributes = True


# Bulk node update for saving canvas state
class BulkNodeUpdate(BaseModel):
    nodes: list[MindMapNodeUpdate]
    ids: list[UUID]
