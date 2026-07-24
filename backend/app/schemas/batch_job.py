from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class BatchJobBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    description: Optional[str] = None
    job_type: str = Field(..., min_length=1, max_length=80)
    default_host: Optional[str] = None
    default_port: int = 22
    default_username: str = "root"
    params: Optional[dict[str, Any]] = None
    cron: Optional[str] = None
    enabled: bool = True


class BatchJobCreate(BatchJobBase):
    cluster_id: UUID
    # Optional saved credentials for scheduled runs. Plaintext on the way
    # in; the router encrypts before persisting. Manual runs do not need
    # these — they pass credentials per-request.
    saved_password: Optional[str] = None
    saved_private_key: Optional[str] = None


class BatchJobUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    default_host: Optional[str] = None
    default_port: Optional[int] = None
    default_username: Optional[str] = None
    params: Optional[dict[str, Any]] = None
    cron: Optional[str] = None
    enabled: Optional[bool] = None
    # `null` clears the saved secret; omitting the field leaves it unchanged.
    saved_password: Optional[str] = None
    saved_private_key: Optional[str] = None
    clear_saved_password: bool = False
    clear_saved_private_key: bool = False


class BatchJobResponse(BatchJobBase):
    id: UUID
    cluster_id: UUID
    last_status: str = "unknown"
    last_run_at: Optional[datetime] = None
    last_schedule_check_at: Optional[datetime] = None
    last_schedule_note: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # We never return the ciphertext; just whether something is saved.
    has_saved_password: bool = False
    has_saved_private_key: bool = False
    # Executor 특성 — False 면 host/SSH 자격증명 없이 실행되는 클러스터 스코프 잡.
    requires_ssh: bool = True

    class Config:
        from_attributes = True


class BatchJobListResponse(BaseModel):
    data: list[BatchJobResponse]


class BatchJobRunRequest(BaseModel):
    """Per-execution credentials and overrides. Credentials are NOT persisted."""
    host: Optional[str] = Field(default=None, description="overrides default_host")
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    private_key: Optional[str] = None
    param_override: Optional[dict[str, Any]] = None
    timeout: int = Field(default=60, ge=1, le=600)


class BatchJobBulkRunRequest(BaseModel):
    """여러 잡(여러 클러스터)을 한 번에 백그라운드 실행. 저장된 자격증명을 사용하므로
    평문 비밀번호를 받지 않는다(스케줄 실행과 동일 보안 모델)."""
    job_ids: list[UUID] = Field(..., min_length=1)


class BatchJobBulkRunItem(BaseModel):
    job_id: UUID
    queued: bool
    reason: Optional[str] = None


class BatchJobBulkRunResponse(BaseModel):
    queued: int
    skipped: int
    results: list[BatchJobBulkRunItem]


class BatchJobRunResponse(BaseModel):
    id: UUID
    job_id: UUID
    status: str
    trigger: str
    host: Optional[str] = None
    executed_command: Optional[str] = None
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    error: Optional[str] = None
    duration_ms: int = 0
    started_at: datetime
    finished_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BatchJobRunListResponse(BaseModel):
    data: list[BatchJobRunResponse]


class BatchJobTestConnectionRequest(BaseModel):
    """자격증명/네트워크 검증용. 명령은 실행하지 않음.

    요청 자격증명이 비어있으면 잡에 저장된 자격증명으로 fallback (run 과 동일).
    timeout 은 connect_timeout 으로만 쓰이므로 짧게 잡는다.
    """
    host: Optional[str] = Field(default=None, description="overrides default_host")
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    private_key: Optional[str] = None
    timeout: int = Field(default=8, ge=1, le=30)


class BatchJobTestConnectionResponse(BaseModel):
    status: str  # ok | auth_error | connect_error | timeout | error
    latency_ms: int
    host: str
    port: int
    username: str
    used_saved_password: bool
    used_saved_private_key: bool
    error: Optional[str] = None


class BatchJobTypeDescriptor(BaseModel):
    job_type: str
    label: str
    description: str = ""
    param_schema: dict[str, dict[str, Any]] = {}
    default_params: dict[str, Any] = {}
    requires_ssh: bool = True


class BatchJobTypeListResponse(BaseModel):
    data: list[BatchJobTypeDescriptor]
