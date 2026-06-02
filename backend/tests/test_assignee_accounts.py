import os
import uuid

import pytest

# Set test environment variables before importing app modules
os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.models.user import User
from app.auth.security import verify_password
from app.services.assignee_accounts import sync_assignee_accounts, ASSIGNEE_ACCOUNT_ROLE


@pytest.fixture
def db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def _unique_emp() -> str:
    # 테스트 격리 — 실제 DB 를 공유하므로 충돌 없는 사번 사용.
    return f"TEST-{uuid.uuid4().hex[:8]}"


def test_creates_operator_account_with_employee_id_password(db):
    emp = _unique_emp()
    try:
        result = sync_assignee_accounts(db, [{"name": "홍길동", "employeeId": emp}])
        assert emp in result["created"]

        user = db.query(User).filter(User.username == emp).first()
        assert user is not None
        # 권한은 operator
        assert user.role == ASSIGNEE_ACCOUNT_ROLE == "operator"
        # display_name 은 담당자 이름
        assert user.display_name == "홍길동"
        # 초기 비밀번호 = 사번
        assert verify_password(emp, user.hashed_password)
    finally:
        db.query(User).filter(User.username == emp).delete()
        db.commit()


def test_idempotent_skips_existing(db):
    emp = _unique_emp()
    try:
        sync_assignee_accounts(db, [{"name": "이순신", "employeeId": emp}])
        # 두 번째 호출은 기존 계정을 건드리지 않고 skip.
        result = sync_assignee_accounts(db, [{"name": "이순신", "employeeId": emp}])
        assert emp in result["skipped_existing"]
        assert emp not in result["created"]
        assert db.query(User).filter(User.username == emp).count() == 1
    finally:
        db.query(User).filter(User.username == emp).delete()
        db.commit()


def test_skips_assignee_without_employee_id(db):
    result = sync_assignee_accounts(db, [{"name": "사번없음"}])
    assert "사번없음" in result["skipped_no_employee_id"]
    assert result["created"] == []


def test_accepts_legacy_employee_id_key(db):
    emp = _unique_emp()
    try:
        # 레거시 snake_case 키도 허용해야 한다.
        result = sync_assignee_accounts(db, [{"name": "강감찬", "employee_id": emp}])
        assert emp in result["created"]
        assert db.query(User).filter(User.username == emp).count() == 1
    finally:
        db.query(User).filter(User.username == emp).delete()
        db.commit()
