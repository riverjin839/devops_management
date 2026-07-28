"""브라우저 없이 파드 안에서 수행하는 Jira/Confluence SSO 로그인 (httpx 기반).

순수 ID/PW SSO(Keycloak/CAS/ADFS forms — 2차 인증 없음)는 IdP 로그인 페이지가 일반 HTML
`<form>` 이라 JS 실행이 필요 없다. 따라서 브라우저(Playwright/Chromium) 없이 로그인 정보만으로
세션을 얻을 수 있다 — **기본 이미지 그대로 동작**한다(추가 의존성 없음).

세션 확보는 아래 전략을 **순서대로 시도**하고, 각 전략 직후 verify 엔드포인트로 검증해
성공하면 즉시 멈춘다(어느 전략이 통했는지는 `strategy` 로 보고):

  1. `sso_form`     — 제품 진입 경로 GET → SSO 리다이렉트 체인 추적 → IdP 로그인 폼 제출 →
                      SAML/OIDC auto-submit 중계 폼 자동 제출 → 제품 복귀
  2. `rest_session` — Jira `POST /rest/auth/1/session` (JSON ID/PW). SSO 플러그인을 우회해
                      내부 디렉터리(AD/LDAP)로 인증하는 경로 — 폼이 JS 라도 통하는 경우가 많다
  3. `native_form`  — 제품 자체 로그인 폼 직접 POST (Jira `login.jsp` / Confluence `dologin.action`)

**폼 탐색은 진입 경로를 여러 개 시도한다.** 루트(`/`)만 보면 놓치는 배포가 많다 — 익명 접근이
열려 있어 루트가 대시보드를 그냥 주거나(폼 없음), SSO 리다이렉트가 보호 자원에 접근할 때만
발생하는 구성이 흔하다. 또 IdP 중계가 HTTP 302 가 아니라 `<meta http-equiv=refresh>` 나
`location.href=...` 로 이뤄지는 경우가 있어 그 두 가지도 따라간다.

자동 탐색이 실패하는 배포를 위해 관리자가 **IdP 로그인 페이지 URL 을 직접 지정**할 수 있다
(`sso_login_url`, 예: `https://login.example.com/sso/am/jira/login.jsp`). 지정하면 그 주소를
첫 진입점으로 삼아 폼을 제출하고, IdP 세션이 생긴 뒤 제품으로 돌아와 SSO 왕복을 한 번 더
태워 세션을 받는다(OpenAM/SiteMinder 처럼 IdP 에서 먼저 로그인하는 구성).

**비밀번호 오답은 즉시 중단한다** — 여러 전략으로 재시도하면 AD 계정 잠금을 유발한다.

**다중 제품**: Jira 와 Confluence 가 같은 IdP 를 쓰면 쿠키 jar 를 공유하는 한 클라이언트로
제품을 순서대로 순회한다 — 첫 제품에서 IdP 로그인이 완료되면 다음 제품은 중계 폼만 통과해
**비밀번호 재입력 없이** 세션이 떨어진다(`sso_login_products`).

fail-safe: 절대 raise 하지 않고 {"status": "ok|error", ...} dict 를 반환한다.
"""
from __future__ import annotations

import base64
import logging
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)

# 리다이렉트/폼 제출 체인 최대 횟수 — SSO 왕복(로그인 폼 1회 + auto-submit 1~2회 + 클라이언트
# 리다이렉트 몇 번)에 넉넉히.
MAX_FORM_HOPS = 8
# 제품별 세션 검증(로그인 성공 판정) 엔드포인트 — 200 이면 세션 유효.
JIRA_VERIFY_PATH = "/rest/api/2/myself"
CONFLUENCE_VERIFY_PATH = "/rest/api/user/current"

# 제품별 SSO 진입 경로 후보 — 순서대로 시도한다(관리자가 지정한 `sso_login_url` 이 있으면
# 그것이 맨 앞에 온다). 루트가 익명 대시보드를 주는 배포에서도 보호 자원/로그인 페이지로
# 진입하면 SSO 리다이렉트가 발생한다. 항목이 `http` 로 시작하면 절대 URL 로 그대로 쓴다.
PRODUCT_ENTRY_PATHS: dict[str, tuple[str, ...]] = {
    "jira": (
        "/",
        "/login.jsp?os_destination=%2Fsecure%2FMyJiraHome.jspa",
        "/secure/Dashboard.jspa",
    ),
    "confluence": (
        "/",
        "/login.action?os_destination=%2Findex.action",
        "/dashboard.action",
    ),
}
DEFAULT_ENTRY_PATHS: tuple[str, ...] = ("/",)

