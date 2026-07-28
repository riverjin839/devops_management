"""jira_sso_http (파드 내 브라우저 없는 SSO 폼 로그인) 단위 테스트.

DB/네트워크 불필요 — 폼 파싱은 순수 함수로, 전체 로그인 흐름은 httpx.MockTransport 로
Keycloak 류 IdP(리다이렉트 → 로그인 폼 → 콜백 → 세션 쿠키)를 시뮬레이션해 검증한다.
"""
import base64
from urllib.parse import parse_qs

import httpx

from app.services.jira_sso_http import (
    CONFLUENCE_VERIFY_PATH,
    JIRA_VERIFY_PATH,
    diagnose_products,
    fill_login_form,
    find_autosubmit_form,
    find_client_redirect,
    find_login_form,
    form_sso_login,
    form_wants_base64,
    parse_forms,
    sso_login_products,
)

KEYCLOAK_LOGIN_HTML = """
<html><body>
<form id="kc-form-login" action="/auth/realms/pep/login-actions/authenticate?session_code=abc" method="post">
  <input tabindex="1" id="username" name="username" value="" type="text" autofocus />
  <input tabindex="2" id="password" name="password" type="password" autocomplete="off" />
  <input type="hidden" id="id-hidden-input" name="credentialId" value="cred-1" />
  <input tabindex="4" name="login" id="kc-login" type="submit" value="Sign In"/>
</form>
</body></html>
"""

SAML_AUTOSUBMIT_HTML = """
<html><body onload="document.forms[0].submit()">
<form method="post" action="https://jira.local/plugins/servlet/samlconsumer">
  <input type="hidden" name="SAMLResponse" value="b64payload"/>
  <input type="hidden" name="RelayState" value="/"/>
  <input type="submit" value="Continue"/>
</form>
</body></html>
"""


# ── 폼 파싱 (순수 함수) ─────────────────────────────────────────────────────────
def test_parse_and_find_keycloak_login_form():
    forms = parse_forms(KEYCLOAK_LOGIN_HTML)
    assert len(forms) == 1
    login = find_login_form(forms)
    assert login is not None
    assert "login-actions/authenticate" in login["action"]
    assert find_autosubmit_form(forms) is None  # password 폼은 auto-submit 아님


def test_fill_login_form_keycloak():
    login = find_login_form(parse_forms(KEYCLOAK_LOGIN_HTML))
    data = fill_login_form(login, "hong", "pw123")
    assert data["username"] == "hong"
    assert data["password"] == "pw123"
    assert data["credentialId"] == "cred-1"  # hidden 값 유지
    assert data["login"] == "Sign In"        # submit 버튼 name 포함


def test_fill_login_form_jira_native_os_fields():
    html = """
    <form action="/login.jsp" method="post">
      <input name="os_username" type="text"/><input name="os_password" type="password"/>
      <input type="hidden" name="os_destination" value="/secure/Dashboard.jspa"/>
    </form>"""
    login = find_login_form(parse_forms(html))
    data = fill_login_form(login, "hong", "pw123")
    assert data["os_username"] == "hong"
    assert data["os_password"] == "pw123"
    assert data["os_destination"] == "/secure/Dashboard.jspa"


def test_find_autosubmit_form_saml():
    forms = parse_forms(SAML_AUTOSUBMIT_HTML)
    assert find_login_form(forms) is None
    auto = find_autosubmit_form(forms)
    assert auto is not None
    assert any(i["name"] == "SAMLResponse" for i in auto["inputs"])


