"""OS 파라미터 변경 이력 — 노드별 sysctl/커널 파라미터가 어떤 값에서 어떤 값으로
바뀌었는지 한 행씩 기록한다. ``kernel_param_drift`` deep checker 가 연속 스냅샷
(``ClusterConfigSnapshot`` 의 ``kernel_params:{host}``)을 비교해 채운다.

나중에 가시화/도식화(타임라인, 노드×파라미터 히트맵 등)에 쓰기 위한 정규화 테이블.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class OsParamChange(Base):
    __tablename__ = "os_param_changes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=False)

    node = Column(String(200), nullable=False)   # kernel_params:{host} 의 host
    param = Column(String(300), nullable=False)  # 예: net.core.somaxconn

    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    # added | removed | changed
    change_type = Column(String(20), nullable=False, default="changed")

    # 비교에 쓰인 스냅샷 쌍 (idempotent 재기록 방지 키로도 사용)
    from_snapshot_id = Column(UUID(as_uuid=True), nullable=True)
    to_snapshot_id = Column(UUID(as_uuid=True), nullable=True)

    # 향후 가시화용 부가 메타 (category 등)
    extra = Column(JSONB, nullable=True)

    detected_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_os_param_changes_cluster_node_detected", "cluster_id", "node", "detected_at"),
    )

    def __repr__(self) -> str:
        return f"<OsParamChange(node={self.node}, param={self.param}, {self.old_value}→{self.new_value})>"
