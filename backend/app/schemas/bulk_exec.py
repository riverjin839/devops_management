from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class NodeSummary(BaseModel):
    name: str
    internal_ip: Optional[str] = None
    external_ip: Optional[str] = None
    roles: list[str] = []
    ready: bool = True
    os: Optional[str] = None
    kubelet_version: Optional[str] = None


class NodeListResponse(BaseModel):
    cluster_id: UUID
    cluster_name: str
    nodes: list[NodeSummary]


class SSHTargetIn(BaseModel):
    host: str = Field(..., description="IP 또는 FQDN — 실제 SSH 접속 대상")
    name: Optional[str] = Field(default=None, description="화면에 표시할 노드 이름 (k8s 노드명)")
    cluster_id: Optional[UUID] = Field(default=None, description="이 타겟이 속한 클러스터")
    cluster_name: Optional[str] = Field(default=None, description="화면 표시용 클러스터 이름")
    # 아래 인증 정보는 target 별로 override 가능. 빈 값이면 요청 루트의 기본값을 사용.
    username: Optional[str] = None
    port: Optional[int] = None


class BulkExecRequest(BaseModel):
    cluster_id: Optional[UUID] = None  # 단일 클러스터 모드 호환용 (선택)

    action: Literal["ssh", "scp"] = "ssh"
    targets: list[SSHTargetIn] = Field(..., min_length=1, max_length=2000)

    # SSH / SCP 공용 인증
    username: str = Field(default="root", min_length=1, max_length=64)
    port: int = Field(default=22, ge=1, le=65535)
    password: Optional[str] = None
    private_key: Optional[str] = None

    # ssh
    command: Optional[str] = None
    # command 가 python 스크립트 본문일 때만 지정 — 서버가 원격 python3 인터프리터로
    # 감싸 실행한다(services/script_wrap.py). 미지정/"bash" 는 기존과 동일하게 원본 그대로.
    language: Optional[Literal["bash", "python"]] = None

    # scp
    scp_content: Optional[str] = None     # 업로드할 파일 내용
    scp_remote_path: Optional[str] = None

    mode: Literal["sequential", "parallel"] = "parallel"
    parallelism: int = Field(default=10, ge=1, le=50)
    connect_timeout: int = Field(default=8, ge=1, le=60)
    exec_timeout: int = Field(default=60, ge=1, le=600)
    # 대규모 (100+ 호스트) 안정성 — 청크 단위로 처리해 베스천/메모리 부담 완화
    chunk_size: int = Field(default=30, ge=1, le=200,
                            description="한 청크에서 병렬 실행할 호스트 수 (parallelism 이 실제 동시실행 상한)")
    chunk_pause_ms: int = Field(default=200, ge=0, le=5000,
                                description="청크 사이 휴지 시간 (ms). 베스천 burst 부하 완화")


class BulkExecResultItem(BaseModel):
    host: str
    name: Optional[str] = None             # 사용자가 선택한 노드 이름 (있으면 화면에 우선 표시)
    cluster_id: Optional[UUID] = None
    cluster_name: Optional[str] = None
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: Optional[str] = None


class BulkExecResponse(BaseModel):
    action: Literal["ssh", "scp"]
    mode: Literal["sequential", "parallel"]
    total: int
    ok_count: int
    error_count: int
    total_duration_ms: int
    results: list[BulkExecResultItem]


class FetchFileRequest(BaseModel):
    """SCP 업로드 내용 입력을 다른 노드에 이미 있는 텍스트 파일로 채운다(pull).
    업로드 대상(targets)과는 별개 — 이 요청은 "원본" 노드 하나에서만 읽어온다."""
    host: str = Field(..., description="읽어올 원본 노드 — IP 또는 FQDN")
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: Optional[str] = None
    private_key: Optional[str] = None
    remote_path: str = Field(..., min_length=1, max_length=4096)
    connect_timeout: int = Field(default=8, ge=1, le=60)


class FetchFileResponse(BaseModel):
    host: str
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    content: str = ""
    size: int = 0
    error: Optional[str] = None
    # 어느 단계(연결/파일확인/읽기)에서 무엇을 시도했는지 — 연결 실패 시 "왜"를
    # 화면에서 바로 보여주기 위함. batch_job 실행 추적(steps/commands)과 동일 shape.
    steps: list[dict[str, Any]] = []
    commands: list[dict[str, Any]] = []
