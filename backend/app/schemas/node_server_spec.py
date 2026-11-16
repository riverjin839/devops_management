from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class NodeServerSpecBase(BaseModel):
    cluster_id: Optional[UUID] = None
    hostname: str = Field(..., min_length=1, max_length=255)
    node_name: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = Field(default=None, max_length=32)
    status: str = Field(default="active", max_length=32)

    internal_ip: Optional[str] = Field(default=None, max_length=64)
    external_ip: Optional[str] = Field(default=None, max_length=64)
    bmc_ip: Optional[str] = Field(default=None, max_length=64)
    bond0_ip: Optional[str] = Field(default=None, max_length=64)
    bond0_mac: Optional[str] = Field(default=None, max_length=40)
    bond0_speed: Optional[str] = Field(default=None, max_length=20)
    bond1_ip: Optional[str] = Field(default=None, max_length=64)
    bond1_mac: Optional[str] = Field(default=None, max_length=40)
    bond1_speed: Optional[str] = Field(default=None, max_length=20)

    vendor: Optional[str] = Field(default=None, max_length=64)
    model: Optional[str] = Field(default=None, max_length=128)
    serial_number: Optional[str] = Field(default=None, max_length=64)
    cpu_model: Optional[str] = Field(default=None, max_length=128)
    cpu_sockets: Optional[int] = Field(default=None, ge=0, le=16)
    cpu_cores: Optional[int] = Field(default=None, ge=0, le=2048)
    cpu_threads: Optional[int] = Field(default=None, ge=0, le=4096)
    memory_gb: Optional[int] = Field(default=None, ge=0, le=65536)
    memory_modules: Optional[str] = Field(default=None, max_length=255)
    disk_total_gb: Optional[int] = Field(default=None, ge=0)
    non_os_disk_gb: Optional[int] = Field(default=None, ge=0)
    disk_type: Optional[str] = Field(default=None, max_length=255)
    disk_count: Optional[int] = Field(default=None, ge=0, le=1024)
    raid_config: Optional[str] = Field(default=None, max_length=64)
    gpu_model: Optional[str] = Field(default=None, max_length=128)
    gpu_count: Optional[int] = Field(default=None, ge=0, le=64)
    is_ssd: Optional[bool] = None
    is_vm: Optional[bool] = None

    datacenter: Optional[str] = Field(default=None, max_length=64)
    room: Optional[str] = Field(default=None, max_length=64)
    rack: Optional[str] = Field(default=None, max_length=64)
    rack_unit: Optional[str] = Field(default=None, max_length=16)

    os_image: Optional[str] = Field(default=None, max_length=255)
    kernel_version: Optional[str] = Field(default=None, max_length=128)
    kubelet_version: Optional[str] = Field(default=None, max_length=64)
    container_runtime: Optional[str] = Field(default=None, max_length=64)

    asset_tag: Optional[str] = Field(default=None, max_length=64)
    purchase_date: Optional[date] = None
    warranty_end: Optional[date] = None
    owner: Optional[str] = Field(default=None, max_length=64)
    current_usage: Optional[str] = Field(default=None, max_length=255)
    purchase_purpose: Optional[str] = Field(default=None, max_length=255)

    description: Optional[str] = None


class NodeServerSpecCreate(NodeServerSpecBase):
    pass


class NodeServerSpecUpdate(BaseModel):
    """모든 필드 optional — 부분 업데이트."""
    model_config = ConfigDict(extra="ignore")

    cluster_id: Optional[UUID] = None
    hostname: Optional[str] = None
    node_name: Optional[str] = None
    role: Optional[str] = None
    status: Optional[str] = None

    internal_ip: Optional[str] = None
    external_ip: Optional[str] = None
    bmc_ip: Optional[str] = None
    bond0_ip: Optional[str] = None
    bond0_mac: Optional[str] = None
    bond0_speed: Optional[str] = None
    bond1_ip: Optional[str] = None
    bond1_mac: Optional[str] = None
    bond1_speed: Optional[str] = None

    vendor: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None
    cpu_model: Optional[str] = None
    cpu_sockets: Optional[int] = None
    cpu_cores: Optional[int] = None
    cpu_threads: Optional[int] = None
    memory_gb: Optional[int] = None
    memory_modules: Optional[str] = None
    disk_total_gb: Optional[int] = None
    non_os_disk_gb: Optional[int] = None
    disk_type: Optional[str] = None
    disk_count: Optional[int] = None
    raid_config: Optional[str] = None
    gpu_model: Optional[str] = None
    gpu_count: Optional[int] = None
    is_ssd: Optional[bool] = None
    is_vm: Optional[bool] = None

    datacenter: Optional[str] = None
    room: Optional[str] = None
    rack: Optional[str] = None
    rack_unit: Optional[str] = None

    os_image: Optional[str] = None
    kernel_version: Optional[str] = None
    kubelet_version: Optional[str] = None
    container_runtime: Optional[str] = None

    asset_tag: Optional[str] = None
    purchase_date: Optional[date] = None
    warranty_end: Optional[date] = None
    owner: Optional[str] = None
    current_usage: Optional[str] = None
    purchase_purpose: Optional[str] = None

    description: Optional[str] = None


