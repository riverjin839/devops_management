from datetime import datetime
from typing import Optional
from uuid import UUID
from pydantic import BaseModel, Field


class MetricCardBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    icon: str = "📊"
    promql: str = Field(..., min_length=1)
    unit: str = ""
    display_type: str = "value"
    category: str = "general"
    thresholds: Optional[str] = None
    grafana_panel_url: Optional[str] = None
    sort_order: int = 0
    enabled: bool = True


class MetricCardCreate(MetricCardBase):
    pass


class MetricCardUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    promql: Optional[str] = None
    unit: Optional[str] = None
    display_type: Optional[str] = None
    category: Optional[str] = None
    thresholds: Optional[str] = None
    grafana_panel_url: Optional[str] = None
    sort_order: Optional[int] = None
    enabled: Optional[bool] = None


class MetricCardResponse(MetricCardBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class MetricCardListResponse(BaseModel):
    data: list[MetricCardResponse]


class MetricQueryResult(BaseModel):
    """Result of executing a PromQL query."""
    card_id: UUID
    status: str = "ok"  # ok | error | offline
    value: Optional[float] = None
    labels: Optional[dict] = None
    # For 'list' display_type: multiple results
    results: Optional[list[dict]] = None
    error: Optional[str] = None


class MetricSparklinePoint(BaseModel):
    """단일 시계열 포인트 — KPI 카드 하단 Sparkline 용 (DESIGN_SYSTEM §5②)."""
    ts: float  # unix epoch seconds
    value: float


class MetricSparklineResult(BaseModel):
    """카드의 PromQL 을 range query 로 실행한 결과 — 최근 값들의 추세(추이)만 필요하므로
    라벨 조합이 여러 개면 첫 series 만 사용한다."""
    card_id: UUID
    status: str = "ok"  # ok | error | offline
    points: list[MetricSparklinePoint] = Field(default_factory=list)
    error: Optional[str] = None
