"""WBS 프로젝트 수정 — 빈 값 저장 회귀 테스트(D-162).

예전에는 화면이 비운 값을 `undefined`(키 생략)로 보내 `exclude_unset` 이 기존 값을 유지했다 —
설명·목표·기간을 지울 방법이 없었다. 이제 화면은 수정 모드에서 빈 값을 `null` 로 보내고,
서버는 선택 필드를 비우되 필수 필드(이름·색·상태)의 `null` 은 422 로 거절한다(DB NOT NULL 500 방지).
실제 DB 로 검증한다.
"""
import os
import uuid
from datetime import date

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.project import Project  # noqa: E402
from app.models.user import User  # noqa: E402


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def db(_schema):
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def user(db):
    u = User(username=f"proj-op-{uuid.uuid4().hex[:8]}", hashed_password="x", role="operator")
    db.add(u)
    db.commit()
    yield u
    db.query(User).filter(User.id == u.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def project(db):
    p = Project(
        name=f"wbs-{uuid.uuid4().hex[:8]}", description="설명", goal="목표",
        start_date=date(2026, 10, 1), end_date=date(2026, 10, 31),
    )
    db.add(p)
    db.commit()
    yield p
    db.query(Project).filter(Project.id == p.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client(user):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_update_with_null_clears_optional_fields(client, db, project):
    res = client.put(f"/api/v1/projects/{project.id}", json={
        "name": project.name, "description": None, "goal": None,
        "start_date": None, "end_date": None,
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["description"] is None and body["goal"] is None
    assert body["start_date"] is None and body["end_date"] is None

    db.expire_all()
    row = db.query(Project).filter(Project.id == project.id).one()
    assert row.description is None and row.goal is None
    assert row.start_date is None and row.end_date is None


def test_update_omitting_keys_keeps_values(client, db, project):
    res = client.put(f"/api/v1/projects/{project.id}", json={"color": "rose"})
    assert res.status_code == 200, res.text
    db.expire_all()
    row = db.query(Project).filter(Project.id == project.id).one()
    assert row.color == "rose"
    assert row.description == "설명" and row.end_date == date(2026, 10, 31)


@pytest.mark.parametrize("field", ["name", "color", "status"])
def test_update_null_on_required_field_is_422(client, db, project, field):
    res = client.put(f"/api/v1/projects/{project.id}", json={field: None})
    assert res.status_code == 422, res.text
    db.expire_all()
    row = db.query(Project).filter(Project.id == project.id).one()
    assert getattr(row, field) is not None
