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
# 인증 방식:
#   'pat'    — Personal Access Token → Bearer
#   'cookie' — 사용자가 직접 붙여넣은 브라우저 세션 쿠키
#   'sso'    — Playwright SSO 로그인이 자동 캡처한 세션 쿠키 (REST 는 cookie 와 동일 처리)
JiraAuthType = Literal["pat", "cookie", "sso"]


class JiraCredentialStatus(BaseModel):
    configured: bool
    auth_type: JiraAuthType = "pat"
    jira_account: Optional[str] = None
    last_verified_at: Optional[datetime] = None


class JiraCredentialUpdate(BaseModel):
    # PAT 문자열 또는 세션 쿠키 문자열 (auth_type 에 따라 해석). 둘 다 token_encrypted 에 암호화 저장.
    token: str
    auth_type: JiraAuthType = "pat"
    jira_account: Optional[str] = None


class JiraTestResult(BaseModel):
    ok: bool
    detail: str = ""
    display_name: Optional[str] = None


class JiraSsoLoginResult(BaseModel):
    """Playwright SSO 자동 로그인 결과 — 성공 시 세션 쿠키가 자동 저장(auth_type='sso')됐음."""
    ok: bool
    detail: str = ""
    jira_account: Optional[str] = None
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


# ── Excel 가져오기 (Jira 에서 추출한 .xlsx 임포트, 미리보기 전용 — 저장하지 않음) ──────
class JiraExcelRow(BaseModel):
    key: str = ""
    jira_url: Optional[str] = None   # base_url 설정 시 {base_url}/browse/{key}
    summary: str = ""
    issue_type: str = ""
    status: str = ""
    assignee_raw: str = ""            # 엑셀 원본 ("이름 회사")
    assignee_name: Optional[str] = None  # 추출된 이름 (매칭 실패 시 원본 첫 토큰)
    assignee_matched: bool = False    # PEP 담당자 레지스트리와 매칭 성공 여부
    created: str = ""
    resolved: str = ""
    due_date: str = ""
    environment: str = ""
    description: str = ""


class JiraExcelImportResult(BaseModel):
    status: Literal["ok", "error"]
    detail: str = ""
    total: int = 0
    matched: int = 0
    rows: list[JiraExcelRow] = []


class JiraExcelPasteRequest(BaseModel):
    """엑셀/Jira 표를 복사해 붙여넣은 원본 텍스트 — 탭 구분(TSV), 브라우저 표 복사도 보통
    탭으로 붙여넣기된다. 줄바꿈은 행 구분."""
    text: str


class JiraExcelSaveRequest(BaseModel):
    """미리보기(import_excel/import_paste)로 확인한 행을 실제 work_items 로 저장.
    파일을 다시 읽지 않고 프론트가 이미 갖고 있는 미리보기 rows 를 그대로 되돌려 받는다."""
    rows: list[JiraExcelRow]


# ── 양방향 push (Phase 2) ──────────────────────────────────────────────────────
class JiraPushRequest(BaseModel):
    comment: Optional[str] = None
    force: bool = False           # Jira 쪽이 더 최신이어도 덮어쓰기
    push_fields: bool = True      # 제목(summary)/설명(description)/우선순위(priority) 반영 여부


class JiraPushResult(BaseModel):
    status: Literal["ok", "conflict", "error", "offline", "not_linked"]
    detail: str = ""
    transitioned: bool = False
    comment_added: bool = False
    fields_updated: list[str] = []   # 실제로 Jira 에 반영된 필드명 (summary/description/priority)
    field_errors: list[str] = []     # 반영 실패한 필드 사유 (예: 우선순위 이름 불일치)
    jira_status: Optional[str] = None
    available_transitions: list[str] = []
