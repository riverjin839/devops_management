from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from uuid import UUID
from typing import Any, Optional
from enum import Enum
import re


# Prometheus 라벨 이름 규칙 — 추이 노드 라벨이 PromQL 에 그대로 들어가므로 이 형식만 허용한다.
TREND_NODE_LABEL_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
_TREND_NODE_LABEL_RE = re.compile(TREND_NODE_LABEL_PATTERN)


def _normalize_trend_node_label(v: Optional[str]) -> Optional[str]:
    """빈 값 → None(자동 탐지), `auto` → "auto", 그 외는 Prometheus 라벨 이름 형식 검증."""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    if s.lower() == "auto":
        return "auto"
    if not _TREND_NODE_LABEL_RE.match(s):
        raise ValueError(
            "추이 노드 라벨은 Prometheus 라벨 이름 형식(영문·숫자·밑줄, 숫자로 시작 불가, 최대 64자)"
            " 또는 auto 여야 합니다."
        )
    return s


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
    # 아이콘 빌더 레시피 — 있으면 프론트가 뷰어의 현재 UI 테마로 매번 다시 렌더한다
    # (colorMode: 'theme'|'custom' — 'custom' 이면 테마 무관하게 customHex 우선).
    icon_config: Optional[dict[str, Any]] = Field(default=None)
    # Cluster Trends — per-cluster Prometheus URL 오버라이드 / 토글.
    prometheus_url: Optional[str] = Field(default=None, max_length=512)
    prometheus_enabled: Optional[bool] = None
    # Cluster Trends 노드 매칭 라벨 — node-exporter 시리즈에서 K8s 노드 이름이 든 라벨.
    # 빈 값·auto = node → kubernetes_node → instance 순 자동 탐지 (D-185).
    trend_node_label: Optional[str] = Field(default=None, max_length=64)
    # Observability 대시보드 — Alertmanager URL + 수집 모드(pull/push) + 토글.
    alertmanager_url: Optional[str] = Field(default=None, max_length=512)
    observability_mode: Optional[str] = Field(default=None, max_length=16)
    observability_enabled: Optional[bool] = None


class ClusterCreate(ClusterBase):
    # kubeconfig YAML 원문 (직접 입력 / 파일 업로드 시 사용). 연결 검증에 임시 파일로 쓰고,
    # 등록되면 clusters.kubeconfig_content 에 암호화(EncryptedText)해 저장한다 — 응답에는 싣지 않는다.
    kubeconfig_content: Optional[str] = None
    # 연결 검증 생략 여부 (네트워크 미연결 환경에서 임시 등록 시 사용)
    skip_connectivity_check: bool = False

    # 입력 검증은 생성·수정 스키마에만 — 응답(ClusterResponse)에 걸면 복원·수동 편집으로 들어온
    # 형식 밖 값 하나가 클러스터 목록 전체를 500 으로 만든다.
    @field_validator("trend_node_label", mode="before")
    @classmethod
    def _v_trend_node_label(cls, v):
        return _normalize_trend_node_label(v)


class ClusterUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    seq: Optional[int] = Field(None, ge=0, le=999999)
    api_endpoint: Optional[str] = Field(None, min_length=1, max_length=255)
    kubeconfig_path: Optional[str] = None
    # status 는 점검/verify 결과로만 갱신 — 수정 API 로 임의 지정 불가 (미지정 필드는 무시됨).
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
    icon_config: Optional[dict[str, Any]] = Field(default=None)
    # Cluster Trends — per-cluster Prometheus URL 오버라이드 / 토글.
    prometheus_url: Optional[str] = Field(default=None, max_length=512)
    prometheus_enabled: Optional[bool] = None
    # Cluster Trends 노드 매칭 라벨 — node-exporter 시리즈에서 K8s 노드 이름이 든 라벨.
    # 빈 값·auto = node → kubernetes_node → instance 순 자동 탐지 (D-185).
    trend_node_label: Optional[str] = Field(default=None, max_length=64)
    # Observability 대시보드 — Alertmanager URL + 수집 모드(pull/push) + 토글.
    alertmanager_url: Optional[str] = Field(default=None, max_length=512)
    observability_mode: Optional[str] = Field(default=None, max_length=16)
    observability_enabled: Optional[bool] = None

    @field_validator("trend_node_label", mode="before")
    @classmethod
    def _v_trend_node_label(cls, v):
        return _normalize_trend_node_label(v)


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
    # viewer 네트워크 정보 숨김 정책(services/cluster_network_mask.py)으로 IP·CIDR 등이
    # 비워진 응답이면 True — 화면은 빈 값 대신 "숨김" 을 표시한다.
    network_masked: bool = False

    class Config:
        from_attributes = True


class ClusterListResponse(BaseModel):
    data: list[ClusterResponse]
