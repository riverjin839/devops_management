import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import backref, relationship

from app.database import Base


class ClusterConfigSnapshot(Base):
    """클러스터 컴포넌트 버전 / 파라미터 스냅샷.

    동일 component 에 대해 content hash 가 바뀔 때만 새 행을 추가한다 (히스토리).
    """
    __tablename__ = "cluster_config_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)

    # component 키 — 고유 식별자 역할.
    # 예) "k8s_server", "kubelet:node-01", "kube_apiserver", "kube_controller_manager",
    #     "kube_scheduler", "kube_proxy", "coredns", "etcd",
    #     "cilium_agent", "cilium_operator", "cilium_config"
    component = Column(String(120), nullable=False)

    # 사람이 읽기 쉬운 분류. 예) "control_plane" / "kubelet" / "cni" / "config"
    category = Column(String(50), nullable=True)

    # 컴포넌트 버전 (있을 경우). ex: "v1.28.4", "1.14.5"
    version = Column(String(100), nullable=True)

    # 전체 payload (image, flags, configmap data 등)
    data = Column(JSONB, nullable=False, default=dict)

    # content hash — 중복 저장 방지
    content_hash = Column(String(64), nullable=False, index=True)

    collected_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    # passive_deletes=True — Cluster 삭제 시 ORM 이 cluster_id 를 NULL 로 UPDATE 하는 것을
    # 막는다(NOT NULL 이면 NotNullViolation). 정리는 services/cluster_purge.py 담당.
    cluster = relationship("Cluster", backref=backref("config_snapshots", passive_deletes=True))

    __table_args__ = (
        Index("ix_config_snap_cluster_component", "cluster_id", "component", "collected_at"),
    )

    def __repr__(self):
        return f"<ClusterConfigSnapshot(cluster_id={self.cluster_id}, component={self.component}, version={self.version})>"
