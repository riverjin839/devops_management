from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from uuid import UUID
from typing import Any, Optional


_NULLABLE_TEXT = ("rack_name", "ip_address", "os_info", "switch_name", "notes")


def _blank_to_none(v: Any) -> Any:
    """D-100 — 공백뿐인 문자열은 "값 없음"(NULL)으로 저장한다.

    빈 문자열이 그대로 저장되면 랙/스위치 그룹핑에서 "(미지정)" 이 아니라 이름 없는 그룹이 생긴다.
    """
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


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

    _normalize_text = field_validator(*_NULLABLE_TEXT, mode="before")(_blank_to_none)

    @field_validator("hostname", mode="before")
    @classmethod
    def _strip_hostname(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v


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

    _normalize_text = field_validator(*_NULLABLE_TEXT, mode="before")(_blank_to_none)

    @field_validator("hostname", mode="before")
    @classmethod
    def _strip_hostname(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v


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
