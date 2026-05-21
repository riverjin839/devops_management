"""BottleneckRun — pod-to-pod 병목 진단 1회 결과 (4 probe 통합).

설계:
 - probes JSONB 1 컬럼 — 4 Probe 결과를 atomic 저장 (probe 별 별도 row X)
 - cluster_id + namespace + source_pod + dest_pod 로 history 조회 가능
 - cascade: cluster 삭제 시 run 도 정리
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, DateTime, Integer, ForeignKey, Index, Enum, func,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.database import Base
from app.models.cluster import StatusEnum


class BottleneckRun(Base):
    """단일 pod-to-pod 병목 진단 run 결과."""
    __tablename__ = "bottleneck_runs"
    __table_args__ = (
        # pair 단위 history 조회
        Index(
            "ix_bottleneck_runs_pair",
            "cluster_id", "namespace", "source_pod", "dest_pod",
        ),
        # 최근 N분 view
        Index("ix_bottleneck_runs_created", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(
        UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False,
    )
    namespace = Column(String(100), nullable=False)
    source_pod = Column(String(253), nullable=False)
    dest_pod = Column(String(253), nullable=False)
    # endpoints probe 용 — null 이면 endpoints probe 는 pending 처리
    dest_service = Column(String(253), nullable=True)

    overall_status = Column(
        Enum(StatusEnum), nullable=False,
        default=StatusEnum.pending, server_default="pending",
    )
    # 4 Probe 결과 통합:
    # {
    #   "tcp_state":   {"status": "warning", "message": "...", "details": {...},
    #                    "manual_fallback": {...} or null, "recommendation": "..."},
    #   "tcp_perf":    {...},
    #   "dns_latency": {...},
    #   "endpoints":   {...},
    # }
    probes = Column(JSONB, nullable=False, default=dict, server_default="{}")

    triggered_by_user = Column(String(100), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(
        DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False,
    )

    cluster = relationship("Cluster")

    def __repr__(self):
        return (
            f"<BottleneckRun(cluster={self.cluster_id}, ns={self.namespace}, "
            f"{self.source_pod}->{self.dest_pod}, status={self.overall_status})>"
        )
