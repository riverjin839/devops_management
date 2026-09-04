"""K8S 자원 효율화 요청 스키마."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class ClusterScheduleOverride(BaseModel):
    enabled: bool = True
    cron: Optional[str] = None


class ScheduleBody(BaseModel):
    enabled: bool = True
    default_cron: str = "*/10 * * * *"
    clusters: Optional[dict[str, ClusterScheduleOverride]] = None


class QuotaDefaultsBody(BaseModel):
    up_threshold: Optional[float] = Field(None, ge=0.1, le=1.0)
    low_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    sustain_hours: Optional[float] = Field(None, ge=0)
    lower_factor: Optional[float] = Field(None, ge=1.0)
    step_pct: Optional[float] = Field(None, ge=1, le=200)
    cooldown_minutes: Optional[float] = Field(None, ge=0)


class PolicyDefaultsBody(BaseModel):
    automation_enabled: Optional[bool] = None
    usage_source: Optional[str] = Field(None, pattern="^(auto|prometheus|metrics)$")
    percentile: Optional[int] = Field(None, ge=50, le=99)
    window_days: Optional[int] = Field(None, ge=1, le=90)
    headroom_pct: Optional[float] = Field(None, ge=0, le=300)
    floor_cpu_m: Optional[int] = Field(None, ge=1)
    floor_mem_b: Optional[int] = Field(None, ge=1)
    threshold_ratio: Optional[float] = Field(None, ge=1.0)
    min_savings_cpu_m: Optional[int] = Field(None, ge=0)
    min_savings_mem_b: Optional[int] = Field(None, ge=0)
    min_samples: Optional[int] = Field(None, ge=0)
    min_coverage_hours: Optional[float] = Field(None, ge=0)
    system_namespaces: Optional[list[str]] = None
    optout_annotation: Optional[str] = None
    include_daemonsets: Optional[bool] = None
    keep_guaranteed: Optional[bool] = None
    cooldown_minutes: Optional[float] = Field(None, ge=0)
    max_step_pct: Optional[float] = Field(None, ge=1, le=100)
    max_targets_per_run: Optional[int] = Field(None, ge=1, le=500)
    maintenance_cron: Optional[str] = None
    quota: Optional[QuotaDefaultsBody] = None


class CustomTarget(BaseModel):
    """오퍼레이터 CR 어댑터(예: StarRocks CN) — jsonpath 로 replicas 필드를 min/max 안에서 조정."""
    label: Optional[str] = None
    enabled: bool = True
    group: str
    version: str
    plural: str
    name: str
    jsonpath: str = "spec.replicas"
    min: int = Field(1, ge=0)
    max: int = Field(10, ge=0)
    current: Optional[int] = None


class NamespacePolicyBody(BaseModel):
    auto_rightsize: bool = False
    quota_elastic: bool = False
    quota_name: Optional[str] = None
    quota_cpu_min_m: Optional[int] = Field(None, ge=0)
    quota_cpu_max_m: Optional[int] = Field(None, ge=0)
    quota_mem_min_b: Optional[int] = Field(None, ge=0)
    quota_mem_max_b: Optional[int] = Field(None, ge=0)
    rightsize_params: Optional[dict[str, Any]] = None
    quota_params: Optional[dict[str, Any]] = None
    custom_targets: Optional[list[CustomTarget]] = None


class ApplyBody(BaseModel):
    recommendation_ids: list[str] = Field(..., min_length=1)
    dry_run: bool = True


class QuotaAdjustBody(BaseModel):
    namespace: str
    cpu_m: Optional[int] = Field(None, ge=0)
    mem_b: Optional[int] = Field(None, ge=0)
    dry_run: bool = True


class CustomScaleBody(BaseModel):
    namespace: str
    target_index: int = Field(..., ge=0)
    value: int = Field(..., ge=0)
    dry_run: bool = True
