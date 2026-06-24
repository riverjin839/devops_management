import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, func, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB

from app.database import Base


class K8sEvent(Base):
    """kubewatch 웹훅으로 수신된 실시간 K8s 이벤트."""

    __tablename__ = "k8s_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), nullable=True, index=True)

    event_type = Column(String(20), nullable=False)   # ADDED | MODIFIED | DELETED
    resource_kind = Column(String(50), nullable=False) # Pod | Node | Deployment | PersistentVolumeClaim
    resource_name = Column(String(253), nullable=False)
    namespace = Column(String(253), nullable=True)
    reason = Column(String(128), nullable=True)        # CrashLoopBackOff, OOMKilling …
    message = Column(Text, nullable=True)
    severity = Column(String(16), nullable=False, default="info")  # info | warning | critical
    raw = Column(JSONB, nullable=True)
    received_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_k8s_events_received_at", "received_at"),
        Index("ix_k8s_events_severity", "severity"),
        Index("ix_k8s_events_cluster_received", "cluster_id", "received_at"),
    )