# 제품 자체 로그인 폼 (SSO 플러그인이 없거나 로컬 폴백이 열려 있을 때) — (경로, 목적지 파라미터).
NATIVE_LOGIN_FORMS: dict[str, tuple[str, str]] = {
    "jira": ("/login.jsp", "/secure/MyJiraHome.jspa"),
    "confluence": ("/dologin.action", "/index.action"),
}

# 일반적인 username 필드 이름(IdP 별) — 우선 매칭. Jira 자체 폼은 os_username.
_USERNAME_FIELD_NAMES = (
    "username", "j_username", "os_username", "user", "userid", "user_id",
    "login", "loginid", "email", "username_input", "identifier",
    "idtoken1",  # OpenAM/ForgeRock (IDToken1=계정, IDToken2=비밀번호)
    # 사번 로그인(사내 IdP) — empnum/empno/사원번호 계열.
    "empnum", "empno", "emp_no", "empid", "emp_id", "employeeno", "employee_no",
    "employeenumber", "sabun",
)
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
# 브라우저처럼 HTML 을 요구한다 — Accept: */* 면 일부 배포가 JSON/에러를 돌려준다.
_HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.I | re.S)
_META_REFRESH_RE = re.compile(
    r"""<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?[^"'>]*?url\s*=\s*([^"'>\s]+)""",
    re.I,
)
_JS_REDIRECT_RES = (
    re.compile(r"""(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']""", re.I),
    re.compile(r"""location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']""", re.I),
)


