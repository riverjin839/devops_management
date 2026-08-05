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
    # 실행자 스냅샷 — 스케줄(trigger="schedule") 실행은 사람이 아니므로 항상 None.
    triggered_by_username: Optional[str] = None
    host: Optional[str] = None
    executed_command: Optional[str] = None
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    error: Optional[str] = None
    # 이 실행에 실제로 사용된 merge 후 파라미터(예: k8s_job_cleanup 의 dry_run) — admin 감사용.
    params_snapshot: Optional[dict[str, Any]] = None
    # 단계별 실행 trace + 실측 명령 기록 — top-level 클린 필드명으로 노출
    # (details._steps 류의 `_` 접두 키는 프론트 camelize 인터셉터가 이름을 망가뜨림).
    steps: Optional[list[dict[str, Any]]] = None
    commands: Optional[list[dict[str, Any]]] = None
    duration_ms: int = 0
    started_at: datetime
    finished_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BatchJobRunListResponse(BaseModel):
    data: list[BatchJobRunResponse]


class BatchJobStopResponse(BaseModel):
    """POST /{id}/stop 응답.

    ``interrupted`` 는 실제 프로세스 강제종료(SSH 채널 close / kubectl kill /
    Celery revoke)가 시도됐는지를 나타낸다 — best-effort 이므로 True 라도
    원격 프로세스가 즉시 죽었다는 보장은 아니다. ``run`` 의 DB 상태(cancelled)는
    interrupted 여부와 무관하게 항상 정확하다.
    """
    stopped: bool
    interrupted: bool
    message: str
    run: Optional[BatchJobRunResponse] = None


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


class BatchJobPreflightCheck(BaseModel):
    """non-SSH(K8s) 잡 사전 점검의 개별 체크 결과 — /clusters/{id}/verify 와 동일 형태."""
    check: str
    ok: Optional[bool] = None  # None = 선행 단계 실패로 확인 불가
    detail: str = ""


class BatchJobTestConnectionResponse(BaseModel):
    status: str  # ok | auth_error | connect_error | timeout | error
    latency_ms: int
    host: str
    port: int
    username: str
    used_saved_password: bool
    used_saved_private_key: bool
    error: Optional[str] = None
    # ssh: 기존 단일 SSH 연결 검증 / k8s: kubeconfig→kubectl→API→RBAC 단계별 사전 점검
    mode: str = "ssh"
    checks: list[BatchJobPreflightCheck] = []


class BatchJobTypeDescriptor(BaseModel):
    job_type: str
    label: str
    description: str = ""
    param_schema: dict[str, dict[str, Any]] = {}
    default_params: dict[str, Any] = {}
    requires_ssh: bool = True
    # 정적 실행 단계 계획 [{"id","label"}] — 실행 전에도 타임라인을 그릴 수 있게.
    step_plan: list[dict[str, str]] = []


class BatchJobTypeListResponse(BaseModel):
    data: list[BatchJobTypeDescriptor]
