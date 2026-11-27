from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

SEVERITY_PATTERN = "^(info|warning|critical)$"
# Prometheus duration — 0, 30s, 5m, 1h30m … (빈 값 허용: 기본 임계치가 없는 신규 알람)
DURATION_PATTERN = r"^$|^0$|^(\d+(ms|s|m|h|d|w|y))+$"


class CatalogThreshold(BaseModel):
    severity: str = Field(..., pattern=SEVERITY_PATTERN)
    expr: str = Field(..., min_length=1, max_length=4000)
    # 파이썬 예약어라 필드명은 for_ — JSON 키는 "for"
    for_: str = Field(default="", alias="for", pattern=DURATION_PATTERN, max_length=20)

    model_config = {"populate_by_name": True}


class AlarmCatalogItemIn(BaseModel):
    service: str = Field(..., min_length=1, max_length=50)
    metric_name: str = Field(..., min_length=1, max_length=200)
    meaning: Optional[str] = Field(None, max_length=4000)
    thresholds: list[CatalogThreshold] = Field(default_factory=list, max_length=10)
    enabled: bool = True


class AlarmCatalogItemOut(BaseModel):
    id: int
    service: str
    metric_name: str
    meaning: Optional[str] = None
    thresholds: list[dict] = Field(default_factory=list)
    enabled: bool
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class RequestThreshold(BaseModel):
    severity: str = Field(..., pattern=SEVERITY_PATTERN)
    base_expr: str = Field(default="", max_length=4000)
    base_for: str = Field(default="", pattern=DURATION_PATTERN, max_length=20)
    new_expr: str = Field(default="", max_length=4000)
    new_for: str = Field(default="", pattern=DURATION_PATTERN, max_length=20)


class AlarmRequestIn(BaseModel):
    service: str = Field(..., min_length=1, max_length=50)
    metric_name: str = Field(..., min_length=1, max_length=200)
    meaning: str = Field(..., min_length=1, max_length=4000)
    # 무시된다 — 서버가 (service, metric_name)으로 카탈로그 항목을 정한다(하위 호환으로만 받음).
    catalog_item_id: Optional[int] = None
    thresholds: list[RequestThreshold] = Field(..., min_length=1, max_length=10)
    cluster_ids: list[str] = Field(..., min_length=1, max_length=200)
    note: Optional[str] = Field(None, max_length=4000)


class AlarmRequestStatusIn(BaseModel):
    """상태 항목 변경 — in_progress(진행) / done(완료) / rejected(반려, 사유 필수)."""
    status: str = Field(..., pattern="^(in_progress|done|rejected)$")
    comment: Optional[str] = Field(None, max_length=2000)


class AlarmRequestCluster(BaseModel):
    id: str
    name: str
    hidden: bool = False


class AlarmRequestOut(BaseModel):
    id: int
    code: str
    status: str
    service: str
    metric_name: str
    meaning: Optional[str] = None
    catalog_item_id: Optional[int] = None
    thresholds: list[dict]
    clusters: list[AlarmRequestCluster]
    note: Optional[str] = None
    requested_by: str
    requester_name: Optional[str] = None
    review_comment: Optional[str] = None
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    applied_at: Optional[datetime] = None
    history: list[dict]
    apply_runs: list[dict] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class AlarmRequestListOut(BaseModel):
    data: list[AlarmRequestOut]
    total: int


class AlarmRequestMeta(BaseModel):
    services: list[str]
    statuses: list[dict]
    severities: list[dict]


class LabelPair(BaseModel):
    """라벨 한 쌍 — 키를 JSON 객체 키로 두면 프론트의 camelCase 변환이 라벨 키를 바꿔 버려 목록으로 주고받는다."""
    key: str = Field(..., min_length=1, max_length=253)
    value: str = Field(default="", max_length=63)


class ClusterOverride(BaseModel):
    cluster_id: str
    namespace: Optional[str] = None
    rule_labels: list[LabelPair] = Field(default_factory=list)


class AlarmApplySettings(BaseModel):
    namespace: str = Field(..., min_length=1, max_length=63)
    rule_labels: list[LabelPair] = Field(default_factory=list)
    name_prefix: str = Field(..., min_length=1, max_length=40)
    alert_labels: list[LabelPair] = Field(default_factory=list)
    mark_applied_on_success: bool = True
    cluster_overrides: list[ClusterOverride] = Field(default_factory=list, max_length=200)


class RulePreviewItem(BaseModel):
    cluster_id: str
    cluster_name: str
    namespace: str
    name: str
    yaml: str
