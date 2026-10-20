"""D-144 / D-145 회귀 — 지식·스프린트 화면의 "지운 값 저장"과 스프린트 쓰기 권한.

- 수정(PUT)에서 nullable 필드에 `null` 을 보내면 컬럼이 비워진다(`exclude_unset` 은 "미전송 = 유지",
  `null` = "비우기"). 예전엔 폼이 빈 값을 아예 안 보내 지울 방법이 없었다.
- NOT NULL 필드에 `null` 이 오면 500(IntegrityError) 대신 422 로 거부한다.
- 스프린트 생성·수정·삭제·이월은 operator 이상(업무 항목 쓰기와 같은 기준) — viewer 는 403.
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

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.ops_note import OpsNote  # noqa: E402
from app.models.command_entry import CommandEntry  # noqa: E402
from app.models.sprint import Sprint  # noqa: E402


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def _make_user(db, role: str) -> User:
    user = User(username=f"{role}-{uuid.uuid4().hex[:8]}", hashed_password="x", role=role,
                display_name=f"Test {role}")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def operator_user(db):
    user = _make_user(db, "operator")
    yield user
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


@pytest.fixture
def viewer_user(db):
    user = _make_user(db, "viewer")
    yield user
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


def _client_as(user):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


@pytest.fixture
def cleanup_overrides():
    yield
    from app.main import app
    from app.auth.deps import get_current_user
    app.dependency_overrides.pop(get_current_user, None)


def test_ops_note_put_null_clears_optional_fields(db, operator_user, cleanup_overrides):
    client = _client_as(operator_user)
    r = client.post("/api/v1/ops-notes", json={
        "service": "k8s", "title": f"q-{uuid.uuid4().hex[:6]}", "content": "<p>답</p>",
        "back_content": "<p>히스토리</p>", "author": "홍길동",
        "confluence_url": "https://c.example/x", "dl_url": "https://dl.example/y",
    })
    assert r.status_code == 201, r.text
    note_id = r.json()["id"]
    try:
        r = client.put(f"/api/v1/ops-notes/{note_id}", json={
            "content": None, "back_content": None, "author": None,
            "confluence_url": None, "dl_url": None,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("content", "back_content", "author", "confluence_url", "dl_url"):
            assert body[k] is None, k
        assert body["title"].startswith("q-")  # 안 보낸 필드는 유지

        # 필수 필드는 null 로 비울 수 없다 — 500 이 아니라 422.
        r = client.put(f"/api/v1/ops-notes/{note_id}", json={"title": None})
        assert r.status_code == 422, r.text
    finally:
        db.query(OpsNote).filter(OpsNote.id == note_id).delete()
        db.commit()


def test_command_put_null_clears_optional_fields(db, operator_user, cleanup_overrides):
    client = _client_as(operator_user)
    r = client.post("/api/v1/commands", json={
        "command": "kubectl get pods -A", "category": "kubectl", "description": "의미",
        "caution": "주의", "examples": "예시", "tags": "a,b",
        "confluence_url": "https://c.example/x",
    })
    assert r.status_code == 201, r.text
    entry_id = r.json()["id"]
    try:
        r = client.put(f"/api/v1/commands/{entry_id}", json={
            "category": None, "description": None, "caution": None,
            "examples": None, "tags": None, "confluence_url": None,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("category", "description", "caution", "examples", "tags", "confluence_url"):
            assert body[k] is None, k
        assert body["command"] == "kubectl get pods -A"

        r = client.put(f"/api/v1/commands/{entry_id}", json={"command": None})
        assert r.status_code == 422, r.text
    finally:
        db.query(CommandEntry).filter(CommandEntry.id == entry_id).delete()
        db.commit()


def test_sprint_put_null_clears_optional_fields(db, operator_user, cleanup_overrides):
    client = _client_as(operator_user)
    r = client.post("/api/v1/sprints", json={
        "name": f"s-{uuid.uuid4().hex[:6]}", "goal": "목표", "jira_no": "PROJ-1",
        "confluence_link": "https://c.example/x",
        "start_date": "2026-10-01", "end_date": "2026-10-14",
    })
    assert r.status_code == 201, r.text
    sprint_id = r.json()["id"]
    try:
        r = client.put(f"/api/v1/sprints/{sprint_id}", json={
            "goal": None, "jira_no": None, "confluence_link": None,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("goal", "jira_no", "confluence_link"):
            assert body[k] is None, k

        r = client.put(f"/api/v1/sprints/{sprint_id}", json={"name": None})
        assert r.status_code == 422, r.text
    finally:
        db.query(Sprint).filter(Sprint.id == uuid.UUID(sprint_id)).delete()
        db.commit()


def test_sprint_writes_require_operator(db, viewer_user, cleanup_overrides):
    sprint = Sprint(name=f"s-{uuid.uuid4().hex[:6]}",
                    start_date=date(2026, 10, 1),
                    end_date=date(2026, 10, 14), status="active")
    other = Sprint(name=f"s-{uuid.uuid4().hex[:6]}",
                   start_date=date(2026, 10, 15),
                   end_date=date(2026, 10, 28), status="planning")
    db.add_all([sprint, other])
    db.commit()
    sid, oid = str(sprint.id), str(other.id)
    try:
        client = _client_as(viewer_user)
        # 조회는 viewer 도 된다.
        assert client.get("/api/v1/sprints").status_code == 200
        assert client.get(f"/api/v1/sprints/{sid}").status_code == 200
        # 쓰기는 전부 403.
        assert client.post("/api/v1/sprints", json={
            "name": "x", "start_date": "2026-10-01", "end_date": "2026-10-14",
        }).status_code == 403
        assert client.put(f"/api/v1/sprints/{sid}", json={"goal": "g"}).status_code == 403
        assert client.post(f"/api/v1/sprints/{sid}/carry-over", params={"to": oid}).status_code == 403
        assert client.delete(f"/api/v1/sprints/{sid}").status_code == 403
        assert db.query(Sprint).filter(Sprint.id == sprint.id).first() is not None
    finally:
        db.query(Sprint).filter(Sprint.id.in_([sprint.id, other.id])).delete(synchronize_session=False)
        db.commit()
