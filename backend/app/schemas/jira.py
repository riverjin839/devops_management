"""Jira 연동 pydantic 스키마."""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel


# ── 공통 설정 (관리자, AppSetting key=jira_integration) ──────────────────────────
class JiraConfig(BaseModel):
    base_url: str = ""
    enabled: bool = False
    verify_tls: bool = True
    default_project_key: Optional[str] = None


class JiraConfigUpdate(BaseModel):
    base_url: Optional[str] = None
    enabled: Optional[bool] = None
    verify_tls: Optional[bool] = None
    default_project_key: Optional[str] = None


# ── 사용자별 자격증명 ──────────────────────────────────────────────────────────
class JiraCredentialStatus(BaseModel):
    configured: bool
    jira_account: Optional[str] = None
    last_verified_at: Optional[datetime] = None


class JiraCredentialUpdate(BaseModel):
    token: str
    jira_account: Optional[str] = None


class JiraTestResult(BaseModel):
    ok: bool
    detail: str = ""
    display_name: Optional[str] = None


# ── 가져오기 ──────────────────────────────────────────────────────────────────
class JiraImportRequest(BaseModel):
    scope: Literal["me", "project", "jql"] = "me"
    project_key: Optional[str] = None
    jql: Optional[str] = None
    dry_run: bool = False


class JiraImportItemPreview(BaseModel):
    jira_key: str
    title: str
    kanban_status: str
    action: Literal["create", "update"]


class JiraImportResult(BaseModel):
    status: Literal["ok", "offline", "error"]
    imported: int = 0
    updated: int = 0
    skipped: int = 0
    total: int = 0
    truncated: bool = False
    dry_run: bool = False
    detail: str = ""
    errors: list[str] = []
    items: list[JiraImportItemPreview] = []


# ── 양방향 push (Phase 2) ──────────────────────────────────────────────────────
class JiraPushRequest(BaseModel):
    comment: Optional[str] = None
    force: bool = False     # Jira 쪽이 더 최신이어도 덮어쓰기


class JiraPushResult(BaseModel):
    status: Literal["ok", "conflict", "error", "offline", "not_linked"]
    detail: str = ""
    transitioned: bool = False
    comment_added: bool = False
    jira_status: Optional[str] = None
    available_transitions: list[str] = []
