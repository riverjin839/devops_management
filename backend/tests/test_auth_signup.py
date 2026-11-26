"""로그인 화면 가입 신청 + 관리자 승인 — ``/auth/signup*`` 와 ``/auth/login`` 안내까지 실제 Postgres 로 태운다.

IP 레이트리밋은 Redis 대신 메모리 카운터로 바꿔 테스트끼리 새지 않게 한다.
"""
import os
import uuid
from datetime import datetime, timedelta

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.security import create_access_token, hash_password, verify_password  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.signup_request import SignupRequest  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.user_notification import UserNotification  # noqa: E402
from app.services import backup_service, login_rate_limiter  # noqa: E402
from app.services import signup_service as signup  # noqa: E402

PW = "Signup-pass-2026"


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


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    counters: dict[str, int] = {}

    def fake_incr(key, max_count, window):  # noqa: ARG001
        counters[key] = counters.get(key, 0) + 1
        return counters[key] <= max_count, counters[key]

    monkeypatch.setattr(login_rate_limiter, "incr_window", fake_incr)
    # 로그인 레이트리밋은 이 테스트의 관심사가 아니다 — Redis 를 보지 않게 끈다.
    monkeypatch.setattr(login_rate_limiter, "check_login_allowed", lambda ip, u: (True, None))
    monkeypatch.setattr(login_rate_limiter, "record_failure", lambda ip, u: None)
    monkeypatch.setattr(login_rate_limiter, "record_success", lambda ip, u: None)
    session = SessionLocal()
    snapshot = session.query(AppSetting).filter(AppSetting.key == signup.SETTING_KEY).first()
    saved = dict(snapshot.value) if snapshot else None
    session.query(SignupRequest).delete()
    session.commit()
    yield counters
    session.query(SignupRequest).delete()
    session.query(User).filter(User.username.like("su-%")).delete(synchronize_session=False)
    session.query(UserNotification).filter(UserNotification.type.in_(("signup_request", "signup_approved"))).delete(
        synchronize_session=False)
    row = session.query(AppSetting).filter(AppSetting.key == signup.SETTING_KEY).first()
    if saved is None:
        if row is not None:
            session.delete(row)
    else:
        row.value = saved
    session.commit()
    session.close()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def admin(db):
    u = User(username=f"su-admin-{uuid.uuid4().hex[:8]}", hashed_password=hash_password(PW), role="admin",
             display_name="관리자", is_active=True)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _h(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(subject=user.username, role=user.role)}"}


def _enable(db, **extra):
    signup.save_config(db, {"enabled": True, **extra})


def _form(**over):
    base = {
        "username": f"su-{uuid.uuid4().hex[:8]}",
        "password": PW,
        "display_name": "홍길동",
        "email": "hong@corp.example",
        "department": "플랫폼팀",
        "reason": "클러스터 조회 권한이 필요합니다.",
    }
    base.update(over)
    return base


# ── 공개 설정·창구 ────────────────────────────────────────────────────────


def test_disabled_by_default(client, db):
    db.query(AppSetting).filter(AppSetting.key == signup.SETTING_KEY).delete()
    db.commit()
    assert client.get("/api/v1/auth/signup/config").json()["enabled"] is False
    r = client.post("/api/v1/auth/signup", json=_form())
    assert r.status_code == 403
    assert db.query(SignupRequest).count() == 0


def test_public_config_hides_operational_values(client, db):
    _enable(db, allowed_email_domains=["corp.example"], notice="소속을 적어 주세요")
    body = client.get("/api/v1/auth/signup/config").json()
    assert body == {"enabled": True, "min_password_length": 10,
                    "allowed_email_domains": ["corp.example"], "notice": "소속을 적어 주세요"}


def test_submit_stores_hash_only_and_notifies_admin(client, db, admin):
    _enable(db)
    form = _form()
    r = client.post("/api/v1/auth/signup", json=form)
    assert r.status_code == 202, r.text
    req = db.query(SignupRequest).filter(SignupRequest.username == form["username"]).one()
    assert req.status == "pending"
    assert req.password_hash and req.password_hash != PW and verify_password(PW, req.password_hash)
    # 계정은 아직 없다.
    assert db.query(User).filter(User.username == form["username"]).first() is None
    assert db.query(UserNotification).filter(UserNotification.recipient_user_id == admin.id,
                                             UserNotification.type == "signup_request").count() == 1
    assert db.query(AuditLog).filter(AuditLog.action == "signup.submit", AuditLog.status == "success",
                                     AuditLog.target_id == req.id).count() == 1


