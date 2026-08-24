"""GET/PUT /ui-settings/assignees — 담당자 명부 겸 로그인 계정 통합 API 회귀 테스트.

users 테이블이 명부 자체이므로(모델 docstring 참고) 이 라우터가 실제로 로그인 계정을
발급/해제하는지, admin/비-admin 응답 shape 이 다른지, upsert 가 중복 행을 만들지 않는지를
실제 DB 로 검증한다.
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
from app.models.user import User
from app.auth.security import verify_password


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def admin_user(db):
    user = User(username=f"admin-{uuid.uuid4().hex[:8]}", hashed_password="x", role="admin",
                display_name="Test Admin")
    db.add(user)
    db.commit()
    db.refresh(user)
    yield user
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


@pytest.fixture
def client(admin_user):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: admin_user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_requires_auth():
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    assert c.get("/api/v1/ui-settings/assignees").status_code == 401


def test_put_with_employee_id_provisions_login_account(client, db):
    emp = f"E-{uuid.uuid4().hex[:8]}"
    try:
        r = client.put("/api/v1/ui-settings/assignees", json={
            "assignees": [{"name": "홍길동", "employeeId": emp, "email": "hong@example.com"}],
        })
        assert r.status_code == 200
        body = r.json()
        assert emp in body["accounts"]["created"]
        row = next(a for a in body["data"] if a["employeeId"] == emp)
        assert row["hasLogin"] is True
        assert row["username"] == emp
        assert row["accountRole"] == "operator"

        user = db.query(User).filter(User.employee_id == emp).first()
        assert user is not None
        assert verify_password(emp, user.hashed_password)
    finally:
        db.query(User).filter(User.employee_id == emp).delete()
        db.commit()


def test_put_upsert_by_id_does_not_duplicate(client, db):
    emp = f"E-{uuid.uuid4().hex[:8]}"
    try:
        r1 = client.put("/api/v1/ui-settings/assignees", json={
            "assignees": [{"name": "이순신", "employeeId": emp}],
        })
        row = next(a for a in r1.json()["data"] if a["employeeId"] == emp)

        r2 = client.put("/api/v1/ui-settings/assignees", json={
            "assignees": [{**row, "seatLocation": "3층 A-1"}],
        })
        assert r2.status_code == 200
        matches = [a for a in r2.json()["data"] if a["employeeId"] == emp]
        assert len(matches) == 1
        assert matches[0]["seatLocation"] == "3층 A-1"
        assert db.query(User).filter(User.employee_id == emp).count() == 1
    finally:
        db.query(User).filter(User.employee_id == emp).delete()
        db.commit()


def test_removing_employee_id_revokes_login(client, db):
    emp = f"E-{uuid.uuid4().hex[:8]}"
    try:
        r1 = client.put("/api/v1/ui-settings/assignees", json={
            "assignees": [{"name": "강감찬", "employeeId": emp}],
        })
        row = next(a for a in r1.json()["data"] if a["employeeId"] == emp)
        assert row["hasLogin"] is True

        r2 = client.put("/api/v1/ui-settings/assignees", json={
            "assignees": [{**row, "employeeId": None}],
        })
        assert r2.status_code == 200
        updated = next(a for a in r2.json()["data"] if a["id"] == row["id"])
        assert updated["hasLogin"] is False
        assert updated["employeeId"] is None

        user = db.query(User).filter(User.id == row["id"]).first()
        assert user.username is None
        assert user.hashed_password is None
    finally:
        db.query(User).filter(User.id == row["id"]).delete()
        db.commit()


def test_duplicate_employee_id_rejected(client, db):
    emp = f"E-{uuid.uuid4().hex[:8]}"
    try:
        r = client.put("/api/v1/ui-settings/assignees", json={
            "assignees": [
                {"name": "A담당자", "employeeId": emp},
                {"name": "B담당자", "employeeId": emp},
            ],
        })
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "ASSIGNEE_DUPLICATE"
        assert db.query(User).filter(User.employee_id == emp).count() == 0
    finally:
        db.query(User).filter(User.employee_id == emp).delete()
        db.commit()


def test_non_admin_get_omits_account_fields(db):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    viewer = User(username=f"viewer-{uuid.uuid4().hex[:8]}", hashed_password="x", role="viewer")
    db.add(viewer); db.commit(); db.refresh(viewer)
    app.dependency_overrides[get_current_user] = lambda: viewer
    try:
        c = TestClient(app)
        r = c.get("/api/v1/ui-settings/assignees")
        assert r.status_code == 200
        assert all("id" not in a and "username" not in a for a in r.json()["data"])
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        db.query(User).filter(User.id == viewer.id).delete()
        db.commit()
