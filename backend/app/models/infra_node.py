import uuid
from datetime import datetime
from sqlalchemy import (
    Column,
    String,
    Text,
    DateTime,
    Integer,
    Boolean,
    ForeignKey,
    UniqueConstraint,
    Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.database import Base


class InfraNode(Base):
    __tablename__ = "infra_nodes"
    __table_args__ = (
        UniqueConstraint("cluster_id", "hostname", name="uq_infra_nodes_cluster_hostname"),
        Index("ix_infra_nodes_cluster_hostname", "cluster_id", "hostname"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    hostname = Column(String(255), nullable=False)
    rack_name = Column(String(100), nullable=True)      # 랙 이름 (예: Rack-A1)
    ip_address = Column(String(45), nullable=True)       # 관리 IP
    role = Column(String(20), nullable=False, default="worker")  # master/worker/storage/infra
    cpu_cores = Column(Integer, nullable=True)
    ram_gb = Column(Integer, nullable=True)
    disk_gb = Column(Integer, nullable=True)
    os_info = Column(String(200), nullable=True)
    switch_name = Column(String(100), nullable=True)    # 연결 스위치명
    notes = Column(Text, nullable=True)
    auto_synced = Column(Boolean, default=False)        # K8s에서 자동 수집 여부
    # DC 인벤토리 장비(신원·물리 위치의 단일 원본)와의 연결 — services/dc_inventory/device_registry.py
    device_id = Column(UUID(as_uuid=True), ForeignKey("dc_devices.id", ondelete="SET NULL"), nullable=True, index=True)
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    cluster = relationship("Cluster", back_populates="infra_nodes")

    def __repr__(self):
        return f"<InfraNode(hostname={self.hostname}, role={self.role}, rack={self.rack_name})>"