class _FormParser(HTMLParser):
    """HTML 에서 <form> 들의 action/method/input 목록을 추출한다.

    `<button type=submit name= value=>`(ADFS 등)도 submit 입력으로 함께 수집한다."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict] = []
        self._cur: dict | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        a = dict(attrs)
        if tag == "form":
            self._cur = {"action": a.get("action") or "", "method": (a.get("method") or "get").lower(), "inputs": []}
            self.forms.append(self._cur)
        elif tag in ("input", "button") and self._cur is not None:
            default_type = "text" if tag == "input" else "submit"
            self._cur["inputs"].append({
                "name": a.get("name") or "",
                "value": a.get("value") or "",
                "type": (a.get("type") or default_type).lower(),
            })

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self._cur = None


def parse_forms(html_text: str) -> list[dict]:
    p = _FormParser()
    try:
        p.feed(html_text)
    except Exception:  # noqa: BLE001 - 깨진 HTML 이어도 수집된 것까지는 사용
        pass
    return p.forms


def find_login_form(forms: list[dict]) -> dict | None:
    """password 입력이 있는 첫 폼 = 로그인 폼."""
    for f in forms:
        if any(i["type"] == "password" for i in f["inputs"]):
            return f
    return None


def find_autosubmit_form(forms: list[dict]) -> dict | None:
    """SAML/OIDC 중계용 auto-submit 폼 — visible 입력 없이 hidden(+submit)만 있는 폼."""
    for f in forms:
        if not f["inputs"]:
            continue
        if all(i["type"] in ("hidden", "submit") for i in f["inputs"]) and any(
            i["type"] == "hidden" for i in f["inputs"]
        ):
            return f
    return None


def find_client_redirect(html_text: str, current_url: str) -> str:
    """HTTP 302 가 아닌 **클라이언트 리다이렉트**(meta refresh / JS location) 대상 URL.

    SSO 중계 페이지가 이 방식을 쓰면 httpx 의 follow_redirects 로는 따라갈 수 없어
    "폼을 찾지 못함"으로 오판된다. 절대 URL 로 변환해 돌려준다(없으면 빈 문자열)."""
    text = html_text or ""
    m = _META_REFRESH_RE.search(text)
    if m:
        return urljoin(current_url, m.group(1).strip().strip("'\""))
    # <script> 안의 즉시 리다이렉트 — 로그인 폼이 함께 있는 페이지는 제외(폼 우선).
    for rx in _JS_REDIRECT_RES:
        m = rx.search(text)
        if m:
            target = (m.group(1) or "").strip()
            if target and not target.startswith("#") and "javascript:" not in target.lower():
                return urljoin(current_url, target)
    return ""


def form_wants_base64(form: dict) -> bool:
    """OpenAM/SunAM 계열의 `<input type=hidden name=encoded value=true>` 감지.

    이 값이 true 면 브라우저의 login.jsp 스크립트가 계정/비밀번호를 **base64 로 인코딩해서**
    제출한다. 평문으로 보내면 IdP 가 인증에 실패하고 로그인 폼을 다시 보여주므로
    "비밀번호 오답"과 구분되지 않는 실패가 난다 — 브라우저는 되는데 스크립트는 안 되는
    전형적인 원인."""
    for i in form.get("inputs", []):
        if i.get("name", "").lower() == "encoded" and str(i.get("value", "")).strip().lower() == "true":
            return True
    return False


def _b64(value: str) -> str:
    return base64.b64encode((value or "").encode("utf-8")).decode("ascii")


def login_form_signature(form: dict) -> str:
    """로그인 폼의 필드 구성 서명 — 같은 폼의 '재표시'와 '다음 단계'를 구분하는 데 쓴다."""
    return ",".join(sorted(i.get("name", "") for i in form.get("inputs", []) if i.get("name")))


_ERROR_KEYWORDS = (
    "Authentication failed", "Invalid", "incorrect", "failed", "denied",
    "인증", "실패", "잘못", "오류", "locked", "잠금", "expired", "만료", "일치",
)


def visible_text_lines(html_text: str) -> list[str]:
    """HTML 에서 사람이 보는 텍스트 조각들(태그/스크립트 제거, 공백 정규화)."""
    text = _TAG_RE.sub("\n", html_text or "")
    out: list[str] = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if line:
            out.append(line)
    return out


def extract_error_text(html_text: str, *, baseline_html: str = "") -> str:
    """IdP 가 표시한 **실제 오류 문구**를 뽑아낸다.

    로그인 페이지에는 "비밀번호 5회 이상 입력 오류 시 계정이 잠깁니다" 같은 **상시 안내문**이
    있어, 단순 키워드 검색은 그것을 오류로 오인한다. 그래서 자격 제출 **직전 페이지**
    (`baseline_html`)와 비교해 **새로 생긴 문장만** 오류 후보로 본다. 새 문장이 없으면
    빈 문자열을 돌려줘 호출부가 "같은 폼 재표시"로 안내하게 한다."""
    lines = visible_text_lines(html_text)
    if baseline_html:
        base = set(visible_text_lines(baseline_html))
        candidates = [ln for ln in lines if ln not in base]
    else:
        candidates = lines
    if not candidates:
        return ""
    for ln in candidates:
        low = ln.lower()
        if any(k.lower() in low for k in _ERROR_KEYWORDS):
            return ln[:200]
    # 키워드는 없지만 새로 생긴 문구가 있으면 가장 그럴듯한 것(짧은 문장) 하나를 보여준다.
    short = [ln for ln in candidates if 4 <= len(ln) <= 200]
    return short[0][:200] if short else ""


def pick_username_field(form: dict, override: str = "") -> dict | None:
    """폼에서 **계정(ID) 입력 필드**를 고른다.

    override(관리자 지정 필드명)가 최우선 — 사번(empnum) 처럼 사내 고유 필드명이면
    자동 추정이 빗나갈 수 있어 직접 지정할 수 있어야 한다. 그다음 알려진 이름,
    마지막으로 첫 visible text/email 입력."""
    named_inputs = [i for i in form.get("inputs", []) if i.get("name")]
    known = {i["name"].lower(): i for i in named_inputs}
    ov = (override or "").strip().lower()
    if ov and ov in known:
        return known[ov]
    hit = next((known[n] for n in _USERNAME_FIELD_NAMES if n in known), None)
    if hit is not None:
        return hit
    return next((i for i in named_inputs if i["type"] in ("text", "email", "")), None)


def fill_login_form(form: dict, username: str, password: str, *, username_field_name: str = "") -> dict[str, str]:
    """로그인 폼의 제출 데이터 구성 — hidden 값 유지, username/password 채움.

    계정 필드는 `username_field_name`(관리자 지정) → 알려진 이름 → 첫 visible text 순으로
    고른다. submit 버튼에 name 이 있으면(예: Keycloak `login`) 첫 번째 것만 포함한다.
    `encoded=true` 폼(OpenAM)은 계정/비밀번호를 base64 로 인코딩해 넣는다.
    """
    if form_wants_base64(form):
        username, password = _b64(username), _b64(password)
    data: dict[str, str] = {}
    submit_added = False
    username_set = False

    named_inputs = [i for i in form["inputs"] if i["name"]]
    username_field = pick_username_field(form, username_field_name)

    for i in named_inputs:
        t = i["type"]
        if t == "password":
            data[i["name"]] = password
        elif t == "hidden":
            data[i["name"]] = i["value"]
        elif t == "submit":
            if not submit_added:
                data[i["name"]] = i["value"]
                submit_added = True
        elif t in ("text", "email", ""):
            if username_field is not None:
                data[i["name"]] = username if i is username_field else i["value"]
                username_set = username_set or i is username_field
            elif not username_set:
                data[i["name"]] = username
                username_set = True
            else:
                data[i["name"]] = i["value"]
        elif t in ("checkbox", "radio"):
            # 기본 미선택 — value 가 있고 checked 판단이 불가하므로 보수적으로 생략.
            continue
        else:
            data[i["name"]] = i["value"]
    return data


def _cookie_header_for_host(client: httpx.AsyncClient, host: str) -> str:
    """쿠키 jar 에서 해당 제품 호스트의 쿠키만 추려 Cookie 헤더 문자열로.

    다중 제품 로그인 시 jar 에는 제품마다 동명 쿠키(JSESSIONID 등)가 도메인만 다르게
    공존하므로, dedup 은 전체가 아니라 **호스트 매칭 결과 안에서만** 수행한다."""
    def _match(dom: str) -> bool:
        d = (dom or "").lstrip(".").lower()
        return bool(d) and (host == d or host.endswith("." + d) or d.endswith("." + host))

    seen_scoped: set[str] = set()
    seen_all: set[str] = set()
    scoped: list[str] = []
    everything: list[str] = []
    for c in client.cookies.jar:
        if not c.name:
            continue
        pair = f"{c.name}={c.value}"
        if c.name not in seen_all:
            seen_all.add(c.name)
            everything.append(pair)
        if _match(c.domain or "") and c.name not in seen_scoped:
            seen_scoped.add(c.name)
            scoped.append(pair)
    return "; ".join(scoped or everything)


def describe_page(resp: httpx.Response) -> dict:
    """응답 1건의 진단 요약 — 진단 엔드포인트와 실패 사유 메시지가 함께 쓴다."""
    text = resp.text or ""
    forms = parse_forms(text)
    title_m = _TITLE_RE.search(text)
    input_names: list[str] = []
    for f in forms:
        for i in f["inputs"]:
            if i["name"] and i["name"] not in input_names:
                input_names.append(i["name"])
    # hidden 필드는 IdP 흐름의 상태값이다 — `encoded=true`(base64 요구) 같은 결정적 단서가
    # 여기 있어 진단에 노출한다. 값은 길이를 잘라 담는다(SAMLResponse 등 대비).
    hidden_fields: dict[str, str] = {}
    for f in forms:
        for i in f["inputs"]:
            if i["type"] == "hidden" and i["name"] and i["name"] not in hidden_fields:
                hidden_fields[i["name"]] = str(i["value"])[:40]
            if len(hidden_fields) >= 12:
                break
    login_form = find_login_form(forms)
    picked = pick_username_field(login_form) if login_form else None
    return {
        "final_url": str(resp.url),
        "http_status": resp.status_code,
        # 이 페이지에서 계정을 채울 필드 — 사번 칸이 아닌 다른 입력이 잡히면 여기서 드러난다.
        "username_field": (picked or {}).get("name", ""),
        "wants_base64": bool(login_form and form_wants_base64(login_form)),
        "content_type": resp.headers.get("content-type", "")[:80],
        "title": (title_m.group(1).strip()[:80] if title_m else ""),
        "forms": len(forms),
        "hidden_fields": hidden_fields,
        "password_inputs": sum(
            1 for f in forms for i in f["inputs"] if i["type"] == "password"
        ),
        "input_names": input_names[:20],
        "client_redirect": find_client_redirect(text, str(resp.url))[:200],
        "www_authenticate": resp.headers.get("www-authenticate", "")[:80],
    }


def _entry_url(base_url: str, entry: str) -> str:
    """진입 항목 → 절대 URL. `http` 로 시작하면 외부 IdP 주소로 그대로 사용."""
    e = (entry or "").strip()
    if e.lower().startswith(("http://", "https://")):
        return e
    return f"{base_url}{e}"


def _entry_paths_for(prod: dict) -> tuple[str, ...]:
    """제품의 진입 경로 목록 — 관리자가 지정한 IdP 로그인 URL 이 있으면 최우선."""
    key = prod.get("key") or "product"
    paths: list[str] = []
    custom = (prod.get("sso_login_url") or "").strip()
    if custom:
        paths.append(custom)
    explicit = prod.get("entry_paths")
    paths.extend(explicit or PRODUCT_ENTRY_PATHS.get(key, DEFAULT_ENTRY_PATHS))
    return tuple(dict.fromkeys(paths))  # 중복 제거, 순서 유지


async def probe_entry(client: httpx.AsyncClient, url: str) -> dict:
    """진입 경로 1개를 GET 해 진단 정보를 수집한다(로그인 시도 없음)."""
    try:
        resp = await client.get(url, headers={"Accept": _HTML_ACCEPT})
    except Exception as exc:  # noqa: BLE001 - fail-safe
        return {"url": url, "error": str(exc)[:200]}
    out = {"url": url, "error": ""}
    out.update(describe_page(resp))
    return out


def _form_post_headers(page_url: str) -> dict:
    """폼 제출 헤더 — 일부 IdP 는 Referer/Origin 이 없으면 CSRF 로 간주해 흐름을 되감는다."""
    parts = urlparse(page_url)
    headers = {"Accept": _HTML_ACCEPT, "Referer": page_url}
    if parts.scheme and parts.netloc:
        headers["Origin"] = f"{parts.scheme}://{parts.netloc}"
    return headers


async def _drive_form_chain(
    client: httpx.AsyncClient, start_url: str, username: str, password: str,
    *, username_field_name: str = "",
) -> dict:
    """진입 URL 부터 로그인/중계 폼 체인을 통과한다.

    반환: {"creds_submitted","auth_rejected","last": <describe_page dict|None>, "error",
    "idp_error", "username_field"}.
    IdP 세션이 이미 있으면(두 번째 제품) 로그인 폼 없이 중계 폼만 타고 끝난다."""
    creds_submitted = False
    visited: set[str] = set()
    submitted_forms: set[str] = set()
    last: dict | None = None
    # 자격 제출 **직전** 페이지 — 거부 시 새로 생긴 문구만 골라 실제 오류를 판별하는 기준.
    baseline_html = ""
    used_username_field = ""
    try:
        r = await client.get(start_url, headers={"Accept": _HTML_ACCEPT})
    except Exception as exc:  # noqa: BLE001
        return {"creds_submitted": False, "auth_rejected": False, "last": None,
                "error": str(exc)[:200], "idp_error": "", "username_field": ""}

    for _hop in range(MAX_FORM_HOPS):
        last = describe_page(r)
        text = r.text or ""
        forms = parse_forms(text)

        login_form = find_login_form(forms)
        if login_form is not None:
            sig = login_form_signature(login_form)
            if sig in submitted_forms:
                # **같은 구성의** 폼이 다시 나옴 → 인증 거부로 확정. 다른 전략으로
                # 재시도하면 계정 잠금을 유발하므로 즉시 중단한다.
                return {"creds_submitted": True, "auth_rejected": True, "last": last,
                        "error": "",
                        "idp_error": extract_error_text(text, baseline_html=baseline_html),
                        "username_field": used_username_field}
            # 필드 구성이 **다른** 폼이면 거부가 아니라 다단계 로그인(계정 → 비밀번호)이다.
            baseline_html = text
            picked = pick_username_field(login_form, username_field_name)
            used_username_field = (picked or {}).get("name", "") or used_username_field
            data = fill_login_form(login_form, username, password,
                                   username_field_name=username_field_name)
            action = urljoin(str(r.url), login_form["action"] or str(r.url))
            r = await client.post(action, data=data, headers=_form_post_headers(str(r.url)))
            submitted_forms.add(sig)
            creds_submitted = True
            # 로그인으로 세션 상태가 바뀌었다 — 같은 중계 URL 을 다시 타야 토큰을 받는
            # 구성(OpenAM 류)이 있으므로 방문 기록을 비운다(무한루프는 MAX_FORM_HOPS 로 방지).
            visited.clear()
            continue

        auto = find_autosubmit_form(forms)
        if auto is not None:
            data = {i["name"]: i["value"] for i in auto["inputs"] if i["name"]}
            action = urljoin(str(r.url), auto["action"] or str(r.url))
            r = await client.post(action, data=data, headers=_form_post_headers(str(r.url)))
            visited.clear()
            continue

        nxt = find_client_redirect(text, str(r.url))
        if nxt and nxt not in visited:
            visited.add(nxt)
            r = await client.get(nxt, headers={"Accept": _HTML_ACCEPT})
            continue

        break  # 더 제출할 폼도, 따라갈 리다이렉트도 없음 — 체인 종료

    return {"creds_submitted": creds_submitted, "auth_rejected": False, "last": last,
            "error": "", "idp_error": "", "username_field": used_username_field}


async def _verify_session(client: httpx.AsyncClient, base_url: str, verify_path: str) -> dict:
    """세션 검증 — 200 이면 계정 정보 추출. Confluence(user/current)는 name 대신 username."""
    try:
        probe = await client.get(f"{base_url}{verify_path}", headers={"Accept": "application/json"})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "http_status": None, "error": str(exc)[:120]}
    if probe.status_code != 200:
        return {"ok": False, "http_status": probe.status_code}
    try:
        data = probe.json()
    except Exception:  # noqa: BLE001 - 200 이지만 JSON 아님(프록시/로그인 페이지 등)
        return {"ok": False, "http_status": probe.status_code}
    # Confluence 는 세션이 없어도 200 + type=anonymous 를 주는 경우가 있다.
    if isinstance(data, dict) and (data.get("type") or "").lower() == "anonymous":
        return {"ok": False, "http_status": probe.status_code}
    account = data.get("name") or data.get("username") or data.get("key") or ""
    display = data.get("displayName") or account
    return {"ok": True, "account": account, "display_name": display}


async def _try_rest_session(client: httpx.AsyncClient, base_url: str, username: str, password: str) -> dict:
    """Jira `POST /rest/auth/1/session` — SSO 플러그인을 우회해 내부 디렉터리로 인증.

    IdP 로그인 페이지가 JS 라도 이 경로가 열려 있으면 세션 쿠키를 받을 수 있다.
    반환 {"tried": bool, "auth_rejected": bool, "detail": str}."""
    try:
        resp = await client.post(
            f"{base_url}/rest/auth/1/session",
            json={"username": username, "password": password},
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
    except Exception as exc:  # noqa: BLE001
        return {"tried": True, "auth_rejected": False, "detail": str(exc)[:120]}
    if resp.status_code in (200, 201):
        return {"tried": True, "auth_rejected": False, "detail": "ok"}
    # 401 은 단정하지 않는다 — 자격 오답일 수도, SSO 전용이라 내부 디렉터리 인증이 막힌
    # 것일 수도 있다. 다음 전략(native_form)까지만 진행하므로 총 시도는 2회로 제한된다.
    return {"tried": True, "auth_rejected": False, "detail": f"HTTP {resp.status_code}"}


async def _try_native_form(
    client: httpx.AsyncClient, base_url: str, product_key: str, username: str, password: str
) -> dict:
    """제품 자체 로그인 폼을 직접 POST (Jira login.jsp / Confluence dologin.action)."""
    spec = NATIVE_LOGIN_FORMS.get(product_key)
    if not spec:
        return {"tried": False, "detail": "지원 경로 없음"}
    path, destination = spec
    try:
        resp = await client.post(
            f"{base_url}{path}",
            data={
                "os_username": username,
                "os_password": password,
                "os_destination": destination,
                "login": "Log In",
            },
            headers={"Accept": _HTML_ACCEPT},
        )
    except Exception as exc:  # noqa: BLE001
        return {"tried": True, "detail": str(exc)[:120]}
    return {"tried": True, "detail": f"HTTP {resp.status_code}"}


async def _login_one_product(
    client: httpx.AsyncClient, prod: dict, username: str, password: str
) -> dict:
    """제품 1개에 대해 전략을 순서대로 시도하고 세션을 확보한다.

    반환 성공 → {"status":"ok","cookie_header","account","display_name","strategy"}
         실패 → {"status":"error","detail","diag"}"""
    key = prod.get("key") or "product"
    label = prod.get("label") or key
    base_url = (prod.get("base_url") or "").rstrip("/")
    verify_path = prod.get("verify_path") or JIRA_VERIFY_PATH
    host = (urlparse(base_url).hostname or "").lower()
    entry_paths = _entry_paths_for(prod)
    username_field_name = (prod.get("username_field") or "").strip()

    diag: dict = {"entries": [], "strategies": []}

    def _ok(verified: dict, strategy: str) -> dict | None:
        cookie_header = _cookie_header_for_host(client, host)
        if not cookie_header:
            diag["strategies"].append({"strategy": strategy, "result": "세션은 확인됐으나 쿠키 없음"})
            return None
        return {
            "status": "ok", "cookie_header": cookie_header,
            "account": verified["account"], "display_name": verified["display_name"],
            "strategy": strategy, "diag": diag,
        }

    def _rejected(idp_error: str = "", used_field: str = "") -> dict:
        # IdP 가 폼을 다시 보여준 것이 곧 오답은 아니다 — 흐름(추가 단계/인코딩/CSRF) 이나
        # **계정 필드 오선택**(사번 칸에 다른 값) 일 수도 있어, IdP 가 새로 표시한 문구와
        # 우리가 채운 필드명을 함께 전달해 판단을 돕는다.
        field_hint = f" ▸ 계정을 채운 필드: `{used_field}`" if used_field else ""
        if idp_error:
            detail = f'SSO 로그인이 거부되었습니다 — IdP 응답: "{idp_error}"{field_hint}'
        else:
            detail = (
                "자격 제출 후 같은 로그인 폼이 다시 표시됐습니다(새 오류 문구 없음) — "
                "아이디/비밀번호가 틀렸거나, IdP 가 추가 인증 단계를 요구하는 구성입니다."
                f"{field_hint} ▸ 'SSO 진단' 의 계정 필드/hidden 필드를 확인하세요."
            )
        return {"status": "error", "auth_rejected": True, "detail": detail, "diag": diag}

    # 이미 유효한 세션이 있으면(다중 제품에서 IdP 쿠키 공유 등) 바로 사용.
    verified = await _verify_session(client, base_url, verify_path)
    if verified["ok"]:
        hit = _ok(verified, "existing_session")
        if hit:
            return hit

    # ── 전략 1: SSO 폼 체인 (진입 경로 여러 개 시도) ────────────────────────────
    for path in entry_paths:
        chain = await _drive_form_chain(client, _entry_url(base_url, path), username, password,
                                        username_field_name=username_field_name)
        entry = {"path": path, "error": chain["error"]}
        entry.update(chain["last"] or {})
        diag["entries"].append(entry)
        if chain["auth_rejected"]:
            return _rejected(chain.get("idp_error", ""), chain.get("username_field", ""))
        if chain["error"]:
            diag["strategies"].append({"strategy": f"sso_form({path})", "result": chain["error"]})
            continue
        verified = await _verify_session(client, base_url, verify_path)
        if not verified["ok"] and chain["creds_submitted"]:
            # IdP 에서 로그인은 됐지만 제품 세션이 아직 없는 구성(OpenAM/SiteMinder 류) —
            # IdP 세션이 생긴 상태로 같은 진입점(→ 실패 시 루트)을 한 번 더 태우면
            # 토큰 교환이 완료되며 제품 세션이 발급된다. 자격은 이미 있으니 재입력 없음.
            for retry_url in dict.fromkeys([_entry_url(base_url, path), f"{base_url}/"]):
                back = await _drive_form_chain(client, retry_url, username, password,
                                               username_field_name=username_field_name)
                if back["auth_rejected"]:
                    return _rejected(back.get("idp_error", ""), back.get("username_field", ""))
                verified = await _verify_session(client, base_url, verify_path)
                diag["strategies"].append({
                    "strategy": f"sso_form({path})+return({retry_url})",
                    "result": "ok" if verified["ok"] else f"verify {verified.get('http_status')}",
                })
                if verified["ok"]:
                    break
        else:
            diag["strategies"].append({
                "strategy": f"sso_form({path})",
                "result": "ok" if verified["ok"] else f"verify {verified.get('http_status')}",
                "creds_submitted": chain["creds_submitted"],
            })
        if verified["ok"]:
            hit = _ok(verified, "sso_form")
            if hit:
                return hit

    # ── 전략 2: Jira REST 세션 로그인 (SSO 플러그인 우회) ───────────────────────
    if key == "jira":
        rest = await _try_rest_session(client, base_url, username, password)
        diag["strategies"].append({"strategy": "rest_session", "result": rest["detail"]})
        if rest["auth_rejected"]:
            return _rejected()
        verified = await _verify_session(client, base_url, verify_path)
        if verified["ok"]:
            hit = _ok(verified, "rest_session")
            if hit:
                return hit

    # ── 전략 3: 제품 자체 로그인 폼 직접 POST ───────────────────────────────────
    native = await _try_native_form(client, base_url, key, username, password)
    if native["tried"]:
        diag["strategies"].append({"strategy": "native_form", "result": native["detail"]})
        verified = await _verify_session(client, base_url, verify_path)
        if verified["ok"]:
            hit = _ok(verified, "native_form")
            if hit:
                return hit

    # 전부 실패 — 마지막으로 본 페이지 요약을 사유에 담아 원인 파악을 돕는다.
    last = next((e for e in reversed(diag["entries"]) if e.get("final_url")), {})
    hint = ""
    if last:
        hint = (
            f" ▸ 마지막 확인 페이지: {last.get('final_url', '')} "
            f"(HTTP {last.get('http_status')}, 폼 {last.get('forms', 0)}개, "
            f"password 입력 {last.get('password_inputs', 0)}개"
            + (f", 제목 '{last.get('title')}'" if last.get("title") else "")
            + (f", 리다이렉트 {last.get('client_redirect')}" if last.get("client_redirect") else "")
            + (f", 인증요구 {last.get('www_authenticate')}" if last.get("www_authenticate") else "")
            + ")"
        )
    return {
        "status": "error",
        "detail": (
            f"{label} 세션을 얻지 못했습니다 — 로그인 폼/대체 경로가 모두 실패했습니다."
            f"{hint} ▸ 설정의 'SSO 진단' 으로 백엔드가 보는 로그인 페이지를 확인하세요."
        ),
        "diag": diag,
    }


def _client(verify_tls: bool, timeout: float, transport) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        verify=verify_tls, follow_redirects=True, timeout=timeout,
        headers={"User-Agent": _BROWSER_UA, "Accept": _HTML_ACCEPT},
        transport=transport,
    )


async def sso_login_products(
    products: list[dict],
    username: str,
    password: str,
    *,
    verify_tls: bool = True,
    timeout: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """한 IdP 세션으로 여러 Atlassian 제품에 연속 SSO 로그인 (파드 내, 브라우저 없음).

    products: [{"key","label","base_url","verify_path"}] — **첫 항목이 주 제품**으로 전체
    status 를 결정한다. 이후 제품 실패는 products[key] 에만 기록되고 전체는 ok 유지.
    반환(주 제품 성공 시): {"status":"ok","cookie_header","account","display_name","strategy",
    "products": {key: {...}}}.
    `transport` 는 테스트용(httpx.MockTransport) 주입 지점.
    """
    if not products:
        return {"status": "error", "detail": "로그인할 제품이 설정되지 않았습니다.", "products": {}}
    if not (username and password):
        return {"status": "error", "detail": "SSO 아이디/비밀번호를 입력하세요.", "products": {}}

    out: dict[str, dict] = {}
    try:
        async with _client(verify_tls, timeout, transport) as client:
            for idx, prod in enumerate(products):
                key = prod.get("key") or f"product{idx}"
                label = prod.get("label") or key
                is_primary = idx == 0
                if not (prod.get("base_url") or "").rstrip("/"):
                    detail = f"{label} Base URL 이 설정되지 않았습니다."
                    out[key] = {"status": "error", "detail": detail}
                    if is_primary:
                        return {"status": "error", "detail": detail, "products": out}
                    continue
                res = await _login_one_product(client, prod, username, password)
                out[key] = res
                if res["status"] != "ok" and is_primary:
                    return {"status": "error", "detail": res["detail"],
                            "diag": res.get("diag"), "products": out}
    except Exception as exc:  # noqa: BLE001 - fail-safe
        logger.exception("form SSO login error: %s", exc)
        return {"status": "error", "detail": f"SSO 폼 로그인 중 오류: {exc}", "products": out}

    primary = out[products[0].get("key") or "product0"]
    logger.info("SSO login ok via %s (products=%s)", primary.get("strategy"), list(out))
    return {
        "status": "ok",
        "cookie_header": primary["cookie_header"],
        "account": primary["account"],
        "display_name": primary["display_name"],
        "strategy": primary.get("strategy", ""),
        "products": out,
    }


async def diagnose_products(
    products: list[dict],
    *,
    verify_tls: bool = True,
    timeout: float = 20.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict]:
    """자격 없이 각 제품의 진입 경로를 GET 해 **백엔드가 보는 로그인 페이지**를 보고한다.

    폐쇄망 IdP 는 외부에서 열어볼 수 없으므로, 로그인 실패 원인(폼이 정말 없는지, JS
    리다이렉트인지, 인증 방식이 Negotiate/Basic 인지)을 이 결과로 판별한다."""
    rows: list[dict] = []
    try:
        async with _client(verify_tls, timeout, transport) as client:
            for prod in products:
                key = prod.get("key") or "product"
                base_url = (prod.get("base_url") or "").rstrip("/")
                if not base_url:
                    continue
                for path in _entry_paths_for(prod):
                    row = await probe_entry(client, _entry_url(base_url, path))
                    row["product"] = key
                    row["url"] = path
                    rows.append(row)
    except Exception as exc:  # noqa: BLE001 - fail-safe
        logger.exception("SSO diagnose error: %s", exc)
        rows.append({"product": "-", "url": "-", "error": str(exc)[:200]})
    return rows


async def form_sso_login(
    base_url: str,
    username: str,
    password: str,
    *,
    verify_tls: bool = True,
    timeout: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Jira 단일 제품 SSO 로그인 — `sso_login_products` 의 하위호환 래퍼."""
    if not (base_url or "").rstrip("/"):
        return {"status": "error", "detail": "Jira Base URL 이 설정되지 않았습니다."}
    return await sso_login_products(
        [{"key": "jira", "label": "Jira", "base_url": base_url, "verify_path": JIRA_VERIFY_PATH}],
        username, password, verify_tls=verify_tls, timeout=timeout, transport=transport,
    )
