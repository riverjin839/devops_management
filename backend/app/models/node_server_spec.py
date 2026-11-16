"""NodeServerSpec — k8s 노드 서버 자산 관리 대장.

InfraNode 가 네트워크 토폴로지 표시용 최소 모델이라면, 여기는 자산 관리 관점에서
하드웨어/위치/벤더/계약/인수인계 정보를 한 곳에 모은다.

cluster_id 는 nullable — 등록 전 spare 장비도 관리 가능.
"""
import uuid
from datetime import datetime, date

from sqlalchemy import (
    Column, String, Text, DateTime, Date, Integer, Boolean,
    ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.database import Base


class NodeServerSpec(Base):
    __tablename__ = "node_server_specs"
    __table_args__ = (
        UniqueConstraint("cluster_id", "hostname", name="uq_node_server_specs_cluster_hostname"),
        Index("ix_node_server_specs_cluster", "cluster_id"),
        Index("ix_node_server_specs_hostname", "hostname"),
        Index("ix_node_server_specs_status", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # ── 식별 ────────────────────────────────────────────────────────────────
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="SET NULL"), nullable=True)
    hostname = Column(String(255), nullable=False)              # OS hostname
    node_name = Column(String(255), nullable=True)              # k8s node name (대개 hostname 과 동일)
    role = Column(String(32), nullable=True)                    # control-plane / worker / etcd / storage / spare
    status = Column(String(32), nullable=False, default="active")  # active / spare / maintenance / decommission

    # ── 네트워크 ────────────────────────────────────────────────────────────
    internal_ip = Column(String(64), nullable=True)             # ClusterIP / InternalIP
    external_ip = Column(String(64), nullable=True)
    bmc_ip = Column(String(64), nullable=True)                  # iDRAC / iLO / BMC
    bond0_ip = Column(String(64), nullable=True)
    bond0_mac = Column(String(40), nullable=True)
    bond0_speed = Column(String(20), nullable=True)             # "10G", "25G"
    bond1_ip = Column(String(64), nullable=True)
    bond1_mac = Column(String(40), nullable=True)
    bond1_speed = Column(String(20), nullable=True)

    # ── 하드웨어 ────────────────────────────────────────────────────────────
    vendor = Column(String(64), nullable=True)                  # Dell / HPE / Supermicro / Lenovo
    model = Column(String(128), nullable=True)                  # PowerEdge R750
    serial_number = Column(String(64), nullable=True)
    cpu_model = Column(String(128), nullable=True)              # Intel Xeon Gold 6338
    cpu_sockets = Column(Integer, nullable=True)
    cpu_cores = Column(Integer, nullable=True)                  # 총 물리 코어 수
    cpu_threads = Column(Integer, nullable=True)                # logical thread (HT 포함)
    memory_gb = Column(Integer, nullable=True)
    memory_modules = Column(String(255), nullable=True)         # "16x64GB DDR4-3200"
    disk_total_gb = Column(Integer, nullable=True)
    non_os_disk_gb = Column(Integer, nullable=True)             # OS 디스크 제외 사용 가능 디스크 총량 (lsblk 자동수집 또는 수기)
    disk_type = Column(String(255), nullable=True)              # "NVMe (nvme0n1)" 등 자동수집 결과 포함
    disk_count = Column(Integer, nullable=True)
    raid_config = Column(String(64), nullable=True)             # RAID10, JBOD
    gpu_model = Column(String(128), nullable=True)
    gpu_count = Column(Integer, nullable=True)
    is_ssd = Column(Boolean, nullable=True)                     # SSD 여부 (O/X)
    is_vm = Column(Boolean, nullable=True)                      # VM 여부 (O/X)

    # ── 위치 ────────────────────────────────────────────────────────────────
    datacenter = Column(String(64), nullable=True)              # DC1
    room = Column(String(64), nullable=True)                    # Floor2-Cage3
    rack = Column(String(64), nullable=True)                    # R12
    rack_unit = Column(String(16), nullable=True)               # U21-U22

    # ── 소프트웨어 (자동 수집 가능) ────────────────────────────────────────
    os_image = Column(String(255), nullable=True)               # "Rocky Linux 8.8"
    kernel_version = Column(String(128), nullable=True)
    kubelet_version = Column(String(64), nullable=True)
    container_runtime = Column(String(64), nullable=True)

    # ── 자산/계약 ──────────────────────────────────────────────────────────
    asset_tag = Column(String(64), nullable=True)               # 자산 태그 (사내 코드)
    purchase_date = Column(Date, nullable=True)
    warranty_end = Column(Date, nullable=True)
    owner = Column(String(64), nullable=True)                   # 담당자/팀
    current_usage = Column(String(255), nullable=True)          # 현재 용도 (예: NEW K8S MASTER)
    purchase_purpose = Column(String(255), nullable=True)       # 구입 목적 (예: 장비 분석용)

    # ── 메모 ────────────────────────────────────────────────────────────────
    description = Column(Text, nullable=True)

    # DC 인벤토리 장비(신원·물리 위치의 단일 원본)와의 연결 — services/dc_inventory/device_registry.py
    device_id = Column(UUID(as_uuid=True), ForeignKey("dc_devices.id", ondelete="SET NULL"), nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    cluster = relationship("Cluster", foreign_keys=[cluster_id])

    def __repr__(self):
        return f"<NodeServerSpec(hostname={self.hostname}, vendor={self.vendor}, model={self.model})>"
