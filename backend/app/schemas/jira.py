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
    # 같은 IdP 로 SSO 연동되는 Confluence Base URL — 설정 시 SSO 폼 로그인이 Jira 와
    # Confluence 세션을 한 번에 캡처한다(빈 값이면 Jira 만).
    confluence_base_url: str = ""
    # (선택) IdP 로그인 페이지 URL. 자동 탐색이 실패하는 배포에서 이 주소를 지정하면
    # SSO 폼 로그인이 여기부터 시작한다. 예: https://login.example.com/sso/am/jira/login.jsp
    sso_login_url: str = ""


class JiraConfigUpdate(BaseModel):
    base_url: Optional[str] = None
    enabled: Optional[bool] = None
    verify_tls: Optional[bool] = None
    default_project_key: Optional[str] = None
    confluence_base_url: Optional[str] = None
    sso_login_url: Optional[str] = None


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
    # 파드 내 SSO 폼 자동 로그인용 로그인 정보가 저장돼 있는지 (원클릭 재로그인 가능 여부).
    has_sso_login: bool = False
    # SSO 로그인이 캡처한 Confluence 세션이 저장돼 있는지.
    has_confluence: bool = False


class JiraCredentialUpdate(BaseModel):
    # PAT 문자열 또는 세션 쿠키 문자열 (auth_type 에 따라 해석). 둘 다 token_encrypted 에 암호화 저장.
    token: str
    auth_type: JiraAuthType = "pat"
    jira_account: Optional[str] = None


class JiraTestResult(BaseModel):
    ok: bool
    detail: str = ""
    display_name: Optional[str] = None


class JiraSsoLoginRequest(BaseModel):
    """파드 내 SSO 폼 자동 로그인 요청.

    - username+password 지정 → 파드에서 브라우저 없이 폼 로그인(httpx) 수행.
      save_login=True 면 로그인 정보를 암호화 저장해 다음부터 원클릭 재로그인.
    - use_saved=True → 저장된 로그인 정보로 재로그인 (입력 불필요).
    - 아무것도 없으면 → 기존 서버측 Playwright 헤디드 로그인(화면 있는 배포 전용).
    """
    username: Optional[str] = None
    password: Optional[str] = None
    save_login: bool = False
    use_saved: bool = False


class JiraSsoLoginResult(BaseModel):
    """SSO 자동 로그인 결과 — 성공 시 세션 쿠키가 자동 저장(auth_type='sso')됐음."""
    ok: bool
    detail: str = ""
    jira_account: Optional[str] = None
    display_name: Optional[str] = None
    # Confluence 동시 로그인 결과 — None 이면 Confluence 미설정(시도 안 함).
    confluence_ok: Optional[bool] = None
    confluence_detail: str = ""


class SsoDiagnoseEntry(BaseModel):
    """백엔드(파드)가 각 진입 경로에서 실제로 본 페이지 요약 — 로그인 실패 원인 판별용."""
    product: str = ""
    url: str = ""
    final_url: str = ""
    http_status: Optional[int] = None
    content_type: str = ""
    title: str = ""
    forms: int = 0
    password_inputs: int = 0
    input_names: list[str] = []
    # 폼의 hidden 상태값 (예: OpenAM `encoded=true` → 자격을 base64 로 보내야 함).
    hidden_fields: dict[str, str] = {}
    client_redirect: str = ""
    www_authenticate: str = ""
    error: str = ""


class SsoDiagnoseResult(BaseModel):
    ok: bool
    detail: str = ""
    entries: list[SsoDiagnoseEntry] = []


# ── Confluence (Jira 와 같은 IdP 세션으로 연동) ─────────────────────────────────
class ConfluenceSearchItem(BaseModel):
    id: str
    title: str
    type: str = ""
    space_key: str = ""
    url: str = ""
    updated: str = ""


class ConfluenceSearchResult(BaseModel):
    status: Literal["ok", "offline", "error"]
    detail: str = ""
    total: int = 0
    items: list[ConfluenceSearchItem] = []


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
