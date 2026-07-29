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
    # (선택) IdP 로그인 폼의 계정 필드명 — 자동 추정이 빗나갈 때 지정(예: empnum).
    sso_username_field: str = ""
    # (선택) IdP 로그인 페이지 URL. 자동 탐색이 실패하는 배포에서 이 주소를 지정하면
    # SSO 폼 로그인이 여기부터 시작한다. 예: https://login.example.com/sso/am/jira/login.jsp
    sso_login_url: str = ""
    # Jira Epic Link 커스텀 필드 ID (예: customfield_10008) — 진척률의 Epic 축.
    jira_epic_field: str = ""


class JiraConfigUpdate(BaseModel):
    base_url: Optional[str] = None
    enabled: Optional[bool] = None
    verify_tls: Optional[bool] = None
    default_project_key: Optional[str] = None
    confluence_base_url: Optional[str] = None
    sso_login_url: Optional[str] = None
    sso_username_field: Optional[str] = None
    jira_epic_field: Optional[str] = None


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
    # 이 페이지에서 계정을 채울 필드명 / base64 인코딩 요구 여부.
    username_field: str = ""
    wants_base64: bool = False
    # 로그인 폼의 action / 전체 필드(name:type) / 로드하는 스크립트 / 클라이언트 암호화 흔적.
    login_form_action: str = ""
    login_fields: list[str] = []
    scripts: list[str] = []
    crypto_hints: list[str] = []
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
    # 이 파드가 대상으로 나갈 때의 출발지 IP/호스트명 — SSO 가 클라이언트 IP 를 검사하는
    # 구성이면 허용 목록 등록에 필요하고, 파드마다 다르면 그 자체가 문제 신호다.
    pod_hostname: str = ""
    pod_source_ip: str = ""


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
    """가져오기 조건. `scope="filter"` 면 project/labels/components/statuses 를 AND 로 묶어
    JQL 을 조립한다(빈 항목은 무시). 기존 me/project/jql 은 그대로 유지."""
    scope: Literal["me", "project", "jql", "filter"] = "me"
    project_key: Optional[str] = None
    jql: Optional[str] = None
    labels: list[str] = []
    components: list[str] = []
    statuses: list[str] = []
    assignee: Optional[str] = None          # Jira 계정명 (비우면 전체)
    updated_since_days: Optional[int] = None  # 최근 N일 내 변경분만
    dry_run: bool = False
    # dry_run 미리보기에서 사용자가 고른 Jira 키만 반영 (비우면 전체 적용).
    only_keys: list[str] = []


class JiraFieldChange(BaseModel):
    """재가져오기 시 바뀌는 필드 (확인 팝업에서 그대로 보여준다)."""
    field: str
    label: str = ""
    old: str = ""
    new: str = ""


class JiraImportItemPreview(BaseModel):
    jira_key: str
    title: str
    kanban_status: str
    action: Literal["create", "update", "unchanged"]
    changes: list[JiraFieldChange] = []


class JiraImportResult(BaseModel):
    # missing — 연결된 이슈를 Jira 에서 찾을 수 없음(삭제됐거나 내 권한으로 안 보임).
    # 서버가 둘을 구분할 수 없으므로 자동 정리하지 않고 이 상태로 알리기만 한다.
    status: Literal["ok", "offline", "error", "missing"]
    # 실제로 Jira 에 보낸 JQL — 조건이 의도대로 조립됐는지 화면에서 그대로 확인한다.
    applied_jql: str = ""
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


# ── PEP → Jira 신규 생성 / 삭제 ────────────────────────────────────────────────
class JiraCreateRequest(BaseModel):
    """PEP 에서 Jira 이슈를 새로 만든다. work_item_id 를 주면 그 업무의 내용을 쓰고
    생성된 키를 그 업무에 연결한다(미지정 시 아래 필드로 직접 생성)."""
    work_item_id: Optional[str] = None
    project_key: Optional[str] = None       # 미지정 시 공통 설정의 default_project_key
    summary: Optional[str] = None
    description: Optional[str] = None
    issue_type: str = "Task"
    priority: Optional[str] = None
    labels: list[str] = []
    components: list[str] = []


