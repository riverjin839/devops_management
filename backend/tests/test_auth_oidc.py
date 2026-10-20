"""R-7 사내 IdP SSO(OIDC) — 가짜 IdP(httpx.MockTransport + RSA 서명 id_token)로 전체 흐름을 태운다.

state·handoff 저장소는 프로세스 메모리 폴백으로 고정하고(테스트 간 격리), 로그인 레이트리밋은
끈다(실 Redis 의 IP 카운터가 반복 실행으로 쌓이지 않게). Redis 경로는 별도 테스트 하나로 확인한다.
"""
import os
import time
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.security import create_access_token, decode_access_token, hash_password  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import login_rate_limiter  # noqa: E402
from app.services import oidc_service as oidc  # noqa: E402

ISSUER = "https://idp.example.test/realms/pep"
CLIENT_ID = "pep-portal"
CLIENT_SECRET = "s3cr3t-value-never-leak"


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


class FakeIdp:
    """discovery·JWKS·token·userinfo 를 흉내 낸다. ``id_token_factory(nonce)`` 로 토큰을 만든다."""

    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
        jwk.update({"kid": "k1", "use": "sig", "alg": "RS256"})
        self.jwks = {"keys": [jwk]}
        self.algs = ["RS256", "HS256"]  # HS256 을 광고해도 서버가 걸러야 한다
        self.claims_override: dict = {}
        self.drop_claims: set[str] = set()
        self.sign = self._sign_rs256
        self.token_status = 200
        self.userinfo: dict = {}
        self.token_requests: list[httpx.Request] = []
        self.nonce: str | None = None

    def _sign_rs256(self, claims: dict) -> str:
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "k1"})

    def id_token(self) -> str:
        now = int(time.time())
        claims = {
            "iss": ISSUER, "aud": CLIENT_ID, "sub": "sub-123", "iat": now, "exp": now + 300,
            "nonce": self.nonce, "preferred_username": self.username, "name": "SSO 사용자",
            "email": f"{self.username}@corp.example",
        }
        claims.update(self.claims_override)
        for c in self.drop_claims:
            claims.pop(c, None)
        return self.sign(claims)

    username = "sso-user"

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return httpx.Response(200, json={
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/auth",
                "token_endpoint": f"{ISSUER}/token",
                "jwks_uri": f"{ISSUER}/certs",
                "userinfo_endpoint": f"{ISSUER}/userinfo",
                "id_token_signing_alg_values_supported": self.algs,
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
            })
        if url == f"{ISSUER}/certs":
            return httpx.Response(200, json=self.jwks)
        if url == f"{ISSUER}/token":
            self.token_requests.append(request)
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"id_token": self.id_token(), "access_token": "at-1", "token_type": "Bearer"})
        if url == f"{ISSUER}/userinfo":
            return httpx.Response(200, json={"sub": "sub-123", **self.userinfo})
        return httpx.Response(404)


@pytest.fixture
def idp(monkeypatch):
    fake = FakeIdp()
    fake.username = f"sso-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(oidc, "_transport", httpx.MockTransport(fake.handler))
    monkeypatch.setattr(oidc, "_redis_client", False)  # 메모리 저장소
    monkeypatch.setattr(oidc, "_memory", oidc._MemoryStore())
    oidc._metadata_cache.clear()
    monkeypatch.setattr(login_rate_limiter, "check_login_allowed", lambda ip, u: (True, None))
    monkeypatch.setattr(login_rate_limiter, "record_failure", lambda ip, u: None)
    monkeypatch.setattr(login_rate_limiter, "record_success", lambda ip, u: None)
    yield fake
    oidc._metadata_cache.clear()


def _write_cfg(db, **over):
    cfg = dict(oidc.DEFAULTS)
    cfg.update({
        "enabled": True, "issuer": ISSUER, "client_id": CLIENT_ID,
        "client_secret_encrypted": oidc.secret_box.encrypt(CLIENT_SECRET),
        "display_name": "사내 SSO",
    })
    cfg.update(over)
    row = db.query(AppSetting).filter(AppSetting.key == oidc.SETTING_KEY).first()
    if row is None:
        db.add(AppSetting(key=oidc.SETTING_KEY, value=cfg))
    else:
        row.value = cfg
    db.commit()


