"""Jira 연동 라우터 (prefix `/jira`).

- 공통 설정(base_url 등)은 AppSetting key=`jira_integration` (관리자 전용 쓰기).
- 사용자별 PAT 는 `user_jira_credentials` 에 암호화 저장 (secret_box).
- 가져오기는 서버사이드에서 현재 사용자 PAT 로 실행 → work_items upsert (dedup by jira_issue_id).
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import re
from datetime import datetime
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from typing import Optional

import openpyxl
import xlrd
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User
from app.models.user_jira_credential import UserJiraCredential
from app.models.work_item import WorkItem
from app.auth.deps import get_current_user, require_admin, require_operator
from app.services import secret_box
from app.services import audit_logger
from app.services.jira_service import (
    JiraService, map_jira_issue, map_issue_type, parse_jira_dt, KANBAN_TO_CATEGORY,
    PEP_PRIORITY_TO_JIRA, strip_issue_key_prefix,
)
from app.services.jira_sso_http import form_sso_login
from app.services.jira_sso_service import capture_sso_session
from app.schemas.jira import (
    JiraConfig,
    JiraConfigUpdate,
    JiraCredentialStatus,
    JiraCredentialUpdate,
    JiraTestResult,
    JiraSsoLoginRequest,
    JiraSsoLoginResult,
    JiraImportRequest,
    JiraImportResult,
    JiraImportItemPreview,
    JiraExcelRow,
    JiraExcelImportResult,
    JiraExcelPasteRequest,
    JiraExcelSaveRequest,
    JiraPushRequest,
    JiraPushResult,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/jira", tags=["jira"])

JIRA_SETTINGS_KEY = "jira_integration"
ASSIGNEES_KEY = "assignees"
DEFAULT_JIRA_SETTINGS = {
    "base_url": "",
    "enabled": False,
    "verify_tls": True,
    "default_project_key": None,
}


def _get_config(db: Session) -> dict:
    row = db.query(AppSetting).filter(AppSetting.key == JIRA_SETTINGS_KEY).first()
    value = dict(DEFAULT_JIRA_SETTINGS)
    if row and isinstance(row.value, dict):
        value.update(row.value)
    return value


def _build_assignee_resolver(db: Session):
    """Jira displayName → PEP 담당자 이름. 레지스트리(name) 와 대소문자 무시 매칭, 실패 시 원본."""
    try:
        row = db.query(AppSetting).filter(AppSetting.key == ASSIGNEES_KEY).first()
        registry = row.value if row and isinstance(row.value, list) else []
    except Exception:  # noqa: BLE001
        registry = []
    by_lower = {}
    for a in registry:
        if isinstance(a, dict) and a.get("name"):
            by_lower[str(a["name"]).strip().lower()] = str(a["name"]).strip()

    def _resolve(jira_name: str) -> str:
        return by_lower.get(jira_name.strip().lower(), jira_name.strip())

    return _resolve


def _build_assignee_roster(db: Session) -> dict[str, str]:
    """등록된 담당자 name → name (대소문자 무시 매칭용 조회 테이블)."""
    row = db.query(AppSetting).filter(AppSetting.key == ASSIGNEES_KEY).first()
    registry = row.value if row and isinstance(row.value, list) else []
    return {
        str(a["name"]).strip().lower(): str(a["name"]).strip()
        for a in registry if isinstance(a, dict) and a.get("name")
    }


def _match_excel_assignee(raw: str, roster_by_lower: dict[str, str]) -> tuple[Optional[str], bool]:
    """Jira Excel 의 담당자 셀("이름 회사")에서 이름을 추출해 담당자 레지스트리와 매칭.

    한글 이름은 공백 없는 한 토큰이 일반적이므로 첫 토큰을 이름 후보로 본다.
    실패하면 전체 문자열(회사명 없는 경우 대비)로 한 번 더 시도."""
    s = (raw or "").strip()
    if not s:
        return None, False
    first_token = s.split()[0]
    name = roster_by_lower.get(first_token.lower())
    if name:
        return name, True
    name = roster_by_lower.get(s.lower())
    if name:
        return name, True
    return first_token, False


_EXCEL_HEADER_ALIASES: dict[str, list[str]] = {
    "key": ["key", "issue key", "issue id"],
    "summary": ["summary"],
    "issue_type": ["issue type", "issuetype", "type"],
    "status": ["status"],
    "assignee": ["assignee"],
    "created": ["created"],
    "resolved": ["resolved"],
    "due_date": ["due date", "duedate"],
    "environment": ["environment"],
    "description": ["description"],
}


def _norm_excel_header(h) -> str:
    return re.sub(r"\s+", " ", str(h or "").strip().lower())


def _excel_cell_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M") if (v.hour or v.minute) else v.strftime("%Y-%m-%d")
    return str(v).strip()


_INLINE_TAG_RE = re.compile(r"<[^>]+>")


def _strip_inline_html(s: str) -> str:
    """Jira 의 HTML 기반 내보내기는 Description/Environment 같은 rich-text 필드 안에
    이스케이프된 HTML(예: `&lt;p dir="auto"&gt;...&lt;/p&gt;`)이 들어있는 경우가 있다 —
    html.parser 가 엔티티를 이미 복원해버려 `<p dir="auto">...` 처럼 태그가 그대로 텍스트로
    노출된다. 태그를 제거하고 남은 텍스트만 정리해 돌려준다."""
    if not s:
        return s
    text = html.unescape(s)
    text = _INLINE_TAG_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


# Jira 날짜 표시 포맷 후보 — HTML 기반 내보내기는 날짜를 문자열로 담고(예: "11/Jun/26 10:31 AM"),
# xlsx/xls 는 네이티브 datetime 셀일 수 있어(이미 _excel_cell_str 이 "YYYY-MM-DD[ HH:MM]" 로
# 정규화) 두 경우 모두 커버한다.
_EXCEL_DATE_FORMATS = (
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%d/%b/%y %I:%M %p",
    "%d/%b/%Y %I:%M %p",
    "%d/%b/%y",
    "%d/%b/%Y",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%y %I:%M %p",
    "%m/%d/%Y",
)


def _parse_excel_date(v) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    s = str(v).strip()
    if not s:
        return None
    for fmt in _EXCEL_DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _excel_date_only(v) -> str:
    """날짜 셀을 시간 없이 "YYYY-MM-DD" 로만 표시(Created 등은 시간까지는 불필요하다는
    요청). 알려진 포맷으로 파싱되면 그 날짜를, 실패하면 첫 공백 앞부분만 보수적으로 남긴다."""
    dt = _parse_excel_date(v)
    if dt:
        return dt.strftime("%Y-%m-%d")
    s = str(v or "").strip()
    return s.split(" ")[0] if s else ""


_DONE_STATUS_WORDS = ("done", "closed", "resolved", "complete", "완료", "해결", "종료", "닫힘")
_INPROGRESS_STATUS_WORDS = ("progress", "review", "진행", "검토", "처리중", "처리 중")


def _map_excel_status_to_kanban(status_name: str) -> str:
    """엑셀에는 Jira 의 statusCategory(new/indeterminate/done) 가 없고 상태명 문자열만
    있으므로, 흔한 표기를 텍스트 매칭으로 추정한다(라이브 JQL 가져오기의
    `map_status_category` 보다 느슨함 — 커스텀 워크플로 상태명은 기본값 todo 로 떨어진다)."""
    s = (status_name or "").strip().lower()
    if any(w in s for w in _DONE_STATUS_WORDS):
        return "done"
    if any(w in s for w in _INPROGRESS_STATUS_WORDS):
        return "in_progress"
    return "todo"


def _read_xls_rows(raw: bytes):
    """.xls(레거시 바이너리) 워크북의 첫 시트를 openpyxl 의 iter_rows(values_only=True) 와
    동일한 형태(행마다 값 튜플, 날짜 셀은 datetime)로 반환. 워크북을 여는 단계(가장 흔한 실패
    지점)는 이 함수 호출 시점에 즉시 실행돼 호출부의 try/except 로 잡힌다 — 아래 _rows() 의
    행 순회만 지연 평가된다."""
    wb = xlrd.open_workbook(file_contents=raw)
    sheet = wb.sheet_by_index(0)

    def _rows():
        for row_idx in range(sheet.nrows):
            values = []
            for c in sheet.row(row_idx):
                if c.ctype == xlrd.XL_CELL_DATE:
                    try:
                        values.append(xlrd.xldate_as_datetime(c.value, wb.datemode))
                    except Exception:  # noqa: BLE001
                        values.append(c.value)
                elif c.ctype == xlrd.XL_CELL_EMPTY:
                    values.append(None)
                else:
                    values.append(c.value)
            yield tuple(values)

    return _rows()


def _looks_like_html(raw: bytes) -> bool:
    """Jira '엑셀(전체 필드)' 내보내기는 확장자가 `.xls` 지만 실제 내용은 HTML 테이블이다
    (구버전 Excel 이 확장자만 보고 열어주던 호환 방식). xlrd 는 진짜 OLE2 바이너리만 지원해
    이런 파일에 'Expected BOF record' 로 실패하므로, 업로드 시점에 먼저 감지한다."""
    head = raw[:1024].lstrip().lower()
    return head.startswith((b"<html", b"<!doctype", b"<?xml")) or b"<table" in raw[:4096].lower()


class _JiraHtmlTableExtractor(HTMLParser):
    """HTML 문서 안의 모든 <table>(중첩 포함) 을 각각 독립된 행 목록으로 추출.
    표준 라이브러리만 사용하는 최소 파서.

    과거에는 "첫 번째 <table> 만" 사용했는데, Jira 내보내기가 요약/메타 정보를 담은 작은
    표를 실제 이슈 목록 표보다 앞에 두거나(형제 테이블), 레이아웃용 바깥 테이블 <td> 안에
    실제 이슈 표를 중첩시키는 경우 모두 있어 — 첫 테이블만 보면 진짜 데이터 표를 통째로
    놓치고 "필수 컬럼을 찾을 수 없음" 오류가 났다. 테이블 스택으로 중첩을 추적해 발견되는
    모든 <table> 을 순서대로 `self.tables` 에 쌓고, 호출부가 각 표를 순회하며 Key/Summary
    헤더를 가진 표를 찾는다(아래 `_find_header` 참고)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table_stack: list[list[list[str]]] = []  # 진행 중인 표(중첩 가능) 스택
        self._row_stack: list[list[str]] = []           # 스택 위치별 현재 행 버퍼
        self._in_cell = False
        self._cell_buf: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ARG002
        if tag == "table":
            self._table_stack.append([])
            self._row_stack.append([])
        elif tag == "tr" and self._table_stack:
            self._row_stack[-1] = []
        elif tag in ("td", "th") and self._table_stack:
            self._in_cell = True
            self._cell_buf = []
        elif self._in_cell and tag == "br":
            self._cell_buf.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._in_cell:
            self._in_cell = False
            self._row_stack[-1].append("".join(self._cell_buf).strip())
        elif tag == "tr" and self._table_stack:
            self._table_stack[-1].append(self._row_stack[-1])
        elif tag == "table" and self._table_stack:
            rows = self._table_stack.pop()
            self._row_stack.pop()
            self.tables.append(rows)

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._cell_buf.append(data)