@pytest.mark.parametrize("over,code", [
    ({"username": "ab"}, 400),
    ({"username": "-bad"}, 400),
    ({"username": "Admin"}, 400),
    ({"email": "not-an-email"}, 400),
    ({"password": "short1a"}, 400),
    ({"password": "onlyletterslong"}, 400),
    ({"password": "with space 12345"}, 400),
    ({"display_name": "   "}, 400),
])
def test_validation(client, db, over, code):
    _enable(db)
    r = client.post("/api/v1/auth/signup", json=_form(**over))
    assert r.status_code in (code, 422), r.text
    assert db.query(SignupRequest).count() == 0


def test_password_must_not_contain_username(client, db):
    _enable(db)
    r = client.post("/api/v1/auth/signup", json=_form(username="su-kimcs", password="su-kimcs-2026x"))
    assert r.status_code == 400
    assert "아이디" in r.json()["detail"]


def test_email_domain_restriction(client, db):
    _enable(db, allowed_email_domains=["corp.example"])
    assert client.post("/api/v1/auth/signup", json=_form(email="x@gmail.com")).status_code == 400
    assert client.post("/api/v1/auth/signup", json=_form(email="x@dev.corp.example")).status_code == 202


def test_duplicate_username_with_user_and_pending(client, db, admin):
    _enable(db)
    assert client.post("/api/v1/auth/signup", json=_form(username=admin.username.upper())).status_code == 409
    form = _form()
    assert client.post("/api/v1/auth/signup", json=form).status_code == 202
    again = _form(username=form["username"].upper())
    assert client.post("/api/v1/auth/signup", json=again).status_code == 409


def test_rate_limit_per_ip(client, db, _isolate):
    _enable(db)
    for _ in range(signup.IP_MAX_SUBMITS):
        assert client.post("/api/v1/auth/signup", json=_form()).status_code == 202
    assert client.post("/api/v1/auth/signup", json=_form()).status_code == 429


def test_honeypot_accepted_but_dropped(client, db):
    _enable(db)
    r = client.post("/api/v1/auth/signup", json=_form(website="http://spam"))
    assert r.status_code == 202
    assert db.query(SignupRequest).count() == 0


def test_queue_cap(client, db):
    _enable(db, max_pending=1)
    assert client.post("/api/v1/auth/signup", json=_form()).status_code == 202
    assert client.post("/api/v1/auth/signup", json=_form()).status_code == 503


# ── 승인·거절 ────────────────────────────────────────────────────────────


def _submit(client, db, **over) -> SignupRequest:
    form = _form(**over)
    assert client.post("/api/v1/auth/signup", json=form).status_code == 202
    return db.query(SignupRequest).filter(SignupRequest.username == form["username"]).one()


def test_admin_only(client, db, admin):
    _enable(db)
    viewer = User(username=f"su-v-{uuid.uuid4().hex[:6]}", hashed_password=hash_password(PW), role="viewer",
                  is_active=True)
    db.add(viewer)
    db.commit()
    assert client.get("/api/v1/auth/signup/requests").status_code == 401
    assert client.get("/api/v1/auth/signup/requests", headers=_h(viewer)).status_code == 403
    assert client.put("/api/v1/auth/signup/settings", json={"enabled": False}, headers=_h(viewer)).status_code == 403
    assert client.get("/api/v1/auth/signup/requests", headers=_h(admin)).status_code == 200


