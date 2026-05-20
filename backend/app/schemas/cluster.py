from pydantic import BaseModel, Field
from datetime import datetime
from uuid import UUID
from typing import Optional
from enum import Enum


class StatusEnum(str, Enum):
    healthy = "healthy"
    warning = "warning"
    critical = "critical"
    pending = "pending"


class ClusterBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    seq: int = Field(default=1000, ge=0, le=999999)
    api_endpoint: str = Field('', max_length=255)
    kubeconfig_path: Optional[str] = None
    # 클러스터 관리 메타데이터 (optional)
    region: Optional[str] = None
    operation_level: Optional[str] = None
    max_pod: Optional[int] = None
    cilium_config: Optional[str] = None
    # Node CIDR (legacy supernet — 겹침 검사에 계속 사용)
    cidr: Optional[str] = None
    # INTERNAL_IP — IP 리스트 정규식 (예: "10.0.1.[5-7,10]"). nodeIps 미수집 시 우선 표시.
    internal_ips: Optional[str] = None
    first_host: Optional[str] = None
    last_host: Optional[str] = None
    # Pod CIDR
    pod_cidr: Optional[str] = None
    pod_first_host: Optional[str] = None
    pod_last_host: Optional[str] = None
    # Service CIDR
    svc_cidr: Optional[str] = None
    svc_first_host: Optional[str] = None
    svc_last_host: Optional[str] = None
    # NIC (bond0, bond1)
    bond0_ip: Optional[str] = None
    bond0_mac: Optional[str] = None
    bond1_ip: Optional[str] = None
    bond1_mac: Optional[str] = None
    description: Optional[str] = None
    node_count: Optional[int] = None
    hostname: Optional[str] = None
    bgp_enabled: Optional[bool] = None
    as_number: Optional[str] = None
    # 사이드바 표시용 사용자 지정 아이콘 — lucide-react 컴포넌트 이름 또는 emoji 1자.
    # lucide 이름 / emoji 1자 / 업로드 이미지 base64 data URL. 길이 무제한.
    icon: Optional[str] = Field(default=None)


class ClusterCreate(ClusterBase):
    # kubeconfig YAML 원문 (직접 입력 / 파일 업로드 시 사용, DB에 저장하지 않음)
    kubeconfig_content: Optional[str] = None
    # 연결 검증 생략 여부 (네트워크 미연결 환경에서 임시 등록 시 사용)
    skip_connectivity_check: bool = False


class ClusterUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    seq: Optional[int] = Field(None, ge=0, le=999999)
    api_endpoint: Optional[str] = Field(None, min_length=1, max_length=255)
    kubeconfig_path: Optional[str] = None
    status: Optional[StatusEnum] = None
    region: Optional[str] = None
    operation_level: Optional[str] = None
    max_pod: Optional[int] = None
    cilium_config: Optional[str] = None
    cidr: Optional[str] = None
    internal_ips: Optional[str] = None
    first_host: Optional[str] = None
    last_host: Optional[str] = None
    pod_cidr: Optional[str] = None
    pod_first_host: Optional[str] = None
    pod_last_host: Optional[str] = None
    svc_cidr: Optional[str] = None
    svc_first_host: Optional[str] = None
    svc_last_host: Optional[str] = None
    bond0_ip: Optional[str] = None
    bond0_mac: Optional[str] = None
    bond1_ip: Optional[str] = None
    bond1_mac: Optional[str] = None
    description: Optional[str] = None
    node_count: Optional[int] = None
    hostname: Optional[str] = None
    bgp_enabled: Optional[bool] = None
    as_number: Optional[str] = None
    # lucide 이름 / emoji 1자 / 업로드 이미지 base64 data URL. 길이 무제한.
    icon: Optional[str] = Field(default=None)


class ClusterResponse(ClusterBase):
    id: UUID
    status: StatusEnum
    created_at: datetime
    updated_at: datetime
    # 자동수집 / NIC 수집으로 채워지는 노드 IP 메타 (JSON 문자열).
    # 프론트의 ClusterTableRow / BondIpRow 가 이 필드에서 bond0/bond1 IP 들을
    # 추출 표시. 응답에서 빠져 있으면 cluster.nodeIps == undefined 가 되어
    # bond0/bond1 컬럼이 영구적으로 비어있게 보인다.
    node_ips: Optional[str] = None

    class Config:
        from_attributes = True


class ClusterListResponse(BaseModel):
    data: list[ClusterResponse]
