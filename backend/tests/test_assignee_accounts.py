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
from app.main import _ensure_pgvector_extension
from app.models.user import User
from app.auth.security import verify_password
from app.services.assignee_accounts import migrate_legacy_roster_into_users, ASSIGNEE_ACCOUNT_ROLE


@pytest.fixture
def db():
    # work_items/work_guides.embedding 은 pgvector 확장이 필요 — 이 파일이 다른 테스트
    # 파일보다 먼저(알파벳순) 실행되며 최초로 create_all() 을 부르는 경우, 확장이 아직
    # 없으면 두 테이블 생성 자체가 실패한다. main.py 의 lifespan 과 동일한 순서로 보장.
    _ensure_pgvector_extension()
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
        result = migrate_legacy_roster_into_users(db, [{"name": "홍길동", "employeeId": emp}])
        assert "홍길동" in result["migrated"]

        user = db.query(User).filter(User.username == emp).first()
        assert user is not None
        # 권한은 operator
        assert user.role == ASSIGNEE_ACCOUNT_ROLE == "operator"
        # display_name 은 담당자 이름
        assert user.display_name == "홍길동"
        # 사번이 employee_id 컬럼에도 그대로 들어간다 — 명부와 로그인 계정이 한 행.
        assert user.employee_id == emp
        # 초기 비밀번호 = 사번
        assert verify_password(emp, user.hashed_password)
    finally:
        db.query(User).filter(User.username == emp).delete()
        db.commit()


def test_idempotent_updates_existing_row_instead_of_duplicating(db):
    emp = _unique_emp()
    try:
        migrate_legacy_roster_into_users(db, [{"name": "이순신", "employeeId": emp}])
        # 두 번째 호출은 새 행을 만들지 않고 기존 행을 갱신한다(명부 필드가 바뀌었어도 반영).
        result = migrate_legacy_roster_into_users(
            db, [{"name": "이순신", "employeeId": emp, "email": "lee@example.com"}],
        )
        assert "이순신" in result["migrated"]
        assert db.query(User).filter(User.username == emp).count() == 1
        user = db.query(User).filter(User.username == emp).first()
        assert user.email == "lee@example.com"
    finally:
        db.query(User).filter(User.username == emp).delete()
        db.commit()


def test_entry_without_employee_id_becomes_login_less_roster_row(db):
    name = f"사번없음-{uuid.uuid4().hex[:8]}"
    try:
        result = migrate_legacy_roster_into_users(db, [{"name": name}])
        assert name in result["migrated"]

        user = db.query(User).filter(User.display_name == name, User.employee_id.is_(None)).first()
        assert user is not None
        assert user.username is None
        assert user.hashed_password is None
    finally:
        db.query(User).filter(User.display_name == name).delete()
        db.commit()


def test_accepts_legacy_employee_id_key(db):
    emp = _unique_emp()
    try:
        # 레거시 snake_case 키도 허용해야 한다.
        result = migrate_legacy_roster_into_users(db, [{"name": "강감찬", "employee_id": emp}])
        assert "강감찬" in result["migrated"]
        assert db.query(User).filter(User.username == emp).count() == 1
    finally:
        db.query(User).filter(User.username == emp).delete()
        db.commit()


def test_matches_existing_account_by_employee_id_column_not_just_username(db):
    """이미 employee_id 컬럼이 채워진 행(예: PUT /ui-settings/assignees 로 만들어진 행)은
    username 이 달라도 employee_id 로 매칭돼 중복 생성되지 않아야 한다."""
    emp = _unique_emp()
    try:
        db.add(User(display_name="기존담당자", employee_id=emp, username=emp, role="operator"))
        db.commit()

        result = migrate_legacy_roster_into_users(db, [{"name": "기존담당자", "employeeId": emp}])
        assert "기존담당자" in result["migrated"]
        assert db.query(User).filter(User.employee_id == emp).count() == 1
    finally:
        db.query(User).filter(User.employee_id == emp).delete()
        db.commit()