class NodeServerSpecOut(NodeServerSpecBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    cluster_name: Optional[str] = None
    # 연결된 DC 인벤토리 장비(신원·물리 위치의 단일 원본). 없으면 아직 연결 전.
    device_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


class NodeServerSpecList(BaseModel):
    data: list[NodeServerSpecOut]
    total: int


class NodeSpecImportRequest(BaseModel):
    """k8s 클러스터에서 노드 정보를 자동 임포트.

    upsert=True 면 동일 (cluster_id, hostname) 행이 있으면 update,
    아니면 신규 insert. 비어있는 자동수집 필드만 채우고 사용자가 직접 입력한
    필드는 덮어쓰지 않는다.
    """
    upsert: bool = True
    overwrite_user_fields: bool = False  # True 면 vendor/asset_tag 등도 덮어씀


class NodeSpecImportResult(BaseModel):
    inserted: int
    updated: int
    skipped: int
    errors: list[str] = Field(default_factory=list)
    items: list[NodeServerSpecOut]


# ── CSV 업로드 (dry-run / apply 공용) ──────────────────────────────────────

class NodeSpecCsvRow(BaseModel):
    """한 행의 업로드 데이터 — 모든 필드 optional, hostname 만 필수."""
    model_config = ConfigDict(extra="ignore")

    hostname: str = Field(..., min_length=1, max_length=255)
    # 식별 / 상태
    cluster_id: Optional[UUID] = None
    node_name: Optional[str] = None
    role: Optional[str] = None
    status: Optional[str] = None
    # 네트워크
    internal_ip: Optional[str] = None
    external_ip: Optional[str] = None
    bmc_ip: Optional[str] = None
    bond0_ip: Optional[str] = None
    bond0_mac: Optional[str] = None
    bond0_speed: Optional[str] = None
    bond1_ip: Optional[str] = None
    bond1_mac: Optional[str] = None
    bond1_speed: Optional[str] = None
    # 하드웨어
    vendor: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None
    cpu_model: Optional[str] = None
    cpu_sockets: Optional[int] = None
    cpu_cores: Optional[int] = None
    cpu_threads: Optional[int] = None
    memory_gb: Optional[int] = None
    memory_modules: Optional[str] = None
    disk_total_gb: Optional[int] = None
    non_os_disk_gb: Optional[int] = None
    disk_type: Optional[str] = None
    disk_count: Optional[int] = None
    raid_config: Optional[str] = None
    gpu_model: Optional[str] = None
    gpu_count: Optional[int] = None
    is_ssd: Optional[bool] = None
    is_vm: Optional[bool] = None
    # 위치
    datacenter: Optional[str] = None
    room: Optional[str] = None
    rack: Optional[str] = None
    rack_unit: Optional[str] = None
    # 소프트웨어
    os_image: Optional[str] = None
    kernel_version: Optional[str] = None
    kubelet_version: Optional[str] = None
    container_runtime: Optional[str] = None
    # 자산
    asset_tag: Optional[str] = None
    purchase_date: Optional[date] = None
    warranty_end: Optional[date] = None
    owner: Optional[str] = None
    current_usage: Optional[str] = None
    purchase_purpose: Optional[str] = None

    description: Optional[str] = None


class NodeSpecCsvUploadRequest(BaseModel):
    """CSV 업로드 요청.
    dry_run=True 면 DB 반영 없이 어떤 행이 insert/update 될지만 돌려준다.
    match_cluster_scope=True 면 (cluster_id, hostname) 으로 중복 검사,
    False 면 hostname 만으로 검사 (행의 cluster_id 무시).
    """
    rows: list[NodeSpecCsvRow] = Field(..., min_length=1, max_length=5000)
    dry_run: bool = True
    # 자기 cluster_id 외 다른 클러스터 호스트명과의 중복도 update 로 볼지
    match_cluster_scope: bool = False
    # 업데이트 시 빈 문자열/None 값은 무시 (기존 값 보존)
    ignore_empty_on_update: bool = True


class NodeSpecCsvDiff(BaseModel):
    row_index: int
    hostname: str
    action: str                     # "insert" | "update" | "skip" | "error"
    existing_id: Optional[UUID] = None
    changes: dict[str, dict] = Field(default_factory=dict)  # {field: {old, new}}
    error: Optional[str] = None


class NodeSpecCsvPreviewResponse(BaseModel):
    dry_run: bool
    insert_count: int
    update_count: int
    skip_count: int
    error_count: int
    diffs: list[NodeSpecCsvDiff]


class NodeSpecCsvApplyResponse(BaseModel):
    inserted: int
    updated: int
    skipped: int
    errors: list[str]
    items: list[NodeServerSpecOut]


class NodeSpecHostFactsCollectRequest(BaseModel):
    """SSH로 bond/디스크/VM 정보를 수집해 node_server_specs에 반영."""
    hosts: list[str] = Field(..., min_length=1, max_length=500)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: Optional[str] = None
    private_key: Optional[str] = None
    port: int = Field(default=22, ge=1, le=65535)
    use_sudo: bool = False
    connect_timeout: int = Field(default=8, ge=1, le=60)
    exec_timeout: int = Field(default=20, ge=1, le=120)
    parallelism: int = Field(default=10, ge=1, le=100)
    chunk_size: int = Field(default=30, ge=1, le=500)
    chunk_pause_ms: int = Field(default=200, ge=0, le=10000)
    upsert: bool = True


class NodeSpecHostFactsItem(BaseModel):
    host: str
    status: str
    message: Optional[str] = None
    spec_id: Optional[UUID] = None
    hostname: Optional[str] = None
    bond0_ip: Optional[str] = None
    bond1_ip: Optional[str] = None
    disk_count: Optional[int] = None
    disk_total_gb: Optional[int] = None
    non_os_disk_gb: Optional[int] = None
    disk_type: Optional[str] = None
    is_ssd: Optional[bool] = None
    is_vm: Optional[bool] = None


class NodeSpecHostFactsCollectResponse(BaseModel):
    cluster_id: UUID
    updated: int
    inserted: int
    skipped: int
    errors: list[str] = Field(default_factory=list)
    items: list[NodeSpecHostFactsItem] = Field(default_factory=list)
