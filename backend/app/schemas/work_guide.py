from pydantic import BaseModel, Field
from datetime import datetime
from uuid import UUID
from typing import Optional, List


class WorkGuideCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: Optional[str] = None
    category: Optional[str] = None
    priority: str = 'medium'
    tags: Optional[str] = None
    status: str = 'draft'
    author: Optional[str] = None
    parent_id: Optional[UUID] = None
    sort_order: int = 0
    confluence_url: Optional[str] = Field(None, max_length=2048)


class WorkGuideUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = None
    category: Optional[str] = None
    priority: Optional[str] = None
    tags: Optional[str] = None
    status: Optional[str] = None
    author: Optional[str] = None
    parent_id: Optional[UUID] = None
    sort_order: Optional[int] = None
    confluence_url: Optional[str] = Field(None, max_length=2048)


class WorkGuideResponse(BaseModel):
    id: UUID
    parent_id: Optional[UUID] = None
    title: str
    content: Optional[str] = None
    category: Optional[str] = None
    priority: str
    tags: Optional[str] = None
    status: str
    author: Optional[str] = None
    sort_order: int = 0
    confluence_url: Optional[str] = None
    # Confluence 동기화 메타 (routers/confluence.py 가 관리)
    source: Optional[str] = 'pep'
    confluence_page_id: Optional[str] = None
    confluence_space_key: Optional[str] = None
    confluence_version: Optional[int] = None
    confluence_synced_at: Optional[datetime] = None
    confluence_sync_status: Optional[str] = None
    confluence_sync_error: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkGuideListResponse(BaseModel):
    data: List[WorkGuideResponse]
