"""R-7 세션 연장 — POST /auth/refresh(슬라이딩 재발급 + 절대 상한) · 비밀번호 변경 시 토큰 무효화.

실제 Postgres + TestClient 로 로그인부터 태운다. 시간 경계(상한 초과·만료·레거시)는 같은
SECRET_KEY 로 직접 서명한 토큰으로 만든다 — 시계를 건드리지 않아 다른 테스트에 새지 않는다.
"""
import os
import time
import uuid

import jwt
import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth import security  # noqa: E402
from app.auth.security import create_access_token, hash_password  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.user import User  # noqa: E402

PASSWORD = "pw-initial-1234"


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()  # 구버전 테스트 DB 에 users.password_changed_at 보강
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _make_user(db, *, role: str = "operator") -> User:
    user = User(
        username=f"r7-{uuid.uuid4().hex[:10]}",
        hashed_password=hash_password(PASSWORD),
        role=role,
        display_name="R7 Tester",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def user(db):
    u = _make_user(db)
    yield u
    db.query(User).filter(User.id == u.id).delete()
    db.commit()


@pytest.fixture
def client():
    return TestClient(app)


def _login(client, username: str, password: str = PASSWORD) -> str:
    r = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _claims(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])


def _sign(payload: dict) -> str:
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_login_token_carries_session_claims(client, user):
    before = int(time.time())
    claims = _claims(_login(client, user.username))
    assert claims["sub"] == user.username
    assert isinstance(claims["jti"], str) and claims["jti"]
    assert before <= claims["iat"] <= int(time.time())
    assert claims["auth_time"] == claims["iat"]
    assert claims["exp"] - claims["iat"] == security.token_ttl_seconds()


def test_refresh_extends_exp_and_keeps_auth_time(client, user):
    now = int(time.time())
    # 로그인한 지 1시간, 토큰 만료 5분 전 상태를 재현한다.
    old = _sign({
        "sub": user.username, "role": user.role,
        "iat": now - 3600, "auth_time": now - 3600, "jti": "x", "exp": now + 300,
    })
    r = client.post("/api/v1/auth/refresh", headers=_auth(old))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["username"] == user.username
    new = _claims(body["access_token"])
    assert new["auth_time"] == now - 3600
    assert new["exp"] > now + 300
    assert new["jti"] != "x"
    # 새 토큰으로 API 가 그대로 통한다.
    assert client.get("/api/v1/auth/me", headers=_auth(body["access_token"])).status_code == 200


def test_refresh_after_real_login(client, user):
    token = _login(client, user.username)
    first = _claims(token)
    r = client.post("/api/v1/auth/refresh", headers=_auth(token))
    assert r.status_code == 200, r.text
    second = _claims(r.json()["access_token"])
    assert second["auth_time"] == first["auth_time"]
    assert second["exp"] >= first["exp"]
    assert second["jti"] != first["jti"]


def test_refresh_is_capped_by_session_max(client, user):
    now = int(time.time())
    max_s = security.session_max_seconds()
    auth_time = now - max_s + 600  # 상한까지 10분 남음
    old = _sign({"sub": user.username, "role": user.role, "iat": now - 60,
                 "auth_time": auth_time, "exp": now + 120})
    r = client.post("/api/v1/auth/refresh", headers=_auth(old))
    assert r.status_code == 200, r.text
    new = _claims(r.json()["access_token"])
    assert new["exp"] == auth_time + max_s  # now + TTL 이 아니라 상한에서 잘린다
    assert new["auth_time"] == auth_time


def test_refresh_rejected_past_session_max(client, user):
    now = int(time.time())
    old = _sign({"sub": user.username, "role": user.role, "iat": now - 60,
                 "auth_time": now - security.session_max_seconds() - 1, "exp": now + 600})
    r = client.post("/api/v1/auth/refresh", headers=_auth(old))
    assert r.status_code == 401


def test_refresh_rejects_expired_token(client, user):
    now = int(time.time())
    old = _sign({"sub": user.username, "role": user.role, "iat": now - 7200,
                 "auth_time": now - 7200, "exp": now - 10})
    assert client.post("/api/v1/auth/refresh", headers=_auth(old)).status_code == 401


def test_refresh_requires_token(client):
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_refresh_rejects_inactive_user(client, user, db):
    token = _login(client, user.username)
    db_user = db.query(User).filter(User.id == user.id).first()
    db_user.is_active = False
    db.commit()
    assert client.post("/api/v1/auth/refresh", headers=_auth(token)).status_code == 401


