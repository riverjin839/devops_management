"""노드 이미지 배포(prepull) 스키마.

특정 노드에서 확인한 컨테이너 이미지를, 아직 해당 이미지가 없는 다른 노드(동일/타
클러스터)로 배포한다. 배포 방식은 대상 노드에서 컨테이너 런타임 CLI(crictl/nerdctl/
ctr)로 이미지를 레지스트리에서 다시 pull 하는 것이다 — 대용량 tar 전송 없이 병렬로
동작하며, 대상 노드가 이미지 레지스트리에 도달 가능해야 한다.

인증 정보(SSH password / private_key)는 요청에만 존재하고 저장되지 않는다
(bulk_exec 와 동일 정책).
"""
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class DistributeTargetIn(BaseModel):
    host: str = Field(..., description="IP 또는 FQDN — 실제 SSH 접속 대상")
    name: Optional[str] = Field(default=None, description="화면 표시용 노드 이름 (k8s 노드명)")
    cluster_id: Optional[UUID] = Field(default=None, description="이 타겟이 속한 클러스터")
    cluster_name: Optional[str] = Field(default=None, description="화면 표시용 클러스터 이름")


class NodeImageDistributeRequest(BaseModel):
    # 배포할 이미지 참조 (예: registry.example.com/foo/bar:1.2.3 또는 ...@sha256:...)
    image: str = Field(..., min_length=1, max_length=512)

    targets: list[DistributeTargetIn] = Field(..., min_length=1, max_length=2000)

    # 컨테이너 런타임 선택. auto = crictl → nerdctl → ctr 순서로 자동 감지.
    runtime: Literal["auto", "crictl", "nerdctl", "ctr"] = "auto"
    # nerdctl / ctr 에서 사용하는 containerd 네임스페이스 (crictl 은 CRI 라 무관).
    namespace: str = Field(default="k8s.io", min_length=1, max_length=128)
    # 런타임 명령을 sudo 로 감쌀지 여부 (비 root 계정으로 접속 시 필요).
    sudo: bool = False

    # SSH 인증 — password 또는 private_key 중 하나 필수.
    username: str = Field(default="root", min_length=1, max_length=64)
    port: int = Field(default=22, ge=1, le=65535)
    password: Optional[str] = None
    private_key: Optional[str] = None

    # 실행 튜닝 (bulk_exec 와 동일 개념)
    mode: Literal["sequential", "parallel"] = "parallel"
    parallelism: int = Field(default=5, ge=1, le=50)
    connect_timeout: int = Field(default=8, ge=1, le=60)
    # 이미지 pull 은 오래 걸릴 수 있어 기본 exec_timeout 을 넉넉히(600s).
    exec_timeout: int = Field(default=600, ge=10, le=3600)
    chunk_size: int = Field(default=10, ge=1, le=200)
    chunk_pause_ms: int = Field(default=200, ge=0, le=5000)


class DistributeResultItem(BaseModel):
    host: str
    name: Optional[str] = None
    cluster_id: Optional[UUID] = None
    cluster_name: Optional[str] = None
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: Optional[str] = None


class NodeImageDistributeResponse(BaseModel):
    image: str
    # 대상 노드에서 실제 실행된 명령(마스킹 없음 — 자격증명 미포함).
    command: str
    mode: Literal["sequential", "parallel"]
    total: int
    ok_count: int
    error_count: int
    total_duration_ms: int
    results: list[DistributeResultItem]
