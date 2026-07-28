"""브라우저 없이 파드 안에서 수행하는 Jira/Confluence SSO 폼 로그인 (httpx 기반).

순수 ID/PW 폼 SSO(Keycloak/CAS/ADFS forms — 2차 인증 없음)는 IdP 로그인 페이지가 일반
HTML `<form>` 이라 JS 실행이 필요 없다. 따라서 브라우저(Playwright/Chromium) 없이도:

  1. 제품 첫 페이지 GET → SSO 리다이렉트 체인을 따라 IdP 로그인 폼 도착
  2. 폼 파싱(hidden 값 유지) → username/password 채워 POST
  3. SAML/OIDC auto-submit 폼(hidden-only)은 자동 제출하며 제품으로 복귀
  4. 쿠키 jar 에 쌓인 제품 세션 쿠키를 캡처 → verify 엔드포인트로 검증

으로 세션을 얻을 수 있다 — **기본 Alpine 이미지 그대로 동작**한다(추가 의존성 없음).
Jira 자체 로그인 폼(login.jsp, `os_username`/`os_password`)도 같은 로직으로 처리된다.
JS 가 필수인 IdP 는 이 경로가 실패하므로 로컬 도우미(jira_sso_helper.py)를 안내한다.

**다중 제품**: Jira 와 Confluence 가 같은 IdP 를 쓰면 쿠키 jar 를 공유하는 한 클라이언트로
제품을 순서대로 순회한다 — 첫 제품에서 IdP 로그인이 완료되면 다음 제품은 auto-submit
체인만 통과해 **비밀번호 재입력 없이** 세션이 떨어진다(`sso_login_products`).

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
# 제품별 세션 검증(로그인 성공 판정) 엔드포인트 — 200 이면 세션 유효.
JIRA_VERIFY_PATH = "/rest/api/2/myself"
CONFLUENCE_VERIFY_PATH = "/rest/api/user/current"
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


async def _drive_form_chain(
    client: httpx.AsyncClient, base_url: str, username: str, password: str
) -> dict:
    """제품 첫 페이지부터 로그인/auto-submit 폼 체인을 통과한다.

    반환: {"ok": bool, "creds_submitted": bool, "detail": str}.
    IdP 세션이 이미 있으면(두 번째 제품) 로그인 폼 없이 auto-submit 만 타고 끝난다."""
    r = await client.get(base_url + "/")
    creds_submitted = False
    for _hop in range(MAX_FORM_HOPS):
        forms = parse_forms(r.text or "")
        login_form = find_login_form(forms)
        if login_form is not None:
            if creds_submitted:
                # 자격 제출 후에도 password 폼이 다시 나옴 → 인증 실패로 판정.
                return {"ok": False, "creds_submitted": True,
                        "detail": "SSO 아이디 또는 비밀번호가 올바르지 않습니다."}
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
    return {"ok": True, "creds_submitted": creds_submitted, "detail": ""}


async def _verify_session(client: httpx.AsyncClient, base_url: str, verify_path: str) -> dict:
    """세션 검증 — 200 이면 계정 정보 추출. Confluence(user/current)는 name 대신 username."""
    probe = await client.get(f"{base_url}{verify_path}", headers={"Accept": "application/json"})
    if probe.status_code != 200:
        return {"ok": False, "http_status": probe.status_code}
    try:
        data = probe.json()
    except Exception:  # noqa: BLE001 - 200 이지만 JSON 아님(프록시 오류 페이지 등)
        return {"ok": False, "http_status": probe.status_code}
    account = data.get("name") or data.get("username") or data.get("key") or ""
    display = data.get("displayName") or account
    return {"ok": True, "account": account, "display_name": display}


async def sso_login_products(
    products: list[dict],
    username: str,
    password: str,
    *,
    verify_tls: bool = True,
    timeout: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """한 IdP 세션으로 여러 Atlassian 제품에 연속 SSO 폼 로그인 (파드 내, 브라우저 없음).

    products: [{"key","label","base_url","verify_path"}] — **첫 항목이 주 제품**으로 전체
    status 를 결정한다. 이후 제품 실패는 products[key] 에만 기록되고 전체는 ok 유지.
    반환(주 제품 성공 시): {"status":"ok","cookie_header","account","display_name",
    "products": {key: {"status","cookie_header","account","display_name"} | {"status","detail"}}}.
    `transport` 는 테스트용(httpx.MockTransport) 주입 지점.
    """
    if not products:
        return {"status": "error", "detail": "로그인할 제품이 설정되지 않았습니다.", "products": {}}
    if not (username and password):
        return {"status": "error", "detail": "SSO 아이디/비밀번호를 입력하세요.", "products": {}}

    out: dict[str, dict] = {}
    try:
        async with httpx.AsyncClient(
            verify=verify_tls, follow_redirects=True, timeout=timeout,
            headers={"User-Agent": _BROWSER_UA}, transport=transport,
        ) as client:
            for idx, prod in enumerate(products):
                key = prod.get("key") or f"product{idx}"
                label = prod.get("label") or key
                base_url = (prod.get("base_url") or "").rstrip("/")
                is_primary = idx == 0
                if not base_url:
                    out[key] = {"status": "error", "detail": f"{label} Base URL 이 설정되지 않았습니다."}
                    if is_primary:
                        return {"status": "error", "detail": out[key]["detail"], "products": out}
                    continue
                host = (urlparse(base_url).hostname or "").lower()
                try:
                    chain = await _drive_form_chain(client, base_url, username, password)
                    if not chain["ok"]:
                        out[key] = {"status": "error", "detail": chain["detail"]}
                        if is_primary:
                            return {"status": "error", "detail": chain["detail"], "products": out}
                        continue
                    verified = await _verify_session(
                        client, base_url, prod.get("verify_path") or JIRA_VERIFY_PATH
                    )
                except httpx.ConnectError as exc:
                    out[key] = {"status": "error", "detail": f"{label}/IdP 에 연결할 수 없습니다: {exc}"}
                    if is_primary:
                        return {"status": "error", "detail": out[key]["detail"], "products": out}
                    continue
                if not verified["ok"]:
                    if not chain["creds_submitted"]:
                        detail = (
                            f"{label} 로그인 폼을 찾지 못했습니다 — JS 기반 SSO 로 보입니다. "
                            "'로컬 도우미' 방식으로 로그인하세요."
                        )
                    else:
                        detail = (
                            f"로그인 후에도 {label} 세션이 확인되지 않습니다 "
                            f"(HTTP {verified['http_status']}). SSO 에 2차 인증이 있거나 "
                            "JS 필수 IdP 면 '로컬 도우미' 방식을 사용하세요."
                        )
                    out[key] = {"status": "error", "detail": detail}
                    if is_primary:
                        return {"status": "error", "detail": detail, "products": out}
                    continue
                cookie_header = _cookie_header_for_host(client, host)
                if not cookie_header:
                    detail = f"{label} 로그인은 됐으나 캡처된 세션 쿠키가 없습니다."
                    out[key] = {"status": "error", "detail": detail}
                    if is_primary:
                        return {"status": "error", "detail": detail, "products": out}
                    continue
                out[key] = {
                    "status": "ok",
                    "cookie_header": cookie_header,
                    "account": verified["account"],
                    "display_name": verified["display_name"],
                }
    except Exception as exc:  # noqa: BLE001 - fail-safe
        logger.exception("form SSO login error: %s", exc)
        return {"status": "error", "detail": f"SSO 폼 로그인 중 오류: {exc}", "products": out}

    primary = out[products[0].get("key") or "product0"]
    return {
        "status": "ok",
        "cookie_header": primary["cookie_header"],
        "account": primary["account"],
        "display_name": primary["display_name"],
        "products": out,
    }


async def form_sso_login(
    base_url: str,
    username: str,
    password: str,
    *,
    verify_tls: bool = True,
    timeout: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Jira 단일 제품 SSO 폼 로그인 — `sso_login_products` 의 하위호환 래퍼.

    반환: {"status":"ok","cookie_header","account","display_name"} 또는 {"status":"error","detail"}.
    """
    if not (base_url or "").rstrip("/"):
        return {"status": "error", "detail": "Jira Base URL 이 설정되지 않았습니다."}
    return await sso_login_products(
        [{"key": "jira", "label": "Jira", "base_url": base_url, "verify_path": JIRA_VERIFY_PATH}],
        username, password, verify_tls=verify_tls, timeout=timeout, transport=transport,
    )