def test_password_change_revokes_old_tokens_and_returns_new_one(client, user):
    old = _login(client, user.username)
    other_session = _login(client, user.username)
    time.sleep(1.1)  # 비교는 초 단위 — 같은 초 안의 발급/변경은 구분하지 않는다
    r = client.post(
        "/api/v1/auth/me/password",
        headers=_auth(old),
        json={"current_password": PASSWORD, "new_password": "pw-changed-5678"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["must_change_password"] is False
    reissued = body["access_token"]
    assert reissued

    # 변경 이전 로그인 토큰은 이 요청에 쓴 것이든 다른 세션 것이든 모두 401.
    assert client.get("/api/v1/auth/me", headers=_auth(old)).status_code == 401
    assert client.get("/api/v1/auth/me", headers=_auth(other_session)).status_code == 401
    assert client.post("/api/v1/auth/refresh", headers=_auth(other_session)).status_code == 401
    # 응답에 실린 토큰과 새 비밀번호로 다시 로그인한 토큰은 통과(시계 오차로 거부되지 않음).
    assert client.get("/api/v1/auth/me", headers=_auth(reissued)).status_code == 200
    fresh = _login(client, user.username, "pw-changed-5678")
    assert client.get("/api/v1/auth/me", headers=_auth(fresh)).status_code == 200
    assert client.post("/api/v1/auth/refresh", headers=_auth(fresh)).status_code == 200


def test_admin_reset_revokes_target_sessions(client, user, db):
    admin = _make_user(db, role="admin")
    try:
        victim_token = _login(client, user.username)
        admin_token = _login(client, admin.username)
        time.sleep(1.1)
        r = client.post(
            f"/api/v1/auth/users/{user.id}/password",
            headers=_auth(admin_token),
            json={"new_password": "pw-reset-9999"},
        )
        assert r.status_code == 200, r.text
        assert client.get("/api/v1/auth/me", headers=_auth(victim_token)).status_code == 401
        # 관리자 본인 세션은 영향 없음.
        assert client.get("/api/v1/auth/me", headers=_auth(admin_token)).status_code == 200
        assert _login(client, user.username, "pw-reset-9999")
    finally:
        db.query(User).filter(User.id == admin.id).delete()
        db.commit()


def test_legacy_token_auth_time_is_estimated(client, user):
    """auth_time·iat 가 없는 구버전 토큰 — exp - max(TTL, 상한) 으로 추정해 상한을 늘리지 않는다."""
    now = int(time.time())
    exp = now + 3600
    legacy = _sign({"sub": user.username, "role": user.role, "exp": exp})
    assert client.get("/api/v1/auth/me", headers=_auth(legacy)).status_code == 200
    r = client.post("/api/v1/auth/refresh", headers=_auth(legacy))
    assert r.status_code == 200, r.text
    new = _claims(r.json()["access_token"])
    est = exp - max(security.token_ttl_seconds(), security.session_max_seconds())
    assert est < now  # 기본 설정(TTL 2h · 상한 24h)에서 추정 로그인 시각은 과거
    assert new["auth_time"] == est
    # 추정 로그인 시각 + 상한 = 원래 만료 — 레거시 토큰은 재발급해도 원래 만료를 넘지 못한다.
    assert new["exp"] == min(est + security.session_max_seconds(), new["iat"] + security.token_ttl_seconds())
    assert new["exp"] <= exp


def test_legacy_token_rejected_once_password_changed(client, user, db):
    legacy = _sign({"sub": user.username, "role": user.role, "exp": int(time.time()) + 3600})
    db_user = db.query(User).filter(User.id == user.id).first()
    db_user.password_changed_at = security.utcnow_naive()
    db.commit()
    assert client.get("/api/v1/auth/me", headers=_auth(legacy)).status_code == 401


def test_ws_resolvers_reject_revoked_tokens(user, db):
    from app.routers.k8s_exec import _resolve_user
    from app.services.ssh_pty import resolve_ws_user

    now = int(time.time())
    before_change = create_access_token(user.username, role=user.role, auth_time=now - 120)
    db_user = db.query(User).filter(User.id == user.id).first()
    db_user.password_changed_at = security.utcnow_naive().replace(microsecond=0)
    db.commit()
    after_change = create_access_token(user.username, role=user.role)

    assert _resolve_user(before_change, db) is None
    assert resolve_ws_user(before_change, db) is None
    assert _resolve_user(after_change, db) is not None
    assert resolve_ws_user(after_change, db) is not None


def test_is_token_revoked_compares_whole_seconds():
    from datetime import datetime, timezone

    changed = datetime(2026, 1, 1, 0, 0, 0, 900_000)  # naive UTC, 소수 초는 버린다
    t = int(changed.replace(tzinfo=timezone.utc).timestamp())
    assert security.is_token_revoked({"auth_time": t}, changed) is False
    assert security.is_token_revoked({"auth_time": t - 1}, changed) is True
    assert security.is_token_revoked({"iat": t - 1}, changed) is True
    assert security.is_token_revoked({"exp": t + 999}, changed) is True
    assert security.is_token_revoked({"auth_time": t - 1}, None) is False