class JiraCreateResult(BaseModel):
    status: Literal["ok", "error", "offline"]
    detail: str = ""
    jira_key: Optional[str] = None
    jira_url: Optional[str] = None
    linked_work_item_id: Optional[str] = None


class JiraDeleteResult(BaseModel):
    status: Literal["ok", "error", "offline"]
    detail: str = ""
    unlinked_work_item_id: Optional[str] = None


# ── 주간보고 ──────────────────────────────────────────────────────────────────
class WeeklySummary(BaseModel):
    total: int = 0
    in_progress: int = 0
    done: int = 0
    delayed: int = 0
    note: str = ""


class WeeklyDetailRow(BaseModel):
    component: str = ""
    # task = Jira Epic, sub_task = 그 Epic 아래 이슈(현재 행).
    task: str = ""
    epic_key: str = ""
    epic_name: str = ""
    epic_url: str = ""
    sub_task: str = ""
    start: str = ""
    due: str = ""
    closed: str = ""
    status: str = ""
    issue: str = ""
    note: str = ""
    jira_key: str = ""
    jira_url: str = ""


class WeeklyOwnerRow(BaseModel):
    task: str = ""
    assignee: str = ""
    main_work: str = ""
    issue_summary: str = ""


class WeeklyProgressRow(BaseModel):
    """진척률 — category(Jira component) × task(Epic) 단위 집계."""
    category: str = ""
    epic: str = ""
    epic_key: str = ""
    epic_name: str = ""
    epic_url: str = ""
    planned_rate: int = 0        # 계획진도율(%) — 일정 경과 기준
    actual_rate: int = 0         # 실적진도율(%) — 완료 비율
    achievement_rate: int = 0    # 달성률(%) — 실적/계획
    done_count: int = 0
    in_progress_count: int = 0
    total_count: int = 0


class WeeklyReport(BaseModel):
    period_start: str = ""
    period_end: str = ""
    title: str = ""
    summary: WeeklySummary = WeeklySummary()
    progress: list[WeeklyProgressRow] = []
    details: list[WeeklyDetailRow] = []
    owners: list[WeeklyOwnerRow] = []


class WeeklyReportRequest(BaseModel):
    """미리보기/게시 요청. week_of 는 그 주(월~금)를 고른다(미지정 시 이번 주)."""
    week_of: Optional[str] = None            # "YYYY-MM-DD"
    project_filter: str = ""


class WeeklyPublishRequest(WeeklyReportRequest):
    """Confluence 게시 — 저장 위치는 매 요청마다 바꿀 수 있다."""
    space_key: Optional[str] = None          # 미지정 시 설정값
    parent_page_id: Optional[str] = None
    title: Optional[str] = None              # 미지정 시 "주간보고 YYYY-MM-DD ~ YYYY-MM-DD"


class WeeklyPublishResult(BaseModel):
    status: Literal["ok", "error", "offline"]
    detail: str = ""
    action: str = ""                          # created | updated
    page_url: Optional[str] = None
    page_id: Optional[str] = None


class WeeklyReportSettings(BaseModel):
    """주간보고 기본 저장 위치/자동 생성 설정 (AppSetting)."""
    # Jira WBS/간트 차트 링크 — 진척률 표 위에 노출.
    gantt_url: str = ""
    space_key: str = ""
    parent_page_id: str = ""
    title_template: str = "주간보고 {start} ~ {end}"
    auto_enabled: bool = False
    auto_cron: str = "0 17 * * 5"             # 금요일 17:00 (UTC 기준 평가)
    project_filter: str = ""


