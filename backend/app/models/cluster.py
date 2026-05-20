import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Enum, Integer, Text, Boolean
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.database import Base
import enum


class StatusEnum(str, enum.Enum):
    healthy = "healthy"
    warning = "warning"
    critical = "critical"
    pending = "pending"


class Cluster(Base):
    __tablename__ = "clusters"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False, unique=True)
    # 사용자 정의 정렬 순번 — UI 사이드바 등에서 정렬에 사용. 작은 값이 먼저.
    seq = Column(Integer, nullable=False, default=1000, server_default="1000", index=True)
    api_endpoint = Column(String(255), nullable=False)
    kubeconfig_path = Column(String(255), nullable=True)
    kubeconfig_content = Column(Text, nullable=True)   # DB에 원본 YAML 보관 (컨테이너 재시작 대비)
    status = Column(Enum(StatusEnum), default=StatusEnum.healthy)

    # 클러스터 관리 메타데이터
    region = Column(String(100), nullable=True)           # 지역
    operation_level = Column(String(50), nullable=True)   # 운영레벨 (production/staging/dev/test)
    max_pod = Column(Integer, nullable=True)              # Node당 최대 Pod 수
    cilium_config = Column(Text, nullable=True)           # 주요 Cilium 설정
    cidr = Column(String(255), nullable=True)             # Node CIDR 대역 (legacy / overlap 검사용 supernet)
    # INTERNAL_IP — IP 리스트 정규식 (예: "10.0.1.[5-7,10]\n10.0.2.[1-3]"). 자동수집 nodeIps 미수집 시 우선 표시.
    internal_ips = Column(Text, nullable=True)
    first_host = Column(String(100), nullable=True)       # Node 첫 번째 호스트 IP
    last_host = Column(String(100), nullable=True)        # Node 마지막 호스트 IP
    description = Column(Text, nullable=True)             # 정보/설명
    node_count = Column(Integer, nullable=True)           # 노드 수
    hostname = Column(String(255), nullable=True)         # 호스트명
    # Pod CIDR 대역
    pod_cidr = Column(String(255), nullable=True)
    pod_first_host = Column(String(100), nullable=True)
    pod_last_host = Column(String(100), nullable=True)
    # Service CIDR 대역
    svc_cidr = Column(String(255), nullable=True)
    svc_first_host = Column(String(100), nullable=True)
    svc_last_host = Column(String(100), nullable=True)
    # NIC 정보 (ifconfig: bond0, bond1)
    bond0_ip = Column(String(100), nullable=True)
    bond0_mac = Column(String(50), nullable=True)
    bond1_ip = Column(String(100), nullable=True)
    bond1_mac = Column(String(50), nullable=True)
    bgp_enabled = Column(Boolean, nullable=True, default=False)   # BGP 설정 여부
    as_number = Column(String(20), nullable=True)                  # BGP AS 번호
    # 자동 수집되는 버전 정보
    # VARCHAR(32) 는 일부 배포판(OpenShift eks-xxxxx 해시 / RKE2 빌드 태그 /
    # cilium CI image tag) 에서 초과 → StringDataRightTruncation 발생. 128 로 확장.
    k8s_version = Column(String(128), nullable=True)               # 예: v1.29.3+rke2r1, v1.30.0-eks-1234567
    cilium_version = Column(String(128), nullable=True)            # 예: v1.16.3-ci-abcdef1234567890
    node_ips = Column(Text, nullable=True)                         # JSON 배열 (InternalIP 목록)
    # 사용자 정의 컬럼 값 — ClusterCustomField 의 key 에 대응
    custom_values = Column(JSONB, nullable=True)                   # {field_key: value, ...}
    # 사용자 지정 사이드바 아이콘 — lucide-react 컴포넌트 이름 (예: "Server") /
    # emoji 1자 / 업로드 이미지 base64 data URL ("data:image/...;base64,..."). 길이 무제한.
    # null/empty 면 status 기반 기본 아이콘으로 fallback.
    icon = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    addons = relationship("Addon", back_populates="cluster", cascade="all, delete-orphan")
    check_logs = relationship("CheckLog", back_populates="cluster", cascade="all, delete-orphan")
    playbooks = relationship("Playbook", back_populates="cluster", cascade="all, delete-orphan")
    work_items = relationship("WorkItem", back_populates="cluster", foreign_keys="WorkItem.cluster_id")
    infra_nodes = relationship("InfraNode", back_populates="cluster", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Cluster(name={self.name}, status={self.status})>"