# ── 전체 로그인 흐름 (MockTransport 로 Keycloak 류 SSO 시뮬레이션) ────────────────
def _make_idp_transport(expected_pw: str = "pw123") -> httpx.MockTransport:
    """jira.local + idp.local 을 흉내내는 핸들러.

    GET jira/ → IdP 로그인 폼 리다이렉트 → POST 자격 → 성공 시 Jira 콜백에서
    JSESSIONID 세션 쿠키 발급 → myself 는 그 쿠키가 있을 때만 200.
    """
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        has_session = "JSESSIONID=sess-1" in request.headers.get("cookie", "")
        if url == "https://jira.local/":
            if has_session:  # 로그인 후 재방문 — 일반 페이지(폼 없음)
                return httpx.Response(200, text="<html><body>dashboard</body></html>")
            return httpx.Response(302, headers={"Location": "https://idp.local/auth?client=jira"})
        if url.startswith("https://idp.local/auth?"):
            return httpx.Response(200, text=KEYCLOAK_LOGIN_HTML, headers={"Content-Type": "text/html"})
        if "login-actions/authenticate" in url:
            body = request.content.decode()
            if f"password={expected_pw}" in body and "username=hong" in body:
                return httpx.Response(302, headers={"Location": "https://jira.local/sso/callback?code=ok"})
            # 오답 → 로그인 폼 재표시 (실제 Keycloak 동작)
            return httpx.Response(200, text=KEYCLOAK_LOGIN_HTML, headers={"Content-Type": "text/html"})
        if url.startswith("https://jira.local/sso/callback"):
            return httpx.Response(
                302,
                headers={"Location": "https://jira.local/", "Set-Cookie": "JSESSIONID=sess-1; Path=/"},
            )
        if url == "https://jira.local/rest/api/2/myself":
            if has_session:
                return httpx.Response(200, json={"name": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_form_sso_login_success_end_to_end():
    result = await form_sso_login(
        "https://jira.local", "hong", "pw123", transport=_make_idp_transport()
    )
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-1" in result["cookie_header"]
    assert result["account"] == "hong"
    assert result["display_name"] == "홍길동"


async def test_form_sso_login_wrong_password():
    result = await form_sso_login(
        "https://jira.local", "hong", "WRONG", transport=_make_idp_transport()
    )
    assert result["status"] == "error"
    # 오류 문구가 없는 IdP 면 "같은 폼 재표시" 사유로 보고된다.
    assert "다시 표시" in result["detail"] or "거부" in result["detail"], result["detail"]


async def test_form_sso_login_missing_inputs():
    result = await form_sso_login("https://jira.local", "", "", transport=_make_idp_transport())
    assert result["status"] == "error"


# ── 다중 제품 (Jira + Confluence, IdP 세션 재사용) ───────────────────────────────
CONFLUENCE_AUTOSUBMIT_HTML = """
<html><body onload="document.forms[0].submit()">
<form method="post" action="https://confluence.local/plugins/servlet/samlconsumer">
  <input type="hidden" name="SAMLResponse" value="b64payload2"/>
</form></body></html>
"""


def _make_multi_product_transport() -> httpx.MockTransport:
    """jira.local + confluence.local + idp.local — IdP 세션(IDP_SESSION) 이 생기면
    두 번째 제품은 로그인 폼 없이 auto-submit 폼만 타고 세션이 발급되는 실제 SSO 흐름."""
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        cookies = request.headers.get("cookie", "")
        has_jira = "JSESSIONID=sess-1" in cookies
        has_conf = "CONFSESSION=conf-1" in cookies
        has_idp = "IDP_SESSION=idp-1" in cookies

        if url == "https://jira.local/":
            if has_jira:
                return httpx.Response(200, text="<html><body>dashboard</body></html>")
            return httpx.Response(302, headers={"Location": "https://idp.local/auth?client=jira"})
        if url == "https://confluence.local/":
            if has_conf:
                return httpx.Response(200, text="<html><body>wiki</body></html>")
            return httpx.Response(302, headers={"Location": "https://idp.local/auth?client=confluence"})

        if url.startswith("https://idp.local/auth?"):
            if has_idp:  # 이미 IdP 로그인됨 → 제품별 auto-submit 폼으로 바로 중계
                html = CONFLUENCE_AUTOSUBMIT_HTML if "client=confluence" in url else SAML_AUTOSUBMIT_HTML
                return httpx.Response(200, text=html, headers={"Content-Type": "text/html"})
            return httpx.Response(200, text=KEYCLOAK_LOGIN_HTML, headers={"Content-Type": "text/html"})
        if "login-actions/authenticate" in url:
            body = request.content.decode()
            if "password=pw123" in body and "username=hong" in body:
                # IdP 세션 발급 + 최초 클라이언트(Jira) 의 auto-submit 폼 반환
                return httpx.Response(
                    200, text=SAML_AUTOSUBMIT_HTML,
                    headers={"Content-Type": "text/html", "Set-Cookie": "IDP_SESSION=idp-1; Path=/"},
                )
            return httpx.Response(200, text=KEYCLOAK_LOGIN_HTML, headers={"Content-Type": "text/html"})

        if url == "https://jira.local/plugins/servlet/samlconsumer":
            return httpx.Response(
                302, headers={"Location": "https://jira.local/", "Set-Cookie": "JSESSIONID=sess-1; Path=/"},
            )
        if url == "https://confluence.local/plugins/servlet/samlconsumer":
            return httpx.Response(
                302, headers={"Location": "https://confluence.local/", "Set-Cookie": "CONFSESSION=conf-1; Path=/"},
            )

        if url == "https://jira.local/rest/api/2/myself":
            if has_jira:
                return httpx.Response(200, json={"name": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        if url == "https://confluence.local/rest/api/user/current":
            if has_conf:
                return httpx.Response(200, json={"type": "known", "username": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _products(confluence_url: str = "https://confluence.local"):
    return [
        {"key": "jira", "label": "Jira", "base_url": "https://jira.local", "verify_path": JIRA_VERIFY_PATH},
        {"key": "confluence", "label": "Confluence", "base_url": confluence_url,
         "verify_path": CONFLUENCE_VERIFY_PATH},
    ]


async def test_sso_login_products_jira_and_confluence():
    """1회 ID/PW 로그인 → IdP 세션 재사용으로 Jira/Confluence 세션 동시 캡처."""
    result = await sso_login_products(_products(), "hong", "pw123",
                                      transport=_make_multi_product_transport())
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-1" in result["cookie_header"]      # 주 제품(Jira) 쿠키
    jira = result["products"]["jira"]
    conf = result["products"]["confluence"]
    assert jira["status"] == "ok" and conf["status"] == "ok"
    # 제품별 쿠키가 호스트별로 분리 캡처됐는지 (jar 공유에도 섞이면 안 됨)
    assert "JSESSIONID=sess-1" in jira["cookie_header"]
    assert "CONFSESSION" not in jira["cookie_header"]
    assert "CONFSESSION=conf-1" in conf["cookie_header"]
    assert "JSESSIONID" not in conf["cookie_header"]
    assert conf["account"] == "hong"


async def test_sso_login_products_confluence_failure_keeps_jira():
    """Confluence 쪽 실패(미도달 등)해도 주 제품(Jira) 로그인은 ok 로 유지된다."""
    result = await sso_login_products(
        _products("https://down.local"), "hong", "pw123",
        transport=_make_multi_product_transport(),
    )
    assert result["status"] == "ok", result
    assert result["products"]["jira"]["status"] == "ok"
    assert result["products"]["confluence"]["status"] == "error"


async def test_sso_login_products_primary_failure_fails_all():
    """주 제품(첫 항목) 로그인 실패는 전체 실패."""
    result = await sso_login_products(_products(), "hong", "WRONG",
                                      transport=_make_multi_product_transport())
    assert result["status"] == "error"
    assert "다시 표시" in result["detail"] or "거부" in result["detail"], result["detail"]


# ── 클라이언트 리다이렉트(JS/meta) 추적 ──────────────────────────────────────────
def test_find_client_redirect_meta_and_js():
    meta = '<html><head><meta http-equiv="refresh" content="0; url=/sso/am/jira/login.jsp"></head></html>'
    assert find_client_redirect(meta, "https://jira.local/") == "https://jira.local/sso/am/jira/login.jsp"

    js = '<html><script>window.location.href = "https://login.x.com/sso/am/jira/login.jsp";</script></html>'
    assert find_client_redirect(js, "https://jira.local/") == "https://login.x.com/sso/am/jira/login.jsp"

    assert find_client_redirect("<html><body>no redirect</body></html>", "https://jira.local/") == ""


# ── OpenAM 류: 루트는 폼 없음 + JS 훅으로 외부 IdP 로 이동 ────────────────────────
OPENAM_LOGIN_HTML = """
<html><body>
<form action="/sso/am/jira/login.jsp" method="post">
  <input type="text" name="IDToken1" value=""/>
  <input type="password" name="IDToken2"/>
  <input type="hidden" name="goto" value="https://jira.local/"/>
  <button type="submit" name="Login.Submit" value="Log In">Log In</button>
</form></body></html>
"""


def _make_openam_transport(anonymous_root: bool = False) -> httpx.MockTransport:
    """사용자 환경 재현: Jira 루트가 302 가 아니라 **JS 훅**으로 외부 IdP
    (login.x.com/sso/am/jira/login.jsp) 로 보내고, 거기 실제 ID/PW 폼이 있는 구성.

    anonymous_root=True 면 루트가 익명 대시보드(폼도 리다이렉트도 없음)를 주고, 보호 자원
    (/secure/Dashboard.jspa)에 접근해야 IdP 로 넘어간다 — 진입 경로 다중화 검증용."""
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        cookies = request.headers.get("cookie", "")
        has_jira = "JSESSIONID=sess-1" in cookies
        has_idp = "iPlanetDirectoryPro=idp-1" in cookies

        # 제품이 토큰을 받아 자체 세션을 발급하는 콜백.
        if url.startswith("https://jira.local/?token=") or url.startswith("https://jira.local/secure/Dashboard.jspa?token="):
            return httpx.Response(
                302, headers={"Location": "https://jira.local/", "Set-Cookie": "JSESSIONID=sess-1; Path=/"},
            )
        if url == "https://jira.local/":
            if has_jira:
                return httpx.Response(200, text="<html><body>dashboard</body></html>")
            if anonymous_root:  # 익명 대시보드 — 폼도 리다이렉트도 없음
                return httpx.Response(200, text="<html><body>anonymous dashboard</body></html>")
            return httpx.Response(200, text=(
                '<html><script>window.location.href = '
                '"https://login.x.com/sso/am/jira/login.jsp";</script></html>'
            ))
        if url.startswith("https://jira.local/secure/Dashboard.jspa"):
            if has_jira:
                return httpx.Response(200, text="<html><body>dashboard</body></html>")
            return httpx.Response(200, text=(
                '<html><head><meta http-equiv="refresh" content="0; '
                'url=https://login.x.com/sso/am/jira/login.jsp"></head></html>'
            ))
        if url.startswith("https://jira.local/login.jsp"):
            return httpx.Response(404)

        if url == "https://login.x.com/sso/am/jira/login.jsp":
            if request.method == "POST":
                body = request.content.decode()
                if "IDToken1=hong" in body and "IDToken2=pw123" in body:
                    # IdP 세션 발급 — 제품 세션은 아직 없다(제품 재진입 시 토큰 교환).
                    return httpx.Response(
                        302,
                        headers={"Location": "https://jira.local/",
                                 "Set-Cookie": "iPlanetDirectoryPro=idp-1; Path=/"},
                    )
                return httpx.Response(200, text=OPENAM_LOGIN_HTML)  # 오답 → 폼 재표시
            # IdP 세션이 있으면 로그인 폼 없이 제품으로 토큰과 함께 되돌려 보낸다.
            if has_idp:
                return httpx.Response(302, headers={"Location": "https://jira.local/?token=ok"})
            return httpx.Response(200, text=OPENAM_LOGIN_HTML, headers={"Content-Type": "text/html"})

        if url == "https://jira.local/rest/api/2/myself":
            if has_jira:
                return httpx.Response(200, json={"name": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        if url == "https://jira.local/rest/auth/1/session":
            return httpx.Response(404)  # SSO 전용 — REST 세션 경로 막힘
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_sso_login_follows_js_hook_to_external_idp():
    """루트가 JS 훅으로 외부 IdP 로 보내는 구성 — 리다이렉트를 따라가 로그인에 성공한다."""
    result = await form_sso_login("https://jira.local", "hong", "pw123",
                                  transport=_make_openam_transport())
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-1" in result["cookie_header"]
    assert result["strategy"] == "sso_form"
    # IdP 쿠키는 다른 호스트라 Jira Cookie 헤더에 섞이지 않아야 한다.
    assert "iPlanetDirectoryPro" not in result["cookie_header"]


async def test_sso_login_tries_protected_path_when_root_is_anonymous():
    """루트가 익명 대시보드라 폼이 없으면 보호 자원 진입 경로로 넘어가 SSO 를 태운다."""
    result = await form_sso_login("https://jira.local", "hong", "pw123",
                                  transport=_make_openam_transport(anonymous_root=True))
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-1" in result["cookie_header"]


async def test_sso_login_custom_idp_url_entry():
    """관리자가 IdP 로그인 URL 을 지정하면 그 주소부터 진입해 로그인한다."""
    result = await sso_login_products(
        [{"key": "jira", "label": "Jira", "base_url": "https://jira.local",
          "verify_path": JIRA_VERIFY_PATH,
          "sso_login_url": "https://login.x.com/sso/am/jira/login.jsp"}],
        "hong", "pw123", transport=_make_openam_transport(anonymous_root=True),
    )
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-1" in result["cookie_header"]


async def test_sso_login_wrong_password_stops_immediately():
    """오답이면 다른 진입 경로/전략으로 재시도하지 않는다 (AD 계정 잠금 방지)."""
    posts: list[str] = []

    base = _make_openam_transport()

    def counting_handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and "IDToken2" in request.content.decode():
            posts.append(str(request.url))
        return base.handler(request)

    result = await form_sso_login("https://jira.local", "hong", "WRONG",
                                  transport=httpx.MockTransport(counting_handler))
    assert result["status"] == "error"
    assert "다시 표시" in result["detail"] or "거부" in result["detail"], result["detail"]
    assert len(posts) == 1, f"자격 제출은 1회여야 함: {posts}"


# ── REST 세션 로그인 폴백 (JS 렌더링 IdP 대비) ───────────────────────────────────
def _make_rest_session_transport() -> httpx.MockTransport:
    """로그인 페이지가 JS 로 렌더링돼 폼을 못 찾지만, Jira REST 세션 로그인은 열린 구성."""
    state = {"logged_in": False}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://jira.local/rest/auth/1/session" and request.method == "POST":
            body = request.content.decode()
            if '"password": "pw123"' in body or '"password":"pw123"' in body:
                state["logged_in"] = True
                return httpx.Response(200, json={"session": {"name": "JSESSIONID", "value": "sess-9"}},
                                      headers={"Set-Cookie": "JSESSIONID=sess-9; Path=/"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        if url == "https://jira.local/rest/api/2/myself":
            if state["logged_in"]:
                return httpx.Response(200, json={"name": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        # 모든 HTML 진입 경로는 JS 앱 셸만 반환 — 폼 없음.
        return httpx.Response(200, text="<html><body><div id='app'></div></body></html>")

    return httpx.MockTransport(handler)


async def test_sso_login_falls_back_to_rest_session():
    """폼을 못 찾아도 Jira REST 세션 로그인으로 세션을 얻는다."""
    result = await form_sso_login("https://jira.local", "hong", "pw123",
                                  transport=_make_rest_session_transport())
    assert result["status"] == "ok", result
    assert result["strategy"] == "rest_session"
    assert "JSESSIONID=sess-9" in result["cookie_header"]


async def test_sso_login_failure_detail_includes_diagnostics():
    """모든 전략 실패 시 사유에 마지막으로 본 페이지 요약이 담긴다."""
    def handler(request: httpx.Request) -> httpx.Response:
        if "/rest/" in str(request.url):
            return httpx.Response(401, json={"detail": "unauthorized"})
        return httpx.Response(200, text="<html><head><title>Jira Dashboard</title></head><body>hi</body></html>")

    result = await form_sso_login("https://jira.local", "hong", "pw123",
                                  transport=httpx.MockTransport(handler))
    assert result["status"] == "error"
    assert "마지막 확인 페이지" in result["detail"]
    assert "Jira Dashboard" in result["detail"]


# ── 진단 ───────────────────────────────────────────────────────────────────────
async def test_diagnose_products_reports_login_form():
    rows = await diagnose_products(
        [{"key": "jira", "label": "Jira", "base_url": "https://jira.local",
          "sso_login_url": "https://login.x.com/sso/am/jira/login.jsp"}],
        transport=_make_openam_transport(),
    )
    assert rows, rows
    idp = next(r for r in rows if "login.x.com" in r.get("final_url", ""))
    assert idp["password_inputs"] == 1
    assert "IDToken2" in idp["input_names"]
    assert idp["hidden_fields"].get("goto") == "https://jira.local/"


# ── OpenAM `encoded=true` — 자격을 base64 로 제출해야 하는 구성 ───────────────────
ENCODED_LOGIN_HTML = """
<html><body>
<form action="/sso/am/UI/Login" method="post">
  <input type="text" name="IDToken1" value=""/>
  <input type="password" name="IDToken2"/>
  <input type="hidden" name="encoded" value="true"/>
  <input type="hidden" name="gx_charset" value="UTF-8"/>
  <input type="submit" name="Login.Submit" value="Log In"/>
</form></body></html>
"""


def test_form_wants_base64_and_fill_encodes():
    form = find_login_form(parse_forms(ENCODED_LOGIN_HTML))
    assert form_wants_base64(form) is True
    data = fill_login_form(form, "hong", "pw123")
    assert data["IDToken1"] == base64.b64encode(b"hong").decode()
    assert data["IDToken2"] == base64.b64encode(b"pw123").decode()
    assert data["encoded"] == "true"  # hidden 값은 그대로 유지

    plain = find_login_form(parse_forms(KEYCLOAK_LOGIN_HTML))
    assert form_wants_base64(plain) is False
    assert fill_login_form(plain, "hong", "pw123")["username"] == "hong"


def _make_encoded_idp_transport() -> httpx.MockTransport:
    """평문 자격은 거부하고 base64 자격만 받아들이는 OpenAM 구성 — 브라우저는 되는데
    스크립트만 '비밀번호 오답'으로 실패하던 실제 원인 재현."""
    b64_user = base64.b64encode(b"hong").decode()
    b64_pw = base64.b64encode(b"pw123").decode()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        has_jira = "JSESSIONID=sess-1" in request.headers.get("cookie", "")
        # 제품이 토큰을 받아 **자기 도메인에** 세션 쿠키를 발급 (IdP 는 남의 도메인 쿠키를
        # 설정할 수 없다 — 실제 SSO 와 동일한 제약).
        if url.startswith("https://jira.local/?token="):
            return httpx.Response(
                302, headers={"Location": "https://jira.local/", "Set-Cookie": "JSESSIONID=sess-1; Path=/"},
            )
        if url == "https://jira.local/":
            if has_jira:
                return httpx.Response(200, text="<html><body>dashboard</body></html>")
            return httpx.Response(302, headers={"Location": "https://login.x.com/sso/am/UI/Login"})
        if url == "https://login.x.com/sso/am/UI/Login":
            if request.method == "POST":
                form = parse_qs(request.content.decode())
                if form.get("IDToken1") == [b64_user] and form.get("IDToken2") == [b64_pw]:
                    return httpx.Response(302, headers={"Location": "https://jira.local/?token=ok"})
                # 평문/오답 → 오류 문구와 함께 폼 재표시
                return httpx.Response(200, text=ENCODED_LOGIN_HTML.replace(
                    "<form", "<p class='error'>Authentication failed. Please try again.</p><form"))
            return httpx.Response(200, text=ENCODED_LOGIN_HTML, headers={"Content-Type": "text/html"})
        if url == "https://jira.local/rest/api/2/myself":
            if has_jira:
                return httpx.Response(200, json={"name": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_sso_login_openam_encoded_credentials():
    """`encoded=true` 폼은 base64 로 제출해 로그인에 성공한다."""
    result = await form_sso_login("https://jira.local", "hong", "pw123",
                                  transport=_make_encoded_idp_transport())
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-1" in result["cookie_header"]


async def test_sso_login_rejection_reports_idp_error_text():
    """거부 시 IdP 가 화면에 쓴 오류 문구를 그대로 사유에 담는다."""
    result = await form_sso_login("https://jira.local", "hong", "WRONG",
                                  transport=_make_encoded_idp_transport())
    assert result["status"] == "error"
    assert "Authentication failed" in result["detail"], result["detail"]


# ── 다단계 로그인 (계정 → 비밀번호 화면 분리) ────────────────────────────────────
def _make_two_stage_transport() -> httpx.MockTransport:
    """1단계 계정 입력 → 2단계 비밀번호 입력으로 화면이 나뉜 IdP.

    필드 구성이 다른 폼이므로 '폼 재표시(오답)'로 오판하면 안 된다."""
    stage1 = ('<html><body><form action="/idp/stage2" method="post">'
              '<input type="text" name="username"/>'
              '<input type="password" name="dummy_pw"/></form></body></html>')
    stage2 = ('<html><body><form action="/idp/done" method="post">'
              '<input type="password" name="password"/>'
              '<input type="hidden" name="stage" value="2"/></form></body></html>')

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        has_jira = "JSESSIONID=sess-2" in request.headers.get("cookie", "")
        if url.startswith("https://jira.local/?token="):
            return httpx.Response(
                302, headers={"Location": "https://jira.local/", "Set-Cookie": "JSESSIONID=sess-2; Path=/"},
            )
        if url == "https://jira.local/":
            if has_jira:
                return httpx.Response(200, text="<html><body>dashboard</body></html>")
            return httpx.Response(302, headers={"Location": "https://idp.local/stage1"})
        if url == "https://idp.local/stage1":
            return httpx.Response(200, text=stage1, headers={"Content-Type": "text/html"})
        if url == "https://idp.local/idp/stage2":
            return httpx.Response(200, text=stage2, headers={"Content-Type": "text/html"})
        if url == "https://idp.local/idp/done":
            if parse_qs(request.content.decode()).get("password") == ["pw123"]:
                return httpx.Response(302, headers={"Location": "https://jira.local/?token=ok"})
            return httpx.Response(200, text=stage2)
        if url == "https://jira.local/rest/api/2/myself":
            if has_jira:
                return httpx.Response(200, json={"name": "hong", "displayName": "홍길동"})
            return httpx.Response(401, json={"detail": "unauthorized"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_sso_login_two_stage_flow_is_not_treated_as_rejection():
    result = await form_sso_login("https://jira.local", "hong", "pw123",
                                  transport=_make_two_stage_transport())
    assert result["status"] == "ok", result
    assert "JSESSIONID=sess-2" in result["cookie_header"]
