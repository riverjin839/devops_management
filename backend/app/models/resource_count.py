"""리소스 수 추세 체크리스트 — 일일점검 리뷰용.

- ResourceCountSnapshot: 클러스터별 리소스 수 일일 스냅샷(이력). counts 를 JSONB 맵으로 둬
  추적 종류가 늘어도 마이그레이션 불필요.
- MetricChecklistItem: 추적할 항목 레지스트리(전역/클러스터별, 확장형). DeepCheckDefinition 패턴 차용.
- MetricCheckState: 운영자의 "체크 완료" 상태(클러스터·날짜·항목 단위).
"""
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


class SnapshotSource(str, enum.Enum):
    auto = "auto"
    manual = "manual"


class ResourceCountSnapshot(Base):
    """클러스터 리소스 수 스냅샷(하루 1행 이상). counts = {kind: int}."""
    __tablename__ = "resource_count_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    snapshot_date = Column(Date, nullable=False, index=True)
    collected_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    source = Column(String(20), nullable=False, default=SnapshotSource.auto.value)
    counts = Column(JSONB, nullable=False, default=dict)        # {kind: count}
    truncated = Column(JSONB, nullable=False, default=dict)      # {kind: bool} — 상한 초과 추정치 표시
    # users.id 가 String(36) 이므로 FK 타입을 맞춘다 (UUID 로 두면 DatatypeMismatch).
    created_by_user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    cluster = relationship("Cluster", backref="resource_count_snapshots")

    __table_args__ = (
        Index("ix_rcsnap_cluster_date", "cluster_id", "snapshot_date"),
        Index("ix_rcsnap_cluster_collected", "cluster_id", "collected_at"),
    )


class MetricChecklistItem(Base):
    """추적 항목 정의(확장형). cluster_id NULL = 글로벌 기본 항목."""
    __tablename__ = "metric_checklist_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=True, index=True)
    item_key = Column(String(80), nullable=False)               # 예: 'pods'
    label = Column(String(120), nullable=False)
    resource_kind = Column(String(80), nullable=False)          # k8s_resources KIND_MAP 키
    enabled = Column(Boolean, default=True, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    params = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("ix_metric_item_cluster_key", "cluster_id", "item_key"),
    )


class MetricCheckState(Base):
    """운영자 체크 완료 상태 — (cluster, 날짜, 항목) 단위."""
    __tablename__ = "metric_check_states"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    check_date = Column(Date, nullable=False)
    item_key = Column(String(80), nullable=False)
    is_checked = Column(Boolean, default=False, nullable=False)
    checked_by_user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    checked_by_username = Column(String(150), nullable=True)
    checked_at = Column(DateTime, nullable=True)
    note = Column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint("cluster_id", "check_date", "item_key", name="uq_metric_check_state"),
    )