def test_pending_login_hint_then_approve_then_login(client, db, admin):
    _enable(db)
    req = _submit(client, db)
    # 승인 전: 비밀번호가 맞으면 승인 대기 안내(403), 틀리면 일반 실패(401) — 신청 여부를 흘리지 않는다.
    r = client.post("/api/v1/auth/login", json={"username": req.username, "password": PW})
    assert r.status_code == 403 and "승인" in r.json()["detail"]
    r = client.post("/api/v1/auth/login", json={"username": req.username, "password": "Wrong-pass-2026"})
    assert r.status_code == 401

    listed = client.get("/api/v1/auth/signup/requests", headers=_h(admin)).json()
    assert listed["counts"]["pending"] == 1
    assert listed["items"][0]["expires_at"]

    r = client.post(f"/api/v1/auth/signup/requests/{req.id}/approve", json={"role": "operator"}, headers=_h(admin))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved" and r.json()["granted_role"] == "operator"
    db.expire_all()
    user = db.query(User).filter(User.username == req.username).one()
    assert user.role == "operator" and user.email == "hong@corp.example" and user.employee_id == req.username
    assert db.query(SignupRequest).filter(SignupRequest.id == req.id).one().password_hash is None
    # 승인 알림은 새 계정 id 로 묶인다(알림 조회는 recipient_user_id 기준).
    assert db.query(UserNotification).filter(UserNotification.recipient_user_id == user.id,
                                             UserNotification.type == "signup_approved").count() == 1

    r = client.post("/api/v1/auth/login", json={"username": req.username, "password": PW})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "operator"
    # 두 번 승인되지 않는다.
    again = client.post(f"/api/v1/auth/signup/requests/{req.id}/approve", json={"role": "viewer"}, headers=_h(admin))
    assert again.status_code == 409


def test_approve_cannot_grant_admin(client, db, admin):
    _enable(db)
    req = _submit(client, db)
    r = client.post(f"/api/v1/auth/signup/requests/{req.id}/approve", json={"role": "admin"}, headers=_h(admin))
    assert r.status_code == 422
    db.expire_all()
    assert db.query(User).filter(User.username == req.username).first() is None


def test_reject_shows_reason_on_login_and_allows_reapply(client, db, admin):
    _enable(db)
    req = _submit(client, db)
    r = client.post(f"/api/v1/auth/signup/requests/{req.id}/reject", json={"note": "소속 확인 불가"},
                    headers=_h(admin))
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    r = client.post("/api/v1/auth/login", json={"username": req.username, "password": PW})
    assert r.status_code == 403 and "소속 확인 불가" in r.json()["detail"]
    # 거절 뒤에는 같은 아이디로 다시 신청할 수 있다.
    assert client.post("/api/v1/auth/signup", json=_form(username=req.username)).status_code == 202


def test_approve_conflicts_when_user_created_meanwhile(client, db, admin):
    _enable(db)
    req = _submit(client, db)
    db.add(User(username=req.username, hashed_password=hash_password("x"), role="viewer", is_active=True))
    db.commit()
    r = client.post(f"/api/v1/auth/signup/requests/{req.id}/approve", json={"role": "viewer"}, headers=_h(admin))
    assert r.status_code == 409
    db.expire_all()
    assert db.query(SignupRequest).filter(SignupRequest.id == req.id).one().status == "pending"


def test_sweep_expires_and_purges(client, db, admin):
    _enable(db, pending_expire_days=3, retention_days=5)
    req = _submit(client, db)
    old = SignupRequest(username="su-old", display_name="옛", email="o@corp.example", status="rejected",
                        decided_at=datetime.utcnow() - timedelta(days=10))
    db.add(old)
    db.query(SignupRequest).filter(SignupRequest.id == req.id).update(
        {SignupRequest.created_at: datetime.utcnow() - timedelta(days=4)})
    db.commit()
    body = client.get("/api/v1/auth/signup/requests?status=all", headers=_h(admin)).json()
    statuses = {i["username"]: i["status"] for i in body["items"]}
    assert statuses == {req.username: "expired"}
    r = client.post("/api/v1/auth/login", json={"username": req.username, "password": PW})
    assert r.status_code == 403 and "만료" in r.json()["detail"]


def test_settings_validation_and_audit(client, db, admin):
    r = client.put("/api/v1/auth/signup/settings", json={"min_password_length": 4}, headers=_h(admin))
    assert r.status_code == 400
    r = client.put("/api/v1/auth/signup/settings", json={"allowed_email_domains": ["bad domain"]}, headers=_h(admin))
    assert r.status_code == 400
    r = client.put("/api/v1/auth/signup/settings",
                   json={"enabled": True, "allowed_email_domains": ["@Corp.Example"]}, headers=_h(admin))
    assert r.status_code == 200
    assert r.json()["allowed_email_domains"] == ["corp.example"]
    assert db.query(AuditLog).filter(AuditLog.action == "settings.signup.update").count() >= 1


def test_backup_masks_signup_password_hash():
    assert backup_service.SENSITIVE_COLUMNS["signup_requests"] == ["password_hash"]
