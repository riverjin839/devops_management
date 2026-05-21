"""LakeService Pydantic schemas — 등록/수정/응답/리스트 + 헬스체크 결과."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, HttpUrl, field_validator

# 코드 catalog — design 의 SERVICE_TYPE_CATALOG 와 매핑.
ServiceType = Literal[
    "airflow", "spark", "iceberg", "trino",
    "starrocks", "jupyterlab", "superset", "polaris",
]
Category = Literal["catalog", "runtime", "analytics"]
StatusLiteral = Literal["healthy", "warning", "critical", "pending"]
TriggeredBy = Literal["manual", "scheduled"]


class LakeServiceBase(BaseModel):
    cluster_id: UUID
    service_type: ServiceType
    name: str = Field(..., min_length=1, max_length=100)
    endpoint_url: str = Field(..., min_length=1, max_length=512)
    namespace: Optional[str] = Field(None, max_length=100)
    enabled: bool = True
    tls_verify: bool = False
    meta: Optional[dict[str, Any]] = None

    @field_validator("endpoint_url")
    @classmethod
    def _check_url(cls, v: str) -> str:
        """간단한 URL sanity — 자세한 검증은 HttpUrl 안 씀 (in-cluster Service URL 도 허용)."""
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            raise ValueError("endpoint_url 은 http:// 또는 https:// 로 시작해야 합니다.")
        return v


class LakeServiceCreate(LakeServiceBase):
    """category 는 server 가 service_type 으로 자동 결정 — 입력 무시."""
    pass


class LakeServiceUpdate(BaseModel):
    """모든 필드 optional. service_type / cluster_id 변경 불가 (재등록 필요)."""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    endpoint_url: Optional[str] = Field(None, min_length=1, max_length=512)
    namespace: Optional[str] = Field(None, max_length=100)
    enabled: Optional[bool] = None
    tls_verify: Optional[bool] = None
    meta: Optional[dict[str, Any]] = None

    @field_validator("endpoint_url")
    @classmethod
    def _check_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            raise ValueError("endpoint_url 은 http:// 또는 https:// 로 시작해야 합니다.")
        return v


class LakeServiceResponse(BaseModel):
    id: UUID
    cluster_id: UUID
    service_type: str
    name: str
    category: str
    endpoint_url: str
    namespace: Optional[str] = None
    enabled: bool
    tls_verify: bool
    status: str
    last_checked_at: Optional[datetime] = None
    last_message: Optional[str] = None
    meta: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class LakeServiceListResponse(BaseModel):
    """page 메타 포함 — 직전 사이클(work-mgmt) baseline."""
    data: list[LakeServiceResponse]
    total: int
    offset: int = 0
    limit: int = 0
    has_more: bool = False


class LakeServiceCheckResponse(BaseModel):
    id: UUID
    service_id: UUID
    status: str
    response_time_ms: Optional[int] = None
    message: Optional[str] = None
    details: Optional[dict[str, Any]] = None
    triggered_by: str
    triggered_by_user: Optional[str] = None
    checked_at: datetime

    class Config:
        from_attributes = True


class LakeServiceCheckListResponse(BaseModel):
    data: list[LakeServiceCheckResponse]
    total: int
    offset: int = 0
    limit: int = 0
    has_more: bool = False


class LakeServiceTypeInfo(BaseModel):
    """8 service_type 메타 — /lake-services/types 응답."""
    service_type: str
    label: str
    category: str
    default_path: str
    description: Optional[str] = None
