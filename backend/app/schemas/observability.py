"""Observability / 알람 인박스 Pydantic 스키마.

주의 — 라벨 키 보존:
`services/api.ts` 의 axios 인터셉터가 응답의 **모든 키**를 snake_case → camelCase 로 바꾼다.
Prometheus 라벨(`job_name`, `kubernetes_namespace` …)을 dict 로 그대로 내보내면 키가 깨지므로,
라벨/어노테이션은 `[{k, v}]` 쌍 배열로, raw 페이로드는 **문자열**로 내보낸다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class KV(BaseModel):
    """키 변환에 안전한 라벨 1쌍."""

    k: str
    v: str


def to_kv(mapping: Optional[dict[str, Any]]) -> list[KV]:
    if not isinstance(mapping, dict):
        return []
    return [KV(k=str(key), v="" if val is None else str(val)) for key, val in sorted(mapping.items())]


# ── 모듈 / 지표 카탈로그 ─────────────────────────────────────────────────────

class ObservabilityModuleOut(BaseModel):
    id: UUID
    key: str
    label: str
    description: Optional[str] = None
    icon: Optional[str] = None
    status: str
    enabled: bool
    sort_order: int
    metric_count: int = 0

    class Config:
        from_attributes = True


class ObservabilityMetricOut(BaseModel):
    id: UUID
    module_key: str
    key: str
    label: str
    category: str
    promql: str
    unit: str
    display_type: str
    thresholds: Optional[str] = None
    invert: bool
    help: Optional[str] = None
    doc_url: Optional[str] = None
    sort_order: int
    enabled: bool

    class Config:
        from_attributes = True


class ObservabilityMetricInput(BaseModel):
    module_key: str = Field(min_length=1, max_length=64)
    key: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=150)
    category: str = Field(default="general", max_length=50)
    promql: str = Field(min_length=1)
    unit: str = Field(default="", max_length=20)
    display_type: str = Field(default="value", max_length=20)
    thresholds: Optional[str] = Field(default=None, max_length=100)
    invert: bool = False
    help: Optional[str] = None
    doc_url: Optional[str] = Field(default=None, max_length=1024)
    sort_order: int = 0
    enabled: bool = True


class ObservabilityMetricUpdate(BaseModel):
    label: Optional[str] = Field(default=None, max_length=150)
    category: Optional[str] = Field(default=None, max_length=50)
    promql: Optional[str] = None
    unit: Optional[str] = Field(default=None, max_length=20)
    display_type: Optional[str] = Field(default=None, max_length=20)
    thresholds: Optional[str] = Field(default=None, max_length=100)
    invert: Optional[bool] = None
    help: Optional[str] = None
    doc_url: Optional[str] = Field(default=None, max_length=1024)
    sort_order: Optional[int] = None
    enabled: Optional[bool] = None


class MetricValueOut(BaseModel):
    """지표 1행의 현재값 — dense 테이블 한 줄에 대응."""

    metric_id: UUID
    key: str
    label: str
    category: str
    unit: str
    display_type: str
    thresholds: Optional[str] = None
    invert: bool = False
    help: Optional[str] = None
    doc_url: Optional[str] = None
    promql: str
    # ok | warning | critical | unknown  (임계값 판정 결과)
    state: str = "unknown"
    value: Optional[float] = None
    labels: list[KV] = Field(default_factory=list)
    # 동일 지표에서 시리즈가 여러 개면 대표값(최댓값/최솟값) 외 나머지 개수
    series_count: int = 0
    status: str = "ok"                 # ok | error | offline  (조회 결과)
    error: Optional[str] = None


class MetricValuesResponse(BaseModel):
    module: str
    cluster_id: Optional[UUID] = None
    source: str = "live"               # live | snapshot | offline
    collected_at: Optional[datetime] = None
    detail: Optional[str] = None       # offline 사유 등 화면 안내 문구
    data: list[MetricValueOut] = Field(default_factory=list)


class PromRuleOut(BaseModel):
    group: str
    file: Optional[str] = None
    name: str
    type: str = "alerting"             # alerting | recording
    state: Optional[str] = None        # firing | pending | inactive
    severity: Optional[str] = None
    duration: Optional[float] = None   # `for` (초)
    query: str = ""
    health: Optional[str] = None
    last_error: Optional[str] = None
    evaluation_time: Optional[float] = None
    last_evaluation: Optional[str] = None
    active_alerts: int = 0
    labels: list[KV] = Field(default_factory=list)
    annotations: list[KV] = Field(default_factory=list)


class PromTargetOut(BaseModel):
    job: str
    instance: str
    health: str = "unknown"            # up | down | unknown
    scrape_pool: Optional[str] = None
    scrape_url: Optional[str] = None
    last_scrape: Optional[str] = None
    last_scrape_duration: Optional[float] = None
    last_error: Optional[str] = None
    labels: list[KV] = Field(default_factory=list)


class ActiveAlertOut(BaseModel):
    alertname: str
    state: str = "firing"              # firing | pending
    severity: Optional[str] = None
    namespace: Optional[str] = None
    resource: Optional[str] = None
    summary: Optional[str] = None
    active_at: Optional[str] = None
    value: Optional[str] = None
    origin: str = "prometheus"         # prometheus | alertmanager
    labels: list[KV] = Field(default_factory=list)
    annotations: list[KV] = Field(default_factory=list)


class PromViewResponse(BaseModel):
    """규칙/타겟/발화중알람 공통 봉투."""

    cluster_id: Optional[UUID] = None
    source: str = "live"
    collected_at: Optional[datetime] = None
    detail: Optional[str] = None
    rules: list[PromRuleOut] = Field(default_factory=list)
    targets: list[PromTargetOut] = Field(default_factory=list)
    alerts: list[ActiveAlertOut] = Field(default_factory=list)


# ── 알람 인박스 ──────────────────────────────────────────────────────────────

class AlertEventOut(BaseModel):
    id: UUID
    cluster_id: Optional[UUID] = None
    cluster_name: Optional[str] = None
    source: str
    fingerprint: str
    alertname: str
    severity: str
    severity_source: str
    status: str
    namespace: Optional[str] = None
    resource: Optional[str] = None
    summary: Optional[str] = None
    description: Optional[str] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    generator_url: Optional[str] = None
    occurrences: int = 1
    notify_count: int = 0
    suppressed_count: int = 0
    last_notified_at: Optional[datetime] = None
    acked: bool = False
    ack_by: Optional[str] = None
    ack_at: Optional[datetime] = None
    received_at: datetime
    labels: list[KV] = Field(default_factory=list)
    annotations: list[KV] = Field(default_factory=list)
    # raw 는 키 변환을 피하려고 문자열로 내보낸다 (상세 펼침의 <pre> 표시용).
    raw_json: Optional[str] = None
    # AI 자동 분석 연결 — null(미대상) | queued | running | done | failed | skipped
    analysis_id: Optional[UUID] = None
    analysis_status: Optional[str] = None


class IncidentAnalysisOut(BaseModel):
    """AI 장애 분석 결과 (분석 전용 — 실행 가능한 필드 없음)."""
    id: UUID
    alert_event_id: Optional[UUID] = None
    cluster_id: Optional[UUID] = None
    namespace: Optional[str] = None
    resource: Optional[str] = None
    trigger: str
    status: str
    severity: Optional[str] = None
    root_cause: Optional[str] = None
    suggested_actions: list[str] = Field(default_factory=list)
    related_runbooks: list[str] = Field(default_factory=list)
    confidence: Optional[float] = None
    citations: list[dict] = Field(default_factory=list)
    analyzed_by: Optional[str] = None
    matched_rule_id: Optional[str] = None
    duration_ms: Optional[int] = None
    error: Optional[str] = None
    created_at: datetime
    finished_at: Optional[datetime] = None


class AlertEventListResponse(BaseModel):
    data: list[AlertEventOut]
    total: int


class AlertStatsResponse(BaseModel):
    firing: int = 0
    resolved: int = 0
    critical: int = 0
    warning: int = 0
    info: int = 0
    unacked: int = 0
    total: int = 0


class AlertAckInput(BaseModel):
    acked: bool = True


# ── 알림 규칙 ────────────────────────────────────────────────────────────────

class AlertNotifyRuleOut(BaseModel):
    id: UUID
    name: str
    enabled: bool
    priority: int
    cluster_id: Optional[UUID] = None
    module_key: Optional[str] = None
    alertname_pattern: Optional[str] = None
    namespace_pattern: Optional[str] = None
    label_matchers: list[KV] = Field(default_factory=list)
    severity_min: Optional[str] = None
    notify_mode: str
    recipients: list[str] = Field(default_factory=list)
    severity_override: Optional[str] = None
    channel_ids: list[UUID] = Field(default_factory=list)
    dedup_window_sec: int
    dedup_mode: str


class AlertNotifyRuleInput(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    enabled: bool = True
    priority: int = 100
    cluster_id: Optional[UUID] = None
    module_key: Optional[str] = Field(default=None, max_length=64)
    alertname_pattern: Optional[str] = Field(default=None, max_length=255)
    namespace_pattern: Optional[str] = Field(default=None, max_length=255)
    label_matchers: list[KV] = Field(default_factory=list)
    severity_min: Optional[str] = None
    notify_mode: str = "all"
    recipients: list[str] = Field(default_factory=list)
    severity_override: Optional[str] = None
    channel_ids: list[UUID] = Field(default_factory=list)
    dedup_window_sec: int = 300
    dedup_mode: str = "summarize"


class AlertSettingsOut(BaseModel):
    default_notify_mode: str
    default_recipients: list[str] = Field(default_factory=list)
    default_severity_min: str
    dedup_window_sec: int
    dedup_mode: str
    retention_days: int


class AlertSettingsUpdate(BaseModel):
    default_notify_mode: Optional[str] = None
    default_recipients: Optional[list[str]] = None
    default_severity_min: Optional[str] = None
    dedup_window_sec: Optional[int] = None
    dedup_mode: Optional[str] = None
    retention_days: Optional[int] = None


# ── Ingest ───────────────────────────────────────────────────────────────────

class SnapshotIngestInput(BaseModel):
    """push 모드 수집기가 보내는 스냅샷 1건."""

    cluster: Optional[str] = None          # 클러스터 이름 또는 UUID 문자열
    module: str = "kube-prometheus-stack"
    kind: str                              # metrics | rules | targets | alerts | status
    collected_at: Optional[datetime] = None
    payload: Any = None
