"""PUT /ui-settings/assignees 계정 해제 가드 회귀 테스트 (D-156).

화면(AssigneeManager)은 한 행만 고쳐도 전체 명부를 보낸다. 사번이 원래 없던 로그인 계정
(부트스트랩 admin·"관리자 계정 추가"로 만든 계정)은 GET 응답에 `employeeId: null` 로 실려
그대로 되돌아오므로, 그 null 을 "사번 비움 = 계정 해제"로 읽으면 다음 로그인부터 막힌다.
해제는 "기존 사번이 있었는데 이번 요청에서 비운 행"에만 적용돼야 한다.
"""
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension
from app.models.audit_log import AuditLog
from app.models.user import User
from app.auth.security import hash_password, verify_password

URL = "/api/v1/ui-settings/assignees"


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def _tag() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture
def created(db):
    """테스트가 만든 User id 를 모아 끝에 지운다(공유 DB 격리)."""
    ids: list[str] = []
    yield ids
    db.rollback()
    if ids:
        db.query(AuditLog).filter(AuditLog.target_id.in_(ids)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
        db.commit()


def _add(db, created, **kw) -> User:
    u = User(**kw)
    db.add(u)
    db.commit()
    db.refresh(u)
    created.append(u.id)
    return u


@pytest.fixture
def requester(db, created):
    """요청자 — 사번 없는 로그인 admin(부트스트랩 admin 과 같은 모양)."""
    return _add(db, created, username=f"admin-{_tag()}", hashed_password=hash_password("pw-admin"),
                role="admin", display_name=f"요청자-{_tag()}")


@pytest.fixture
def client(requester):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: requester
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _roster(client, ids: list[str]) -> list[dict]:
    """GET 응답(화면이 들고 있는 명부)에서 이 테스트의 행만 추린다 — 순서는 ids 순."""
    r = client.get(URL)
    assert r.status_code == 200
    by_id = {a["id"]: a for a in r.json()["data"]}
    return [dict(by_id[i]) for i in ids]


def test_saving_list_with_login_admin_without_employee_id_keeps_login(client, db, created, requester):
    """사번 없는 admin(요청자 아님) 행이 포함된 목록을 저장해도 로그인이 유지된다."""
    other_admin = _add(db, created, username=f"boot-{_tag()}", hashed_password=hash_password("pw-boot"),
                       role="admin", display_name=f"부트스트랩-{_tag()}")
    roster_only = _add(db, created, display_name=f"명부-{_tag()}")

    rows = _roster(client, [requester.id, other_admin.id, roster_only.id])
    assert rows[1]["employeeId"] is None and rows[1]["hasLogin"] is True
    rows[2]["email"] = "edited@example.com"  # 다른 행 하나만 고친다

    r = client.put(URL, json={"assignees": rows})
    assert r.status_code == 200, r.text
    assert r.json()["accounts"]["revoked"] == []

    db.expire_all()
    for u, pw in ((other_admin, "pw-boot"), (requester, "pw-admin")):
        fresh = db.query(User).filter(User.id == u.id).one()
        assert fresh.username == u.username
        assert fresh.hashed_password and verify_password(pw, fresh.hashed_password)
    assert db.query(User).filter(User.id == roster_only.id).one().email == "edited@example.com"
    assert db.query(AuditLog).filter(
        AuditLog.action == "user.login.revoke", AuditLog.target_id.in_([other_admin.id, requester.id]),
    ).count() == 0


def test_requester_own_account_is_not_revoked(client, db, created, requester):
    """요청자 본인 계정은 해제되지 않는다 — 사번이 없으면 무변경, 사번을 비우면 400."""
    # (1) 사번 없는 본인 행이 목록에 그대로 실려도 로그인 유지
    rows = _roster(client, [requester.id])
    r = client.put(URL, json={"assignees": rows})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(User).filter(User.id == requester.id).one().username == requester.username

    # (2) 본인에게 사번이 있는 상태에서 비우면 400 이고 아무것도 바뀌지 않는다
    emp = f"E-{_tag()}"
    me = db.query(User).filter(User.id == requester.id).one()
    me.employee_id = emp
    me.username = emp
    db.commit()
    requester.username = emp  # 의존성 오버라이드가 돌려주는 객체도 같은 상태로
    requester.employee_id = emp

    rows = _roster(client, [requester.id])
    rows[0]["employeeId"] = None
    r = client.put(URL, json={"assignees": rows})
    assert r.status_code == 400
    assert "본인" in r.text
    db.expire_all()
    fresh = db.query(User).filter(User.id == requester.id).one()
    assert fresh.username == emp and fresh.employee_id == emp and fresh.hashed_password


def test_only_row_whose_employee_id_was_cleared_is_revoked(client, db, created, requester):
    """사번을 비운 행만 해제되고, 해제는 감사 로그에 남는다."""
    emp_a, emp_b = f"E-{_tag()}", f"E-{_tag()}"
    a = _add(db, created, username=emp_a, employee_id=emp_a, hashed_password=hash_password(emp_a),
             role="operator", display_name=f"A-{_tag()}")
    b = _add(db, created, username=emp_b, employee_id=emp_b, hashed_password=hash_password(emp_b),
             role="operator", display_name=f"B-{_tag()}")
    boot = _add(db, created, username=f"boot-{_tag()}", hashed_password=hash_password("pw"),
                role="admin", display_name=f"부트-{_tag()}")

    rows = _roster(client, [requester.id, a.id, b.id, boot.id])
    rows[1]["employeeId"] = ""  # A 만 사번 비움
    r = client.put(URL, json={"assignees": rows})
    assert r.status_code == 200, r.text
    assert r.json()["accounts"]["revoked"] == [emp_a]

    db.expire_all()
    fa = db.query(User).filter(User.id == a.id).one()
    assert fa.username is None and fa.hashed_password is None and fa.employee_id is None
    fb = db.query(User).filter(User.id == b.id).one()
    assert fb.username == emp_b and verify_password(emp_b, fb.hashed_password)
    fboot = db.query(User).filter(User.id == boot.id).one()
    assert fboot.username == boot.username and fboot.hashed_password

    logs = db.query(AuditLog).filter(AuditLog.action == "user.login.revoke", AuditLog.target_id == a.id).all()
    assert len(logs) == 1
    assert logs[0].details["employee_id"] == emp_a
    assert logs[0].actor_user_id == requester.id


def test_new_employee_id_provisions_account(client, db, created, requester):
    """새 사번은 계정을 발급한다 — 새 행과 로그인 없던 기존 행 모두(초기 비번=사번).

    새 행의 역할은 operator, 로그인 없던 기존 행은 그 행의 역할 값을 유지한다(기존 동작).
    """
    roster_only = _add(db, created, display_name=f"명부-{_tag()}")
    emp_existing, emp_new = f"E-{_tag()}", f"E-{_tag()}"
    new_name = f"신규-{_tag()}"

    rows = _roster(client, [requester.id, roster_only.id])
    rows[1]["employeeId"] = emp_existing
    rows.append({"name": new_name, "employeeId": emp_new})
    r = client.put(URL, json={"assignees": rows})
    assert r.status_code == 200, r.text
    assert sorted(r.json()["accounts"]["created"]) == sorted([emp_existing, emp_new])

    db.expire_all()
    fresh = db.query(User).filter(User.id == roster_only.id).one()
    assert fresh.username == emp_existing and fresh.role == roster_only.role
    assert verify_password(emp_existing, fresh.hashed_password)
    new_user = db.query(User).filter(User.employee_id == emp_new).one()
    created.append(new_user.id)
    assert new_user.username == emp_new and new_user.role == "operator"
    assert verify_password(emp_new, new_user.hashed_password)
    assert db.query(AuditLog).filter(
        AuditLog.action == "user.create", AuditLog.target_id.in_([roster_only.id, new_user.id]),
    ).count() == 2


def test_missing_employee_id_key_leaves_account_untouched(client, db, created, requester):
    """employeeId 키가 없는 항목은 사번·계정을 바꾸지 않는다(명시적으로 비운 것이 아님)."""
    emp = f"E-{_tag()}"
    u = _add(db, created, username=emp, employee_id=emp, hashed_password=hash_password(emp),
             role="operator", display_name=f"키없음-{_tag()}")
    r = client.put(URL, json={"assignees": [{"id": u.id, "name": u.display_name, "email": "x@example.com"}]})
    assert r.status_code == 200, r.text
    db.expire_all()
    fresh = db.query(User).filter(User.id == u.id).one()
    assert fresh.username == emp and fresh.employee_id == emp and fresh.email == "x@example.com"


def test_adding_employee_id_to_named_admin_keeps_login_username(client, db, created, requester):
    """사번과 무관한 로그인 아이디(예: admin)에 사번을 붙여도 로그인 아이디는 그대로다."""
    boot = _add(db, created, username=f"boot-{_tag()}", hashed_password=hash_password("pw"),
                role="admin", display_name=f"부트-{_tag()}")
    emp = f"E-{_tag()}"
    rows = _roster(client, [requester.id, boot.id])
    rows[1]["employeeId"] = emp
    r = client.put(URL, json={"assignees": rows})
    assert r.status_code == 200, r.text
    db.expire_all()
    fresh = db.query(User).filter(User.id == boot.id).one()
    assert fresh.username == boot.username and fresh.employee_id == emp
    assert verify_password("pw", fresh.hashed_password)
