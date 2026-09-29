import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Integer, Boolean, Text, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class MetricCard(Base):
    __tablename__ = "metric_cards"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 멀티테넌시 4단계 — NULL = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 대시보드에만 보인다.
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=True, index=True)
    title = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    icon = Column(String(10), default="📊")
    promql = Column(Text, nullable=False)
    unit = Column(String(20), default="")           # %, bytes, count, bytes/s …
    display_type = Column(String(20), default="value")  # value | gauge | list
    category = Column(String(50), default="general")    # alert, resource, storage, network
    thresholds = Column(String(100), nullable=True)     # "warning:70,critical:90"
    grafana_panel_url = Column(Text, nullable=True)     # deep-link to Grafana panel
    sort_order = Column(Integer, default=0)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<MetricCard(title={self.title})>"