# ── 업무 등록 시 Jira + Confluence 동시 생성 (프로비저닝) ────────────────────────
class ProvisionDefaults(BaseModel):
    """사용자/설정 기반 기본값 — 화면에 채워 보여주고 사용자가 수정할 수 있다."""
    jira_enabled: bool = False
    confluence_enabled: bool = False
    project_key: str = ""
    issue_type: str = "Task"
    priority: str = ""
    labels: list[str] = []
    components: list[str] = []
    summary: str = ""
    description: str = ""
    space_key: str = ""
    parent_page_id: str = ""
    page_title: str = ""
    reporter: str = ""            # 표시용 — 내 Jira 계정
    detail: str = ""              # 준비 상태 안내(미설정 항목 등)
    # Jira 계층 — task = Epic, sub task = Epic 아래 이슈. epic_key 는 Epic Link,
    # parent_key 는 Sub-task 의 상위 이슈(둘 중 하나만 쓰는 게 보통이다).
    epic_key: str = ""
    parent_key: str = ""
    # 이 기본값이 **내가 지난번에 쓴 조건**(user preset)에서 왔는지, 관리자 공통 설정에서
    # 왔는지 — 화면에서 "저장된 조건을 불러왔습니다" 안내를 띄우는 데 쓴다.
    preset_source: Literal["none", "settings", "user"] = "settings"


class ProvisionRequest(BaseModel):
    """업무를 Jira 이슈 + Confluence 문서로 함께 생성한다. 항목별로 끌 수 있다."""
    work_item_id: str
    create_jira: bool = True
    create_confluence: bool = True
    # Jira
    project_key: Optional[str] = None
    issue_type: str = "Task"
    priority: Optional[str] = None
    labels: list[str] = []
    components: list[str] = []
    summary: Optional[str] = None
    description: Optional[str] = None
    # Jira 계층 — Epic Link(epic_key) 또는 Sub-task 상위 이슈(parent_key).
    epic_key: Optional[str] = None
    parent_key: Optional[str] = None
    # Confluence
    space_key: Optional[str] = None
    parent_page_id: Optional[str] = None
    page_title: Optional[str] = None
    page_body: Optional[str] = None   # 비우면 업무 내용으로 기본 문서를 만든다
    # 이번에 쓴 기준 조건(프로젝트/종류/라벨/컴포넌트/Epic/스페이스)을 내 기본값으로
    # 저장할지. 켜두면 다음 업무 등록 때 자동으로 채워진다(화면에서 언제든 수정 가능).
    remember_preset: bool = True


class ProvisionResult(BaseModel):
    status: Literal["ok", "partial", "error", "offline"]
    detail: str = ""
    jira_key: Optional[str] = None
    jira_url: Optional[str] = None
    jira_detail: str = ""
    confluence_page_id: Optional[str] = None
    confluence_url: Optional[str] = None
    confluence_detail: str = ""


# ── 연결 복구 (해제 / 갈아끼우기 / 고아 점검) ──────────────────────────────────
class JiraUnlinkRequest(BaseModel):
    """PEP 업무의 Jira 연결만 끊는다 — **Jira 이슈는 건드리지 않는다**
    (Jira 에서 지우는 것은 `DELETE /jira/issue/{key}`)."""
    # true 면 업무 행 자체도 삭제. Jira 에서 이미 지운 이슈의 잔재 행을 정리하는 용도라
    # 삭제 권한은 업무 삭제와 동일 규칙(등록자/담당자/admin)을 따른다.
    delete_work_item: bool = False


class JiraUnlinkResult(BaseModel):
    status: Literal["ok", "error"]
    detail: str = ""
    work_item_id: Optional[str] = None
    work_item_deleted: bool = False


class JiraRelinkRequest(BaseModel):
    """연결을 다른 이슈로 갈아끼운다. 이슈 키 또는 브라우저 URL 을 그대로 받는다."""
    key_or_url: str


class JiraRelinkResult(BaseModel):
    status: Literal["ok", "error", "offline", "missing"]
    detail: str = ""
    jira_key: Optional[str] = None
    jira_url: Optional[str] = None


class JiraMissingLink(BaseModel):
    work_item_id: str
    jira_key: str
    title: str = ""
    detail: str = ""


class JiraVerifyLinksResult(BaseModel):
    status: Literal["ok", "error", "offline"]
    detail: str = ""
    checked: int = 0
    # Jira 에서 찾지 못한 연결. 삭제됐을 수도, 내 권한으로 안 보일 수도 있어
    # 자동 정리하지 않고 사용자가 골라 처리하게 한다.
    missing: list[JiraMissingLink] = []
    truncated: bool = False
