"""Pod-to-pod bottleneck analyzer schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

ProbeKey = Literal["tcp_state", "tcp_perf", "dns_latency", "endpoints"]
StatusLiteral = Literal["healthy", "warning", "critical", "pending"]


class ProbeManualFallback(BaseModel):
    command: str
    reason: str


class ProbeResultOut(BaseModel):
    status: StatusLiteral
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    manual_fallback: Optional[ProbeManualFallback] = None
    recommendation: Optional[str] = None


class BottleneckRunCreate(BaseModel):
    """POST /pod-bottleneck/run 입력."""
    cluster_id: UUID
    namespace: str = Field(..., min_length=1, max_length=100)
    source_pod: str = Field(..., min_length=1, max_length=253)
    dest_pod: str = Field(..., min_length=1, max_length=253)
    # optional — endpoints probe 가 service 단위 조회. 없으면 endpoints probe pending
    dest_service: Optional[str] = Field(None, max_length=253)
    # 선택적 probe 제한 (미지정 시 4개 모두 실행)
    probes: Optional[list[ProbeKey]] = None


class BottleneckRunResponse(BaseModel):
    id: UUID
    cluster_id: UUID
    namespace: str
    source_pod: str
    dest_pod: str
    dest_service: Optional[str] = None
    overall_status: str
    probes: dict[str, Any]
    triggered_by_user: Optional[str] = None
    duration_ms: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class BottleneckRunListResponse(BaseModel):
    data: list[BottleneckRunResponse]
    total: int
    offset: int = 0
    limit: int = 0
    has_more: bool = False


class ProbeCatalogEntry(BaseModel):
    """GET /pod-bottleneck/probes 응답 항목."""
    probe_key: str
    label: str
    axis: str
    needs_exec: bool
    fallback_cmd: Optional[str] = None
    description: Optional[str] = None
