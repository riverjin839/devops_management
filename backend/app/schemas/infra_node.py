from pydantic import BaseModel, Field
from datetime import datetime
from uuid import UUID
from typing import Any, Optional


class InfraNodeBase(BaseModel):
    hostname: str = Field(..., min_length=1, max_length=255)
    rack_name: Optional[str] = Field(None, max_length=100)
    ip_address: Optional[str] = Field(None, max_length=45)
    role: str = Field(default="worker", pattern="^(master|worker|storage|infra)$")
    cpu_cores: Optional[int] = Field(None, ge=1, le=9999)
    ram_gb: Optional[int] = Field(None, ge=1, le=99999)
    disk_gb: Optional[int] = Field(None, ge=1, le=9999999)
    os_info: Optional[str] = Field(None, max_length=200)
    switch_name: Optional[str] = Field(None, max_length=100)
    notes: Optional[str] = None


class InfraNodeCreate(InfraNodeBase):
    cluster_id: UUID


class InfraNodeUpdate(BaseModel):
    hostname: Optional[str] = Field(None, min_length=1, max_length=255)
    rack_name: Optional[str] = Field(None, max_length=100)
    ip_address: Optional[str] = Field(None, max_length=45)
    role: Optional[str] = Field(None, pattern="^(master|worker|storage|infra)$")
    cpu_cores: Optional[int] = Field(None, ge=1, le=9999)
    ram_gb: Optional[int] = Field(None, ge=1, le=99999)
    disk_gb: Optional[int] = Field(None, ge=1, le=9999999)
    os_info: Optional[str] = Field(None, max_length=200)
    switch_name: Optional[str] = Field(None, max_length=100)
    notes: Optional[str] = None
    version: int = Field(..., ge=1)


class InfraNodeResponse(InfraNodeBase):
    id: UUID
    cluster_id: UUID
    auto_synced: bool
    version: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class InfraNodeListResponse(BaseModel):
    data: list[InfraNodeResponse]
    total: int


class NodeVerifyResult(BaseModel):
    """노드 추가 검증(node_health) 결과 — per-node 검증 / sync 직후 자동검증 공용."""
    hostname: str
    status: str                       # healthy | warning | critical | pending | error
    message: str = ""
    ok: bool = False
    node_id: Optional[UUID] = None
    details: dict[str, Any] = {}
    steps: list[dict[str, Any]] = []
    step_plan: list[dict[str, Any]] = []
    duration_ms: int = 0


class SyncResult(BaseModel):
    success: bool
    created: int
    updated: int
    failed: int
    retry_count: int
    partial_failure: bool
    errors: list[str] = []
    total: int
    verifications: list[NodeVerifyResult] = []
    verified_truncated: bool = False
