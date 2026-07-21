"""jira_sso_http (파드 내 브라우저 없는 SSO 폼 로그인) 단위 테스트.

DB/네트워크 불필요 — 폼 파싱은 순수 함수로, 전체 로그인 흐름은 httpx.MockTransport 로
Keycloak 류 IdP(리다이렉트 → 로그인 폼 → 콜백 → 세션 쿠키)를 시뮬레이션해 검증한다.
"""
import httpx

from app.services.jira_sso_http import (
    fill_login_form,
    find_autosubmit_form,
    find_login_form,
    form_sso_login,
    parse_forms,
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
    assert "올바르지" in result["detail"]


async def test_form_sso_login_missing_inputs():
    result = await form_sso_login("https://jira.local", "", "", transport=_make_idp_transport())
    assert result["status"] == "error"
