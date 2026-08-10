from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

ScriptKind = Literal["python", "ansible_playbook", "shell"]


class ExecutableScriptVersionResponse(BaseModel):
    id: UUID
    script_id: UUID
    version: int
    content: str
    inventory_content: Optional[str] = None
    param_schema: Optional[list[dict[str, Any]]] = None
    changelog: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ExecutableScriptVersionCreate(BaseModel):
    """새 버전 생성 — "저장" 버튼의 실제 동작. content 는 전량 교체, 부분 patch 없음."""
    content: str = Field(..., min_length=1)
    inventory_content: Optional[str] = None
    param_schema: Optional[list[dict[str, Any]]] = None
    changelog: Optional[str] = Field(default=None, max_length=500)


class ExecutableScriptBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    kind: ScriptKind
    tags: Optional[list[str]] = None


class ExecutableScriptCreate(ExecutableScriptBase):
    # 최초 버전(version=1)을 스크립트와 함께 생성한다.
    content: str = Field(..., min_length=1)
    inventory_content: Optional[str] = None
    param_schema: Optional[list[dict[str, Any]]] = None
    changelog: Optional[str] = Field(default=None, max_length=500)


class ExecutableScriptUpdate(BaseModel):
    """메타데이터만 수정 — content 변경은 /versions 엔드포인트 전용(§API 명세)."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    tags: Optional[list[str]] = None


class ExecutableScriptResponse(ExecutableScriptBase):
    id: UUID
    is_system: bool
    current_version_id: Optional[UUID] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # 목록/상세 모두 현재 버전 내용을 바로 쓸 수 있도록 embed — 별도 조회 왕복 없앰.
    current_version: Optional[ExecutableScriptVersionResponse] = None
    # "어디서 쓰이나" 역참조 개수 — Phase 2(BatchJob 연결)부터 0 이상이 된다.
    used_by_count: int = 0

    class Config:
        from_attributes = True


class ExecutableScriptCurrentVersionUpdate(BaseModel):
    """이 버전을 기본으로 지정 — 롤백도 이 엔드포인트로 처리(새 버전 생성 없이 포인터만 이동)."""
    version_id: UUID


class ScriptTestRunTarget(BaseModel):
    kind: Literal["ssh", "cluster"]
    host: Optional[str] = None
    port: int = 22
    username: str = "root"
    # 절대 저장되지 않음 — 요청 처리 중에만 사용(기존 SSH 수집 모달들과 동일 원칙).
    password: Optional[str] = None
    private_key: Optional[str] = None
    cluster_id: Optional[UUID] = None


class ScriptTestRunRequest(BaseModel):
    # 저장 전 초안도 테스트 가능(버전 저장 없이) — 현재 버전 content 와 무관하게 그대로 실행.
    content: str = Field(..., min_length=1)
    inventory_content: Optional[str] = None
    target: ScriptTestRunTarget
    params: Optional[dict[str, Any]] = None


class ExecutionStepOut(BaseModel):
    id: str
    label: str
    status: str
    detail: str = ""
    started_ms: int = 0
    duration_ms: int = 0


class ExecutedCommandOut(BaseModel):
    kind: str
    command: str
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: Optional[int] = None
    truncated: bool = False


class ScriptTestRunResponse(BaseModel):
    status: str  # ok | error | timeout | auth_error | connect_error
    steps: list[ExecutionStepOut] = []
    commands: list[ExecutedCommandOut] = []
    stdout: str = ""
    stderr: str = ""
    exit_code: Optional[int] = None
    duration_ms: int = 0
    error: Optional[str] = None