def _read_html_tables(raw: bytes) -> list[list[tuple]]:
    """Jira 의 HTML 기반 '가짜 .xls' 내보내기를 파싱해 문서 안의 모든 표를 반환한다
    (표 하나 = 행 튜플 리스트, 완전히 빈 행은 제거). 인코딩은 UTF-8 우선, 실패 시
    한글 환경에서 흔한 CP949/EUC-KR 로 재시도."""
    text: Optional[str] = None
    for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        text = raw.decode("utf-8", errors="replace")
    parser = _JiraHtmlTableExtractor()
    parser.feed(text)
    return [
        [tuple(r) for r in table if any(v for v in r)]
        for table in parser.tables
    ]


def _user_credential(db: Session, username: str) -> tuple[Optional[str], str]:
    """사용자별 Jira 자격 (복호화된 secret, auth_type) 반환. 미등록/복호화 실패 시 (None, 'pat')."""
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == username).first()
    if not cred:
        return None, "pat"
    auth_type = (getattr(cred, "auth_type", None) or "pat").strip().lower()
    try:
        return secret_box.decrypt(cred.token_encrypted), auth_type
    except ValueError:
        return None, auth_type


# ── 공통 설정 ──────────────────────────────────────────────────────────────────
@router.get("/config", response_model=JiraConfig)
def get_config(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return JiraConfig(**_get_config(db))


@router.put("/config", response_model=JiraConfig)
def update_config(
    payload: JiraConfigUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = db.query(AppSetting).filter(AppSetting.key == JIRA_SETTINGS_KEY).first()
    current = dict(DEFAULT_JIRA_SETTINGS)
    if row and isinstance(row.value, dict):
        current.update(row.value)
    data = payload.model_dump(exclude_unset=True)
    if "base_url" in data and data["base_url"] is not None:
        current["base_url"] = data["base_url"].rstrip("/")
    for k in ("enabled", "verify_tls", "default_project_key"):
        if k in data and data[k] is not None:
            current[k] = data[k]
    if row:
        row.value = current
    else:
        db.add(AppSetting(key=JIRA_SETTINGS_KEY, value=current))
    db.commit()
    return JiraConfig(**current)


# ── 사용자별 자격증명 ──────────────────────────────────────────────────────────
@router.get("/credential", response_model=JiraCredentialStatus)
def get_credential(db: Session = Depends(get_db), actor: User = Depends(get_current_user)):
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    if not cred:
        return JiraCredentialStatus(configured=False)
    return JiraCredentialStatus(
        configured=True,
        auth_type=(getattr(cred, "auth_type", None) or "pat"),
        jira_account=cred.jira_account,
        last_verified_at=cred.last_verified_at,
        has_sso_login=bool(getattr(cred, "sso_login_encrypted", None)),
    )


@router.put("/credential", response_model=JiraCredentialStatus)
def save_credential(
    payload: JiraCredentialUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    token = (payload.token or "").strip()
    if not token:
        raise HTTPException(status_code=422, detail="인증 값을 입력하세요 (PAT 또는 세션 쿠키).")
    auth_type = (payload.auth_type or "pat").strip().lower()
    # 'sso' 는 로컬 도우미(jira_sso_helper.py)가 본인 PC 에서 캡처한 세션 쿠키를 등록하는 경로 —
    # REST 처리(JiraService)는 cookie 와 동일하고, UI 배지만 SSO 로 구분 표시된다.
    if auth_type not in ("pat", "cookie", "sso"):
        raise HTTPException(status_code=422, detail="auth_type 은 'pat'/'cookie'/'sso' 여야 합니다.")
    enc = secret_box.encrypt(token)
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    if cred:
        cred.token_encrypted = enc
        cred.auth_type = auth_type
        # 인증 값을 새로 저장하면 이전 검증 시각은 무의미 — 초기화해 재검증을 유도.
        cred.last_verified_at = None
        if payload.jira_account is not None:
            cred.jira_account = payload.jira_account
    else:
        cred = UserJiraCredential(
            username=actor.username, token_encrypted=enc, auth_type=auth_type,
            jira_account=payload.jira_account,
        )
        db.add(cred)
    db.commit()
    db.refresh(cred)
    return JiraCredentialStatus(
        configured=True, auth_type=cred.auth_type,
        jira_account=cred.jira_account, last_verified_at=cred.last_verified_at,
    )


@router.delete("/credential", status_code=status.HTTP_204_NO_CONTENT)
def delete_credential(db: Session = Depends(get_db), actor: User = Depends(get_current_user)):
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    if cred:
        db.delete(cred)
        db.commit()
    return None


@router.post("/test", response_model=JiraTestResult)
async def test_connection(db: Session = Depends(get_db), actor: User = Depends(get_current_user)):
    cfg = _get_config(db)
    if not cfg.get("base_url"):
        return JiraTestResult(ok=False, detail="관리자가 Jira URL 을 설정하지 않았습니다.")
    token, auth_type = _user_credential(db, actor.username)
    if not token:
        return JiraTestResult(ok=False, detail="내 Jira 인증(PAT 또는 세션 쿠키)이 등록되지 않았습니다.")
    svc = JiraService(cfg["base_url"], token, auth_type=auth_type, verify=bool(cfg.get("verify_tls", True)))
    res = await svc.myself()
    if res.get("status") == "ok":
        cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
        if cred:
            cred.last_verified_at = datetime.utcnow()
            if res.get("account") and not cred.jira_account:
                cred.jira_account = res.get("display_name") or res.get("account")
            db.commit()
        return JiraTestResult(ok=True, detail="연결 정상", display_name=res.get("display_name"))
    return JiraTestResult(ok=False, detail=res.get("detail", "연결 실패"))


# ── SSO 자동 로그인 ────────────────────────────────────────────────────────────
# 두 가지 실행 모드:
#  - ID/PW 폼 로그인 (기본, K8s 배포용) — 파드 안에서 httpx 로 SSO 리다이렉트 체인을 따라가
#    폼을 제출하고 쿠키를 캡처한다. 브라우저 불필요 (jira_sso_http.form_sso_login).
#    save_login 옵트인 시 로그인 정보를 암호화 저장해 원클릭 재로그인 지원.
#  - Playwright 헤디드 로그인 (레거시) — 백엔드 호스트에 화면이 있는 소스 실행 배포 전용.
@router.post("/sso/login", response_model=JiraSsoLoginResult)
async def sso_login(
    payload: Optional[JiraSsoLoginRequest] = None,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    """SSO 로그인을 서버가 대신 수행하고 세션 쿠키를 자동 저장한다 (docstring 위 주석 참고)."""
    cfg = _get_config(db)
    base_url = cfg.get("base_url", "")
    if not base_url:
        return JiraSsoLoginResult(ok=False, detail="관리자가 Jira URL 을 설정하지 않았습니다.")
    verify_tls = bool(cfg.get("verify_tls", True))

    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    sso_username: Optional[str] = None
    sso_password: Optional[str] = None

    if payload and payload.use_saved:
        if not (cred and cred.sso_login_encrypted):
            return JiraSsoLoginResult(ok=False, detail="저장된 SSO 로그인 정보가 없습니다. 아이디/비밀번호를 입력하세요.")
        try:
            saved = json.loads(secret_box.decrypt(cred.sso_login_encrypted))
            sso_username, sso_password = saved.get("username"), saved.get("password")
        except Exception:  # noqa: BLE001 - SECRET_KEY 교체 등으로 복호 실패
            return JiraSsoLoginResult(ok=False, detail="저장된 로그인 정보를 복호화할 수 없습니다. 다시 입력해 저장하세요.")
    elif payload and (payload.username or payload.password):
        if not (payload.username and payload.password):
            return JiraSsoLoginResult(ok=False, detail="SSO 아이디와 비밀번호를 모두 입력하세요.")
        sso_username, sso_password = payload.username.strip(), payload.password

    if sso_username and sso_password:
        result = await form_sso_login(base_url, sso_username, sso_password, verify_tls=verify_tls)
    else:
        # 레거시 — 블로킹 Playwright 헤디드 로그인(사용자가 서버 브라우저에서 완료할 때까지 대기).
        result = await asyncio.to_thread(capture_sso_session, base_url, verify_tls=verify_tls)
    if result.get("status") != "ok":
        return JiraSsoLoginResult(ok=False, detail=result.get("detail", "SSO 로그인 실패"))

    cookie_header = result["cookie_header"]
    # 캡처한 쿠키로 실제 REST 접근이 되는지 검증(사용자 권한 확인).
    svc = JiraService(base_url, cookie_header, auth_type="sso", verify=verify_tls)
    verified = await svc.myself()
    if verified.get("status") != "ok":
        return JiraSsoLoginResult(
            ok=False,
            detail=f"로그인은 감지됐으나 백엔드에서 세션 검증에 실패했습니다: {verified.get('detail', '')} "
                   "(자체서명 인증서면 공통설정 'TLS 인증서 검증' 해제, 백엔드→Jira 네트워크 확인).",
        )

    display = verified.get("display_name") or result.get("display_name")
    account = result.get("account") or verified.get("account")
    enc = secret_box.encrypt(cookie_header)
    now = datetime.utcnow()
    if cred:
        cred.token_encrypted = enc
        cred.auth_type = "sso"
        cred.jira_account = display or account or cred.jira_account
        cred.last_verified_at = now
    else:
        cred = UserJiraCredential(
            username=actor.username, token_encrypted=enc, auth_type="sso",
            jira_account=display or account, last_verified_at=now,
        )
        db.add(cred)
    # 옵트인 — 로그인 정보 저장(원클릭 재로그인용). 저장 없이 성공한 로그인은 기존 값을 유지.
    if payload and payload.save_login and sso_username and sso_password:
        cred.sso_login_encrypted = secret_box.encrypt(
            json.dumps({"username": sso_username, "password": sso_password})
        )
    db.commit()
    audit_logger.record(
        db, action="work_item.jira_sso_login", actor=actor,
        target_type="user_jira_credential", target_id=None,
        details={"account": account, "method": "form" if sso_username else "browser"},
    )
    return JiraSsoLoginResult(
        ok=True, detail="SSO 로그인 완료 — 세션이 저장되었습니다.",
        jira_account=account, display_name=display,
    )


# 백엔드가 K8s/컨테이너 배포라 파드에서 브라우저를 못 띄우는 환경용 — 사용자가 본인 PC 에서
# 실행해 SSO 세션을 캡처·등록하는 도우미 스크립트(이미지에 동봉)를 내려준다.
_SSO_HELPER_PATH = Path(__file__).resolve().parent.parent / "resources" / "jira_sso_helper.py"


@router.get("/sso/helper")
def download_sso_helper(_: User = Depends(get_current_user)):
    try:
        content = _SSO_HELPER_PATH.read_text(encoding="utf-8")
    except OSError:
        raise HTTPException(status_code=404, detail="도우미 스크립트가 이 배포 이미지에 포함되지 않았습니다.")
    return PlainTextResponse(
        content,
        media_type="text/x-python",
        headers={"Content-Disposition": 'attachment; filename="jira_sso_helper.py"'},
    )


# ── 가져오기 (단방향, upsert by jira_issue_id) ──────────────────────────────────
@router.post("/import", response_model=JiraImportResult)
async def import_issues(
    payload: JiraImportRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cfg = _get_config(db)
    base_url = cfg.get("base_url", "")
    if not base_url or not cfg.get("enabled", False):
        return JiraImportResult(status="error", detail="Jira 연동이 비활성화되었거나 URL 미설정 (설정에서 활성화하세요).")
    token, auth_type = _user_credential(db, actor.username)
    if not token:
        return JiraImportResult(status="error", detail="내 Jira 인증(PAT 또는 세션 쿠키)이 등록되지 않았습니다 (설정 > 연동에서 등록).")

    # JQL 구성
    if payload.scope == "me":
        jql = "assignee = currentUser() ORDER BY updated DESC"
    elif payload.scope == "project":
        pk = (payload.project_key or "").strip()
        if not pk:
            return JiraImportResult(status="error", detail="프로젝트 키를 입력하세요.")
        jql = f'project = "{pk}" ORDER BY updated DESC'
    else:  # jql
        jql = (payload.jql or "").strip()
        if not jql:
            return JiraImportResult(status="error", detail="JQL 을 입력하세요.")

    svc = JiraService(base_url, token, auth_type=auth_type, verify=bool(cfg.get("verify_tls", True)))
    search = await svc.search(jql)
    if search.get("status") != "ok":
        return JiraImportResult(
            status=search.get("status", "error"),
            detail=search.get("detail", "Jira 검색 실패"),
            total=search.get("total", 0),
        )

    resolver = _build_assignee_resolver(db)
    issues = search.get("issues", [])
    created = updated = skipped = 0
    errors: list[str] = []
    preview: list[JiraImportItemPreview] = []
    now = datetime.utcnow()

    for issue in issues:
        try:
            fields = map_jira_issue(issue, base_url, assignee_resolver=resolver)
            jid = fields.get("jira_issue_id")
            if not jid:
                skipped += 1
                continue
            existing = db.query(WorkItem).filter(WorkItem.jira_issue_id == jid).first()
            action = "update" if existing else "create"
            preview.append(JiraImportItemPreview(
                jira_key=fields["jira_issue_key"], title=fields["title"],
                kanban_status=fields["kanban_status"], action=action,
            ))
            if payload.dry_run:
                if existing:
                    updated += 1
                else:
                    created += 1
                continue

            if existing:
                # Jira-소유 필드만 갱신 (PEP 로컬 편집 보존). 담당자는 비어있을 때만 채움.
                existing.title = fields["title"]
                existing.content = fields["content"]
                existing.kanban_status = fields["kanban_status"]
                existing.priority = fields["priority"]
                existing.jira_status = fields["jira_status"]
                existing.jira_url = fields["jira_url"]
                existing.jira_issue_key = fields["jira_issue_key"]
                existing.jira_updated_at = fields["jira_updated_at"]
                existing.jira_synced_at = now
                if fields["closed_at"] and not existing.closed_at:
                    existing.closed_at = fields["closed_at"]
                if not (existing.primary_assignee or "").strip() or existing.primary_assignee == "(미할당)":
                    existing.primary_assignee = fields["primary_assignee"]
                    existing.assignee = fields["primary_assignee"]
                watchers = list(existing.jira_watchers or [])
                if actor.username not in watchers:
                    watchers.append(actor.username)
                existing.jira_watchers = watchers
                updated += 1
            else:
                item = WorkItem(
                    type=fields["type"],
                    type_label=fields["type_label"],
                    assignee=fields["primary_assignee"],
                    primary_assignee=fields["primary_assignee"],
                    category=fields["category"],
                    title=fields["title"],
                    content=fields["content"],
                    kanban_status=fields["kanban_status"],
                    priority=fields["priority"],
                    started_at=fields["started_at"],
                    closed_at=fields["closed_at"],
                    jira_issue_id=fields["jira_issue_id"],
                    jira_issue_key=fields["jira_issue_key"],
                    jira_url=fields["jira_url"],
                    jira_status=fields["jira_status"],
                    jira_updated_at=fields["jira_updated_at"],
                    jira_synced_at=now,
                    jira_watchers=[actor.username],
                    created_by=actor.username,
                )
                db.add(item)
                created += 1
        except Exception as exc:  # noqa: BLE001 - 한 이슈 실패가 전체를 막지 않도록
            logger.warning("Jira import 항목 실패 (%s): %s", issue.get("key"), exc)
            errors.append(f"{issue.get('key', '?')}: {str(exc)[:120]}")

    if not payload.dry_run:
        try:
            db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            return JiraImportResult(status="error", detail=f"저장 실패: {str(exc)[:200]}")
        audit_logger.record(
            db, action="work_item.jira_import", actor=actor,
            target_type="work_item", target_id=None,
            details={"scope": payload.scope, "created": created, "updated": updated, "skipped": skipped},
        )

    return JiraImportResult(
        status="ok",
        imported=created,
        updated=updated,
        skipped=skipped,
        total=search.get("total", len(issues)),
        truncated=bool(search.get("truncated")),
        dry_run=payload.dry_run,
        errors=errors,
        items=preview[:50],
    )


# ── Jira 에서 추출한 Excel(.xlsx/.xls) / 복사·붙여넣기 가져오기 (미리보기 전용, 저장 없음) ──
_EXCEL_MAX_ROWS = 2000  # 과도한 업로드로부터의 안전장치
_EXCEL_HEADER_SCAN_ROWS = 5  # 헤더가 1행이 아닐 수 있어(제목행 등) 최대 이 행수까지 탐색


def _find_header_in_rows(rows: list[tuple]) -> tuple[Optional[tuple], int, dict[str, int], list[tuple]]:
    """rows 앞부분(최대 _EXCEL_HEADER_SCAN_ROWS 행)에서 key/summary 를 모두 가진 헤더 행을
    찾는다. 반환: (헤더 행 또는 None, 헤더의 rows 내 인덱스, 컬럼 인덱스 맵, 스캔한 후보 행들)."""
    scanned = rows[:_EXCEL_HEADER_SCAN_ROWS]
    for ridx, candidate in enumerate(scanned):
        normalized = [_norm_excel_header(h) for h in candidate]
        candidate_idx: dict[str, int] = {}
        for field, aliases in _EXCEL_HEADER_ALIASES.items():
            for i, h in enumerate(normalized):
                if h in aliases:
                    candidate_idx[field] = i
                    break
        if "key" in candidate_idx and "summary" in candidate_idx:
            return candidate, ridx, candidate_idx, scanned
    return None, -1, {}, scanned


def _extract_jira_rows(tables: list[list[tuple]], db: Session) -> JiraExcelImportResult:
    """표(시트/HTML 표/붙여넣은 TSV) 목록을 순서대로 살펴 key/summary 헤더를 가진 첫 표를
    찾아 JiraExcelRow 목록으로 변환한다. 파일 업로드(import_excel)와 복사·붙여넣기
    (import_paste) 가 공유하는 핵심 로직 — 표가 여러 개(예: Jira 요약 표 + 실제 이슈 표)
    있어도 순서대로 확인해 첫 번째로 헤더를 찾은 표를 사용한다."""
    tables = [t for t in tables if t]
    if not tables:
        return JiraExcelImportResult(status="error", detail="빈 파일입니다.")

    header_row: Optional[tuple] = None
    header_row_idx = -1
    col_idx: dict[str, int] = {}
    data_rows: list[tuple] = []
    scan_report: list[str] = []
    for t_idx, table_rows in enumerate(tables):
        h, hidx, cidx, scanned = _find_header_in_rows(table_rows)
        if h is not None:
            header_row, header_row_idx, col_idx = h, hidx, cidx
            data_rows = table_rows[hidx + 1:]
            break
        scanned_desc = "; ".join(
            f"{i + 1}행: {', '.join(str(v) for v in r if v) or '(빈 행)'}"
            for i, r in enumerate(scanned)
        )
        scan_report.append(f"[표 {t_idx + 1}] {scanned_desc}")

    if header_row is None:
        table_note = f"표 {len(tables)}개 확인 — " if len(tables) > 1 else ""
        return JiraExcelImportResult(
            status="error",
            detail=(
                f"필수 컬럼(key, summary)을 찾을 수 없습니다 (표마다 최대 "
                f"{_EXCEL_HEADER_SCAN_ROWS}행까지 확인, {table_note}각 표의 첫 행들: "
                + " / ".join(scan_report) + ")"
            ),
        )

    cfg = _get_config(db)
    base_url = (cfg.get("base_url") or "").rstrip("/")
    roster_by_lower = _build_assignee_roster(db)

    def cell(r: tuple, field: str) -> str:
        idx = col_idx.get(field)
        return _excel_cell_str(r[idx]) if idx is not None and idx < len(r) else ""

    out_rows: list[JiraExcelRow] = []
    matched = 0
    for r in data_rows:
        if r is None or all(v is None or v == "" for v in r):
            continue
        key = cell(r, "key")
        if not key:
            continue
        assignee_raw = cell(r, "assignee")
        assignee_name, is_matched = _match_excel_assignee(assignee_raw, roster_by_lower)
        if is_matched:
            matched += 1
        out_rows.append(JiraExcelRow(
            key=key,
            jira_url=f"{base_url}/browse/{key}" if base_url else None,
            summary=cell(r, "summary"),
            issue_type=cell(r, "issue_type"),
            status=cell(r, "status"),
            assignee_raw=assignee_raw,
            assignee_name=assignee_name,
            assignee_matched=is_matched,
            created=_excel_date_only(cell(r, "created")),
            resolved=cell(r, "resolved"),
            due_date=cell(r, "due_date"),
            environment=_strip_inline_html(cell(r, "environment")),
            description=_strip_inline_html(cell(r, "description")),
        ))
        if len(out_rows) >= _EXCEL_MAX_ROWS:
            break

    return JiraExcelImportResult(status="ok", total=len(out_rows), matched=matched, rows=out_rows)


@router.post("/import/excel", response_model=JiraExcelImportResult)
async def import_excel(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Jira 에서 내려받은 이슈 목록 Excel(.xlsx/.xls) 을 파싱해 테이블로 보여준다.

    WorkItem 으로 저장하지 않는 순수 미리보기 기능 — 담당자 셀("이름 회사")에서
    이름을 추출해 등록된 담당자(Settings ▸ 담당자) 레지스트리와 매칭한다.
    """
    fname = (file.filename or "").lower()
    if not fname.endswith((".xlsx", ".xlsm", ".xls")):
        return JiraExcelImportResult(status="error", detail=".xlsx/.xls 파일만 업로드할 수 있습니다.")

    raw = await file.read()
    try:
        if fname.endswith(".xls"):
            if _looks_like_html(raw):
                # Jira '엑셀(전체 필드)' 내보내기 — 확장자만 .xls, 실제로는 HTML 표(여러 개일 수 있음).
                tables = _read_html_tables(raw)
            else:
                tables = [list(_read_xls_rows(raw))]
        else:
            wb = openpyxl.load_workbook(BytesIO(raw), data_only=True, read_only=True)
            ws = wb.active
            if ws is None:
                return JiraExcelImportResult(status="error", detail="시트를 찾을 수 없습니다.")
            tables = [list(ws.iter_rows(values_only=True))]
    except Exception as exc:  # noqa: BLE001
        return JiraExcelImportResult(status="error", detail=f"엑셀 파일을 읽을 수 없습니다: {str(exc)[:150]}")

    return _extract_jira_rows(tables, db)


@router.post("/import/paste", response_model=JiraExcelImportResult)
async def import_paste(
    payload: JiraExcelPasteRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """엑셀/Jira 표를 복사해 그대로 붙여넣은 텍스트를 파싱한다(파일 업로드 없이).
    브라우저에서 표를 드래그로 복사하면 클립보드에 탭(TSV) 구분 텍스트가 담기는 것을
    이용 — 파일 업로드(import_excel)와 동일한 헤더 탐색/매칭 로직을 공유한다."""
    text = payload.text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln for ln in text.split("\n") if ln.strip() != ""]
    if not lines:
        return JiraExcelImportResult(status="error", detail="붙여넣은 내용이 비어 있습니다.")
    rows: list[tuple] = [tuple(cell.strip() for cell in ln.split("\t")) for ln in lines]
    return _extract_jira_rows([rows], db)


@router.post("/import/excel/save", response_model=JiraImportResult)
async def import_excel_save(
    payload: JiraExcelSaveRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """import_excel/import_paste 로 미리 확인한 행을 실제 업무 관리 게시판(work_items)에
    저장한다. 파일을 다시 읽지 않고 프론트가 들고 있던 미리보기 rows 를 그대로 받는다.

    라이브 JQL 가져오기(POST /import)는 `jira_issue_id`(Jira 내부 불변 ID)로 dedup 하지만,
    엑셀에는 그 값이 없으므로 여기서는 `jira_issue_key`(예: PROJ-123)로 dedup 한다 — 같은
    이슈를 라이브로 먼저 가져왔다면 jira_issue_key 가 이미 채워져 있어 그 레코드를 그대로
    갱신한다(반대로 엑셀로 먼저 저장한 뒤 라이브로 가져오면 jira_issue_id 매칭에는 안 걸려
    새 레코드가 생길 수 있음 — 라이브 가져오기 dedup 정책은 이번 변경 범위 밖).
    """
    created = updated = skipped = 0
    errors: list[str] = []
    preview: list[JiraImportItemPreview] = []
    now = datetime.utcnow()

    for row in payload.rows:
        key = (row.key or "").strip()
        if not key:
            skipped += 1
            continue
        try:
            wtype, type_label = map_issue_type(row.issue_type)
            kanban = _map_excel_status_to_kanban(row.status)
            summary = (row.summary or "").strip()
            title = f"{key} {summary}".strip()[:200]
            content = row.description if (row.description or "").strip() else (summary or key)
            started_at = _parse_excel_date(row.created) or now
            closed_at = _parse_excel_date(row.resolved) if kanban == "done" else None
            # assignee_name 은 미리보기 단계(_match_excel_assignee)에서 이미 담당자 레지스트리와
            # 매칭 시도된 값 — 매칭 실패해도 원본 첫 토큰이 담겨 있어 빈 문자열이 아닌 한 그대로 쓴다.
            assignee_name = (row.assignee_name or "").strip() or "(미할당)"

            existing = db.query(WorkItem).filter(WorkItem.jira_issue_key == key).first()
            action = "update" if existing else "create"
            preview.append(JiraImportItemPreview(
                jira_key=key, title=title, kanban_status=kanban, action=action,
            ))

            if existing:
                existing.title = title
                existing.content = content
                existing.kanban_status = kanban
                existing.jira_status = row.status
                existing.jira_url = row.jira_url
                existing.jira_synced_at = now
                if closed_at and not existing.closed_at:
                    existing.closed_at = closed_at
                if not (existing.primary_assignee or "").strip() or existing.primary_assignee == "(미할당)":
                    existing.primary_assignee = assignee_name
                    existing.assignee = assignee_name
                watchers = list(existing.jira_watchers or [])
                if actor.username not in watchers:
                    watchers.append(actor.username)
                existing.jira_watchers = watchers
                updated += 1
            else:
                item = WorkItem(
                    type=wtype,
                    type_label=type_label,
                    assignee=assignee_name,
                    primary_assignee=assignee_name,
                    category="Jira",
                    title=title,
                    content=content,
                    kanban_status=kanban,
                    started_at=started_at,
                    closed_at=closed_at,
                    jira_issue_key=key,
                    jira_url=row.jira_url,
                    jira_status=row.status,
                    jira_synced_at=now,
                    jira_watchers=[actor.username],
                    created_by=actor.username,
                )
                db.add(item)
                created += 1
        except Exception as exc:  # noqa: BLE001 - 한 행 실패가 전체 저장을 막지 않도록
            logger.warning("Jira Excel 저장 항목 실패 (%s): %s", key, exc)
            errors.append(f"{key}: {str(exc)[:120]}")

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return JiraImportResult(status="error", detail=f"저장 실패: {str(exc)[:200]}")

    audit_logger.record(
        db, action="work_item.jira_excel_import", actor=actor,
        target_type="work_item", target_id=None,
        details={"created": created, "updated": updated, "skipped": skipped},
    )

    return JiraImportResult(
        status="ok",
        imported=created,
        updated=updated,
        skipped=skipped,
        total=len(payload.rows),
        errors=errors,
        items=preview[:50],
    )


# ── 양방향 push: PEP 상태 → Jira 반영 (Phase 2) ─────────────────────────────────
@router.post("/push/{item_id}", response_model=JiraPushResult)
async def push_to_jira(
    item_id: str,
    payload: JiraPushRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="업무를 찾을 수 없습니다.")
    if not item.jira_issue_key:
        return JiraPushResult(status="not_linked", detail="Jira 와 연결되지 않은 업무입니다.")

    cfg = _get_config(db)
    if not cfg.get("base_url") or not cfg.get("enabled", False):
        return JiraPushResult(status="error", detail="Jira 연동이 비활성화되었거나 URL 미설정.")
    token, auth_type = _user_credential(db, actor.username)
    if not token:
        return JiraPushResult(status="error", detail="내 Jira 인증(PAT 또는 세션 쿠키)이 등록되지 않았습니다 (설정 > 연동).")

    key = item.jira_issue_key
    svc = JiraService(cfg["base_url"], token, auth_type=auth_type, verify=bool(cfg.get("verify_tls", True)))

    # 1) 현재 Jira 상태 + updated 조회 (충돌 감지)
    got = await svc.get_issue(key, fields=["status", "updated"])
    if got.get("status") != "ok":
        return JiraPushResult(status=got.get("status", "error"), detail=got.get("detail", "이슈 조회 실패"))
    jfields = (got["issue"].get("fields") or {})
    jira_updated = parse_jira_dt(jfields.get("updated"))
    if (not payload.force) and item.jira_updated_at and jira_updated and jira_updated > item.jira_updated_at:
        return JiraPushResult(
            status="conflict",
            detail="Jira 쪽이 더 최근에 변경되었습니다. 덮어쓰려면 강제 반영을 선택하세요.",
            jira_status=(jfields.get("status") or {}).get("name"),
        )

    # 1.5) 값 필드 편집 반영 (제목/설명/우선순위). assignee 는 PEP 담당자명 ↔ Jira username
    #      역매핑이 불안정해 제외한다. summary/description 은 저위험이라 한 번에 PUT 하고,
    #      priority 는 프로젝트별 우선순위 스킴 차이로 실패할 수 있어 별도 best-effort PUT.
    fields_updated: list[str] = []
    field_errors: list[str] = []
    if payload.push_fields:
        core: dict = {}
        summary = strip_issue_key_prefix(item.title, key)
        if summary:
            core["summary"] = summary[:255]
        if item.content is not None:
            core["description"] = item.content or ""
        if core:
            upd = await svc.update_issue(key, core)
            if upd.get("status") == "ok":
                fields_updated.extend(core.keys())
            else:
                field_errors.append(upd.get("detail", "제목/설명 반영 실패"))
        jira_priority = PEP_PRIORITY_TO_JIRA.get((item.priority or "medium").lower())
        if jira_priority:
            pres = await svc.update_issue(key, {"priority": {"name": jira_priority}})
            if pres.get("status") == "ok":
                fields_updated.append("priority")
            else:
                field_errors.append(f"priority({jira_priority}): {pres.get('detail', '반영 실패')}")

    # 2) 상태 transition
    transitioned = False
    desired_cat = KANBAN_TO_CATEGORY.get(item.kanban_status or "todo", "new")
    current_cat = ((jfields.get("status") or {}).get("statusCategory") or {}).get("key", "")
    if current_cat != desired_cat:
        tr = await svc.get_transitions(key)
        if tr.get("status") != "ok":
            return JiraPushResult(status=tr.get("status", "error"), detail=tr.get("detail", "transition 조회 실패"))
        match = next((t for t in tr["transitions"] if t.get("to_category") == desired_cat), None)
        if not match:
            names = [t.get("name", "") for t in tr["transitions"]]
            return JiraPushResult(
                status="error",
                detail=f"'{item.kanban_status}' 에 해당하는 Jira transition 이 없습니다. 가용: {', '.join(names) or '없음'}",
                available_transitions=names,
            )
        res = await svc.do_transition(key, match["id"])
        if res.get("status") != "ok":
            return JiraPushResult(status=res.get("status", "error"), detail=res.get("detail", "transition 실패"))
        transitioned = True

    # 3) 코멘트 (선택)
    comment_added = False
    if payload.comment and payload.comment.strip():
        cres = await svc.add_comment(key, payload.comment.strip())
        comment_added = cres.get("status") == "ok"

    # 4) 로컬 동기화 메타 갱신 (재조회)
    after = await svc.get_issue(key, fields=["status", "updated"])
    now = datetime.utcnow()
    new_status_name = None
    if after.get("status") == "ok":
        af = after["issue"].get("fields") or {}
        new_status_name = (af.get("status") or {}).get("name")
        item.jira_status = new_status_name
        item.jira_updated_at = parse_jira_dt(af.get("updated")) or item.jira_updated_at
    item.jira_synced_at = now
    db.commit()

    audit_logger.record(
        db, action="work_item.jira_push", actor=actor,
        target_type="work_item", target_id=str(item.id),
        details={
            "key": key, "transitioned": transitioned, "comment": comment_added,
            "fields": fields_updated, "force": payload.force,
        },
    )

    changed = transitioned or comment_added or bool(fields_updated)
    if changed:
        parts = []
        if fields_updated:
            _labels = {"summary": "제목", "description": "설명", "priority": "우선순위"}
            parts.append("필드(" + ", ".join(_labels.get(f, f) for f in fields_updated) + ")")
        if transitioned:
            parts.append("상태")
        if comment_added:
            parts.append("코멘트")
        detail = "Jira 반영 완료: " + " · ".join(parts)
    else:
        detail = "이미 동기화 상태입니다."
    if field_errors:
        detail += " (일부 실패: " + "; ".join(field_errors[:3]) + ")"
    return JiraPushResult(
        status="ok", detail=detail, transitioned=transitioned,
        comment_added=comment_added, fields_updated=fields_updated, field_errors=field_errors,
        jira_status=new_status_name or (jfields.get("status") or {}).get("name"),
    )
