"""Architecture Doc Pydantic schemas — 서비스 모듈별 아키텍처 문서 응답/편집 페이로드."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

ViewType = Literal["architecture", "flow"]
ManualNodeKind = Literal["external", "database", "queue", "api", "user", "custom"]
ManualEdgeType = Literal["flow", "depends", "calls", "custom"]
ManualEdgeView = Literal["architecture", "flow", "both"]


# ── graph pieces ─────────────────────────────────────────────────────────────
class ArchGraphNode(BaseModel):
    id: str
    kind: str
    name: str
    namespace: Optional[str] = None
    status: str = "healthy"
    detail: Optional[str] = None
    stale: bool = False
    stale_since: Optional[str] = None


class ArchGraphEdge(BaseModel):
    id: str
    source: str
    target: str
    type: str
    label: str = ""


class ArchGraph(BaseModel):
    nodes: list[ArchGraphNode] = Field(default_factory=list)
    edges: list[ArchGraphEdge] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    truncated: bool = False


class ArchTrafficEdge(BaseModel):
    source: str
    target: str
    flow_count: int = 0
    dropped_count: int = 0
    protocols: list[str] = Field(default_factory=list)
    ports: list[int] = Field(default_factory=list)


# ── manual layer ─────────────────────────────────────────────────────────────
class ManualNodeCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=200)
    kind: ManualNodeKind = "external"
    description: Optional[str] = None
    style: Optional[dict[str, Any]] = None


class ManualNodeUpdate(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=200)
    kind: Optional[ManualNodeKind] = None
    description: Optional[str] = None
    style: Optional[dict[str, Any]] = None


class ManualNodeOut(BaseModel):
    id: UUID
    node_id: str
    label: str
    kind: str
    description: Optional[str]
    style: Optional[dict[str, Any]]
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ManualEdgeCreate(BaseModel):
    source_id: str = Field(..., min_length=1, max_length=255)
    target_id: str = Field(..., min_length=1, max_length=255)
    edge_type: ManualEdgeType = "flow"
    label: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    view: ManualEdgeView = "both"
    sort_order: float = 0.0


class ManualEdgeUpdate(BaseModel):
    edge_type: Optional[ManualEdgeType] = None
    label: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    view: Optional[ManualEdgeView] = None
    sort_order: Optional[float] = None


class ManualEdgeOut(BaseModel):
    id: UUID
    source_id: str
    target_id: str
    edge_type: str
    label: Optional[str]
    description: Optional[str]
    view: str
    sort_order: float
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ── doc ──────────────────────────────────────────────────────────────────────
class ArchDocResponse(BaseModel):
    id: UUID
    service_id: UUID
    cluster_id: UUID
    namespace: str
    auto_graph: Optional[ArchGraph] = None
    traffic_edges: list[ArchTrafficEdge] = Field(default_factory=list)
    llm_content: Optional[dict[str, Any]] = None
    layout: dict[str, Any] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    summary_override: Optional[str] = None
    source_hash: Optional[str] = None
    drift: Optional[dict[str, Any]] = None
    last_synced_at: Optional[datetime] = None
    last_sync_status: str = "pending"
    sync_error: Optional[str] = None
    auto_sync_enabled: bool = True
    llm_status: str = "none"
    manual_nodes: list[ManualNodeOut] = Field(default_factory=list)
    manual_edges: list[ManualEdgeOut] = Field(default_factory=list)
    updated_at: datetime


class ArchDocSummary(BaseModel):
    service_id: UUID
    service_name: str
    service_type: str
    cluster_id: UUID
    namespace: Optional[str] = None
    has_doc: bool = False
    last_synced_at: Optional[str] = None
    last_sync_status: str = "pending"
    llm_status: str = "none"
    auto_sync_enabled: bool = True
    drift_counts: Optional[dict[str, int]] = None


class AnnotationEntry(BaseModel):
    """node_id 는 대문자/구분자를 포함해 axios 키 변환에 깨지므로 값으로 전달한다."""
    id: str = Field(..., min_length=1, max_length=255)
    text: Optional[str] = None  # None → 해당 주석 삭제


class DocPatch(BaseModel):
    """annotations 는 entry 단위 merge (text=None 은 삭제), 나머지는 교체."""
    summary_override: Optional[str] = None
    annotations: Optional[list[AnnotationEntry]] = None
    auto_sync_enabled: Optional[bool] = None


class LayoutPosition(BaseModel):
    id: str
    x: float
    y: float


class LayoutPatch(BaseModel):
    view: ViewType
    positions: list[LayoutPosition]


class SchedulePayload(BaseModel):
    enabled: bool = True
    cron: str = Field(..., min_length=1, max_length=100)


class ScheduleOut(BaseModel):
    enabled: bool
    cron: str
    last_run_at: Optional[str] = None


class AuditEntryOut(BaseModel):
    id: UUID
    action: str
    scope: str
    status: str
    reason: Optional[str]
    before_data: Optional[dict[str, Any]]
    after_data: Optional[dict[str, Any]]
    created_at: datetime

    class Config:
        from_attributes = True
