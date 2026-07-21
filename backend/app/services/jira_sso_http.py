"""브라우저 없이 파드 안에서 수행하는 Jira SSO 폼 로그인 (httpx 기반).

순수 ID/PW 폼 SSO(Keycloak/CAS/ADFS forms — 2차 인증 없음)는 IdP 로그인 페이지가 일반
HTML `<form>` 이라 JS 실행이 필요 없다. 따라서 브라우저(Playwright/Chromium) 없이도:

  1. Jira 첫 페이지 GET → SSO 리다이렉트 체인을 따라 IdP 로그인 폼 도착
  2. 폼 파싱(hidden 값 유지) → username/password 채워 POST
  3. SAML/OIDC auto-submit 폼(hidden-only)은 자동 제출하며 Jira 로 복귀
  4. 쿠키 jar 에 쌓인 Jira 세션 쿠키를 캡처 → `/rest/api/2/myself` 로 검증

으로 세션을 얻을 수 있다 — **기본 Alpine 이미지 그대로 동작**한다(추가 의존성 없음).
Jira 자체 로그인 폼(login.jsp, `os_username`/`os_password`)도 같은 로직으로 처리된다.
JS 가 필수인 IdP 는 이 경로가 실패하므로 로컬 도우미(jira_sso_helper.py)를 안내한다.

fail-safe: 절대 raise 하지 않고 {"status": "ok|error", ...} dict 를 반환한다.
"""
from __future__ import annotations

import logging
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)

# 리다이렉트/폼 제출 체인 최대 횟수 — SSO 왕복(로그인 폼 1회 + auto-submit 1~2회)에 넉넉히.
MAX_FORM_HOPS = 6
# 일반적인 username 필드 이름(IdP 별) — 우선 매칭. Jira 자체 폼은 os_username.
_USERNAME_FIELD_NAMES = (
    "username", "j_username", "os_username", "user", "userid", "user_id",
    "login", "loginid", "email", "username_input", "identifier",
)
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


class _FormParser(HTMLParser):
    """HTML 에서 <form> 들의 action/method/input 목록을 추출한다."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict] = []
        self._cur: dict | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        a = dict(attrs)
        if tag == "form":
            self._cur = {"action": a.get("action") or "", "method": (a.get("method") or "get").lower(), "inputs": []}
            self.forms.append(self._cur)
        elif tag == "input" and self._cur is not None:
            self._cur["inputs"].append({
                "name": a.get("name") or "",
                "value": a.get("value") or "",
                "type": (a.get("type") or "text").lower(),
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


def fill_login_form(form: dict, username: str, password: str) -> dict[str, str]:
    """로그인 폼의 제출 데이터 구성 — hidden 값 유지, username/password 채움.

    username 필드는 알려진 이름 우선, 없으면 첫 visible text/email 입력. submit 버튼에
    name 이 있으면(예: Keycloak `login`) 첫 번째 것만 포함한다.
    """
    data: dict[str, str] = {}
    submit_added = False
    username_set = False

    named_inputs = [i for i in form["inputs"] if i["name"]]
    known = {i["name"].lower(): i for i in named_inputs}
    username_field = next((known[n] for n in _USERNAME_FIELD_NAMES if n in known), None)

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
    """쿠키 jar 에서 Jira 호스트에 해당하는 쿠키만 추려 Cookie 헤더 문자열로."""
    def _match(dom: str) -> bool:
        d = (dom or "").lstrip(".").lower()
        return bool(d) and (host == d or host.endswith("." + d) or d.endswith("." + host))

    seen: set[str] = set()
    scoped: list[str] = []
    everything: list[str] = []
    for c in client.cookies.jar:
        if not c.name or c.name in seen:
            continue
        seen.add(c.name)
        pair = f"{c.name}={c.value}"
        everything.append(pair)
        if _match(c.domain or ""):
            scoped.append(pair)
    return "; ".join(scoped or everything)


async def form_sso_login(
    base_url: str,
    username: str,
    password: str,
    *,
    verify_tls: bool = True,
    timeout: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """파드 안에서 SSO 폼 로그인을 수행하고 세션 쿠키를 캡처한다.

    반환: {"status":"ok","cookie_header","account","display_name"} 또는 {"status":"error","detail"}.
    `transport` 는 테스트용(httpx.MockTransport) 주입 지점.
    """
    base_url = (base_url or "").rstrip("/")
    if not base_url:
        return {"status": "error", "detail": "Jira Base URL 이 설정되지 않았습니다."}
    if not (username and password):
        return {"status": "error", "detail": "SSO 아이디/비밀번호를 입력하세요."}

    host = (urlparse(base_url).hostname or "").lower()
    try:
        async with httpx.AsyncClient(
            verify=verify_tls, follow_redirects=True, timeout=timeout,
            headers={"User-Agent": _BROWSER_UA}, transport=transport,
        ) as client:
            r = await client.get(base_url + "/")
            creds_submitted = False
            for _hop in range(MAX_FORM_HOPS):
                forms = parse_forms(r.text or "")
                login_form = find_login_form(forms)
                if login_form is not None:
                    if creds_submitted:
                        # 자격 제출 후에도 password 폼이 다시 나옴 → 인증 실패로 판정.
                        return {"status": "error", "detail": "SSO 아이디 또는 비밀번호가 올바르지 않습니다."}
                    data = fill_login_form(login_form, username, password)
                    action = urljoin(str(r.url), login_form["action"] or str(r.url))
                    r = await client.post(action, data=data)
                    creds_submitted = True
                    continue
                auto = find_autosubmit_form(forms)
                if auto is not None:
                    data = {i["name"]: i["value"] for i in auto["inputs"] if i["name"]}
                    action = urljoin(str(r.url), auto["action"] or str(r.url))
                    r = await client.post(action, data=data)
                    continue
                break  # 더 제출할 폼 없음 — 체인 종료

            probe = await client.get(f"{base_url}/rest/api/2/myself", headers={"Accept": "application/json"})
            if probe.status_code != 200:
                if not creds_submitted:
                    return {
                        "status": "error",
                        "detail": "로그인 폼을 찾지 못했습니다 — JS 기반 SSO 로 보입니다. "
                                  "'로컬 도우미' 방식으로 로그인하세요.",
                    }
                return {
                    "status": "error",
                    "detail": f"로그인 후에도 Jira 세션이 확인되지 않습니다 (HTTP {probe.status_code}). "
                              "SSO 에 2차 인증이 있거나 JS 필수 IdP 면 '로컬 도우미' 방식을 사용하세요.",
                }
            data = probe.json()
            account = data.get("name") or data.get("key") or ""
            display = data.get("displayName") or account
            cookie_header = _cookie_header_for_host(client, host)
            if not cookie_header:
                return {"status": "error", "detail": "로그인은 됐으나 캡처된 세션 쿠키가 없습니다."}
            return {"status": "ok", "cookie_header": cookie_header, "account": account, "display_name": display}
    except httpx.ConnectError as exc:
        return {"status": "error", "detail": f"Jira/IdP 에 연결할 수 없습니다: {exc}"}
    except Exception as exc:  # noqa: BLE001 - fail-safe
        logger.exception("form SSO login error: %s", exc)
        return {"status": "error", "detail": f"SSO 폼 로그인 중 오류: {exc}"}