@pytest.fixture
def oidc_cfg(db):
    """auth.oidc 설정을 테스트 값으로 바꾸고 끝나면 원래대로 되돌린다."""
    row = db.query(AppSetting).filter(AppSetting.key == oidc.SETTING_KEY).first()
    original = dict(row.value) if row is not None else None
    _write_cfg(db)
    yield lambda **over: _write_cfg(db, **over)
    row = db.query(AppSetting).filter(AppSetting.key == oidc.SETTING_KEY).first()
    if original is None:
        if row is not None:
            db.delete(row)
    else:
        row.value = original
    db.commit()


@pytest.fixture
def client():
    return TestClient(app, follow_redirects=False)


@pytest.fixture
def cleanup_users(db):
    names: list[str] = []
    yield names
    db.query(User).filter(User.username.in_(names)).delete(synchronize_session=False)
    db.commit()


def _make_user(db, username: str, *, role: str = "operator", active: bool = True, password: str | None = None):
    u = User(username=username, hashed_password=hash_password(password) if password else None,
             role=role, display_name=None, is_active=active)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _start(client, idp, return_to: str = "/tasks-mgmt?x=1"):
    r = client.get("/api/v1/auth/oidc/login", params={"return_to": return_to})
    assert r.status_code == 302, r.text
    loc = urlparse(r.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == f"{ISSUER}/auth"
    q = {k: v[0] for k, v in parse_qs(loc.query).items()}
    idp.nonce = q["nonce"]
    return q


def _callback(client, state: str, code: str = "authz-code-1"):
    r = client.get("/api/v1/auth/oidc/callback", params={"code": code, "state": state})
    assert r.status_code == 302, r.text
    loc = urlparse(r.headers["location"])
    assert loc.path == "/auth/callback"
    return {k: v[0] for k, v in parse_qs(loc.query).items()}


def _audit_reasons(db, username: str) -> list:
    rows = db.query(AuditLog).filter(AuditLog.actor_username == username).all()
    return [(r.action, (r.details or {}).get("reason")) for r in rows]


# ── 공개 설정 ────────────────────────────────────────────────────────────


def test_public_config_hides_secret(client, oidc_cfg):
    r = client.get("/api/v1/auth/oidc/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "display_name": "사내 SSO"}
    assert CLIENT_SECRET not in r.text and "client" not in r.text


def test_disabled_flow(client, idp, oidc_cfg):
    oidc_cfg(enabled=False)
    assert client.get("/api/v1/auth/oidc/config").json()["enabled"] is False
    r = client.get("/api/v1/auth/oidc/login")
    assert r.status_code == 302 and "error=disabled" in r.headers["location"]
    r = client.post("/api/v1/auth/oidc/exchange", json={"code": "x" * 20})
    assert r.status_code == 404


# ── 정상 로그인 ───────────────────────────────────────────────────────────


def test_login_existing_user_full_flow(client, idp, oidc_cfg, db, cleanup_users):
    user = _make_user(db, idp.username, role="operator")
    cleanup_users.append(user.username)
    q = _start(client, idp)
    assert q["code_challenge_method"] == "S256" and q["client_id"] == CLIENT_ID
    assert q["redirect_uri"] == "http://testserver/api/v1/auth/oidc/callback"
    assert "openid" in q["scope"].split()

    out = _callback(client, q["state"])
    assert "error" not in out and out["code"]
    assert "access_token" not in str(out)

    # PKCE verifier 가 토큰 요청에 실렸고 S256(verifier) == challenge, secret 은 Basic 헤더로.
    req = idp.token_requests[-1]
    form = parse_qs(req.content.decode())
    assert oidc.pkce_challenge(form["code_verifier"][0]) == q["code_challenge"]
    assert "client_secret" not in form and req.headers["authorization"].startswith("Basic ")

    r = client.post("/api/v1/auth/oidc/exchange", json={"code": out["code"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["username"] == user.username and body["user"]["role"] == "operator"
    assert body["return_to"] == "/tasks-mgmt?x=1"
    claims = decode_access_token(body["access_token"])
    assert claims["sub"] == user.username and claims["auth_time"] >= int(time.time()) - 5
    # handoff code 는 1회용
    assert client.post("/api/v1/auth/oidc/exchange", json={"code": out["code"]}).status_code == 400
    ok_log = db.query(AuditLog).filter(AuditLog.action == "login.success", AuditLog.target_id == user.id).one()
    assert ok_log.details["method"] == "oidc"
    assert out["code"] not in str(ok_log.details) and "at-1" not in str(ok_log.details)
    db.refresh(user)
    assert user.display_name == "SSO 사용자"  # 비어 있던 프로필만 채움


def test_auto_provision_creates_viewer(client, idp, oidc_cfg, db, cleanup_users):
    oidc_cfg(auto_provision=True, default_role="viewer")
    cleanup_users.append(idp.username)
    q = _start(client, idp, return_to="https://evil.example/")
    out = _callback(client, q["state"])
    r = client.post("/api/v1/auth/oidc/exchange", json={"code": out["code"]})
    assert r.status_code == 200, r.text
    assert r.json()["return_to"] == "/"  # 외부 주소는 복귀 경로로 쓰지 않는다
    u = db.query(User).filter(User.username == idp.username).one()
    assert u.role == "viewer" and u.hashed_password is None
    assert u.email == f"{idp.username}@corp.example" and u.employee_id == idp.username
    # 비밀번호 없는 계정은 비밀번호 로그인이 막힌다
    r = client.post("/api/v1/auth/login", json={"username": idp.username, "password": "anything"})
    assert r.status_code in (401, 429)


def test_userinfo_fills_missing_username_claim(client, idp, oidc_cfg, db, cleanup_users):
    user = _make_user(db, idp.username)
    cleanup_users.append(user.username)
    idp.drop_claims = {"preferred_username"}
    idp.userinfo = {"preferred_username": idp.username}
    q = _start(client, idp)
    out = _callback(client, q["state"])
    assert "code" in out, out


# ── 거부 경로 ────────────────────────────────────────────────────────────


def test_unknown_user_rejected_without_auto_provision(client, idp, oidc_cfg, db):
    q = _start(client, idp)
    assert _callback(client, q["state"]) == {"error": "user_not_found"}
    assert db.query(User).filter(User.username == idp.username).first() is None
    assert ("login.failure", "user_not_found") in _audit_reasons(db, idp.username)
    db.query(AuditLog).filter(AuditLog.actor_username == idp.username).delete()
    db.commit()


def test_inactive_user_rejected(client, idp, oidc_cfg, db, cleanup_users):
    cleanup_users.append(_make_user(db, idp.username, active=False).username)
    q = _start(client, idp)
    assert _callback(client, q["state"]) == {"error": "user_inactive"}


def test_state_mismatch_and_reuse(client, idp, oidc_cfg, db, cleanup_users):
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    assert _callback(client, "not-the-state") == {"error": "state_invalid"}
    assert "code" in _callback(client, q["state"])
    # 같은 state 재사용 거부
    assert _callback(client, q["state"]) == {"error": "state_invalid"}


def test_state_from_other_browser_rejected(client, idp, oidc_cfg, db, cleanup_users):
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    other = TestClient(app, follow_redirects=False)  # 바인딩 쿠키가 없는 다른 브라우저
    assert _callback(other, q["state"]) == {"error": "state_invalid"}


def test_nonce_mismatch(client, idp, oidc_cfg, db, cleanup_users):
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    idp.claims_override = {"nonce": "other-nonce"}
    assert _callback(client, q["state"]) == {"error": "nonce_mismatch"}


@pytest.mark.parametrize("override", [
    {"aud": "someone-else"},
    {"iss": "https://evil.example.test"},
    {"exp": int(time.time()) - 3600, "iat": int(time.time()) - 7200},
])
def test_id_token_claim_checks(client, idp, oidc_cfg, db, cleanup_users, override):
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    idp.claims_override = override
    assert _callback(client, q["state"]) == {"error": "id_token_invalid"}


def test_hs256_forgery_rejected(client, idp, oidc_cfg, db, cleanup_users):
    """client secret 을 HMAC 키로 쓴 위조 토큰 — discovery 가 HS256 을 광고해도 거부."""
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    idp.sign = lambda claims: jwt.encode(claims, CLIENT_SECRET, algorithm="HS256", headers={"kid": "k1"})
    assert _callback(client, q["state"]) == {"error": "id_token_invalid"}


def test_wrong_signing_key_rejected(client, idp, oidc_cfg, db, cleanup_users):
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    idp.sign = lambda claims: jwt.encode(claims, other, algorithm="RS256", headers={"kid": "k1"})
    assert _callback(client, q["state"]) == {"error": "id_token_invalid"}


def test_domain_not_allowed(client, idp, oidc_cfg, db, cleanup_users):
    oidc_cfg(allowed_domains=["corp.internal"])
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    assert _callback(client, q["state"]) == {"error": "domain_not_allowed"}


def test_token_endpoint_failure_is_structured(client, idp, oidc_cfg, db, cleanup_users):
    cleanup_users.append(_make_user(db, idp.username).username)
    q = _start(client, idp)
    idp.token_status = 400
    assert _callback(client, q["state"]) == {"error": "token_exchange_failed"}


def test_idp_error_param(client, idp, oidc_cfg):
    q = _start(client, idp)
    r = client.get("/api/v1/auth/oidc/callback", params={"state": q["state"], "error": "access_denied"})
    assert r.status_code == 302 and r.headers["location"].endswith("error=idp_error")


def test_discovery_unreachable(client, idp, oidc_cfg, monkeypatch):
    def boom(request):
        raise httpx.ConnectError("refused")
    monkeypatch.setattr(oidc, "_transport", httpx.MockTransport(boom))
    r = client.get("/api/v1/auth/oidc/login")
    assert r.status_code == 302 and r.headers["location"].endswith("error=discovery_failed")


# ── 관리자 설정 ───────────────────────────────────────────────────────────


def _admin_headers(db, cleanup_users):
    admin = _make_user(db, f"oidc-admin-{uuid.uuid4().hex[:6]}", role="admin")
    cleanup_users.append(admin.username)
    return {"Authorization": f"Bearer {create_access_token(subject=admin.username, role='admin')}"}


def test_admin_settings_roundtrip(client, idp, oidc_cfg, db, cleanup_users):
    h = _admin_headers(db, cleanup_users)
    r = client.get("/api/v1/auth/oidc/settings", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["has_secret"] is True and CLIENT_SECRET not in r.text
    assert "client_secret_encrypted" not in body
    assert body["redirect_uri"] == "http://testserver/api/v1/auth/oidc/callback"

    r = client.put("/api/v1/auth/oidc/settings", headers=h, json={
        "client_secret": "new-secret", "scopes": "profile email", "public_base_url": "https://pep.corp/",
        "allowed_domains": ["@Corp.Example", ""],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scopes"] == "openid profile email"
    assert body["allowed_domains"] == ["corp.example"]
    assert body["redirect_uri"] == "https://pep.corp/api/v1/auth/oidc/callback"
    assert "new-secret" not in r.text
    assert oidc.client_secret(oidc.load_config(db)) == "new-secret"
    log = db.query(AuditLog).filter(AuditLog.action == "settings.oidc.update").order_by(AuditLog.created_at.desc()).first()
    assert log is not None and "new-secret" not in str(log.details)

    assert client.put("/api/v1/auth/oidc/settings", headers=h, json={"default_role": "admin"}).status_code == 400
    assert client.put("/api/v1/auth/oidc/settings", headers=h, json={"issuer": "ftp://x"}).status_code == 400

    r = client.post("/api/v1/auth/oidc/settings/test", headers=h, json={})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.json()["algorithms"] == ["RS256"]  # HS256 은 걸러진다


def test_settings_require_admin(client, oidc_cfg, db, cleanup_users):
    viewer = _make_user(db, f"oidc-viewer-{uuid.uuid4().hex[:6]}", role="viewer")
    cleanup_users.append(viewer.username)
    h = {"Authorization": f"Bearer {create_access_token(subject=viewer.username, role='viewer')}"}
    assert client.get("/api/v1/auth/oidc/settings", headers=h).status_code == 403
    assert client.get("/api/v1/auth/oidc/settings").status_code == 401
    assert client.put("/api/v1/auth/oidc/settings", headers=h, json={"enabled": False}).status_code == 403


# ── 저장소(Redis) ──────────────────────────────────────────────────────────


def test_store_redis_one_time(monkeypatch):
    monkeypatch.setattr(oidc, "_redis_client", None)
    client = oidc._redis()
    try:
        if not client or not client.ping():
            pytest.skip("Redis 없음")
    except Exception:  # noqa: BLE001
        pytest.skip("Redis 없음")
    key = f"test:{uuid.uuid4().hex}"
    oidc.store_put(key, {"a": 1}, 30)
    assert oidc.store_pop(key) == {"a": 1}
    assert oidc.store_pop(key) is None
