from datetime import datetime
from typing import Optional, Any
from uuid import UUID
from pydantic import BaseModel, Field, model_validator


class PlaybookBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    # 신규: DB 에 저장된 Playbook 파일 / Inventory 참조 (선호)
    playbook_file_id: Optional[UUID] = None
    inventory_id: Optional[UUID] = None
    # 구: 호스트 경로 직접 지정 (호환을 위해 유지). 둘 중 하나는 채워져야 한다.
    playbook_path: Optional[str] = Field(default=None, max_length=500)
    inventory_path: Optional[str] = None
    extra_vars: Optional[dict[str, Any]] = None
    tags: Optional[str] = None


class PlaybookCreate(PlaybookBase):
    cluster_id: UUID

    @model_validator(mode="after")
    def _require_source(self) -> "PlaybookCreate":
        if not self.playbook_file_id and not (self.playbook_path and self.playbook_path.strip()):
            raise ValueError("playbook_file_id 또는 playbook_path 중 하나는 필수입니다")
        return self


class PlaybookUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    playbook_file_id: Optional[UUID] = None
    inventory_id: Optional[UUID] = None
    playbook_path: Optional[str] = None
    inventory_path: Optional[str] = None
    extra_vars: Optional[dict[str, Any]] = None
    tags: Optional[str] = None
    show_on_dashboard: Optional[bool] = None


class PlaybookResponse(PlaybookBase):
    id: UUID
    cluster_id: UUID
    status: str = "unknown"
    show_on_dashboard: bool = False
    last_run_at: Optional[datetime] = None
    last_result: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime
    # 표시 편의 — joined 된 파일/인벤토리 이름
    playbook_file_name: Optional[str] = None
    inventory_name: Optional[str] = None

    class Config:
        from_attributes = True


class PlaybookListResponse(BaseModel):
    data: list[PlaybookResponse]


class PlaybookRunRequest(BaseModel):
    """Playbook 실행 시 인라인으로 전달되는 SSH 자격증명.

    - DB 에는 저장하지 않는다 (휘발성). bulk_exec 의 패턴을 따른다.
    - inventory 에 이미 ansible_user / ansible_ssh_pass 등이 들어있으면 그쪽이 우선.
    - 비어있는 채로 실행하면 동적 inventory 만 채워지고 인증 실패가 날 수 있음.
    """
    ssh_username: Optional[str] = Field(default=None, max_length=64)
    ssh_password: Optional[str] = Field(default=None, max_length=255)
    ssh_private_key: Optional[str] = Field(default=None)  # PEM 본문
    ssh_port: Optional[int] = Field(default=None, ge=1, le=65535)
    become: Optional[bool] = Field(default=None, description="sudo 권한 상승 (true) / 일반 사용자 (false)")
    become_password: Optional[str] = Field(default=None, max_length=255)


class PlaybookRunResponse(BaseModel):
    id: UUID
    status: str
    message: str
    stats: Optional[dict[str, Any]] = None
    duration_ms: int = 0


class PlaybookRunHistoryEntry(BaseModel):
    """D-066 — ``playbook_runs`` 이력 1건(``Playbook.last_result`` 와 달리 append-only)."""
    id: UUID
    playbook_id: UUID
    status: str
    trigger: str
    triggered_by_username: Optional[str] = None
    message: Optional[str] = None
    stats: Optional[dict[str, Any]] = None
    raw_output: Optional[str] = None
    duration_ms: int = 0
    started_at: datetime
    finished_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PlaybookRunHistoryListResponse(BaseModel):
    data: list[PlaybookRunHistoryEntry]
