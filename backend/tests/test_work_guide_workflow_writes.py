"""D-158 / D-162 회귀 — 작업 가이드 삭제 가드와 가이드·워크플로의 "지운 값 저장".

- 하위 페이지가 있는 가이드를 지우면 409(사유: 하위 N개) — 부모만 지워 하위가 트리에서 사라지던 문제.
  하위가 없으면 그대로 204.
- 수정(PUT)에서 nullable 필드에 `null` 을 보내면 컬럼이 비워진다(`exclude_unset` 은 "미전송 = 유지",
  `null` = "비우기"). NOT NULL 필드에 `null` 이 오면 500 대신 422.
"""
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.work_guide import WorkGuide  # noqa: E402
from app.models.workflow import Workflow, WorkflowStep, WorkflowEdge  # noqa: E402


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def operator_user(db):
    user = User(username=f"operator-{uuid.uuid4().hex[:8]}", hashed_password="x", role="operator",
                display_name="Test operator")
    db.add(user)
    db.commit()
    db.refresh(user)
    yield user
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


@pytest.fixture
def client(operator_user):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: operator_user
    yield TestClient(app)
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture(autouse=True)
def _no_embedding_queue(monkeypatch):
    # 임베딩 재계산 큐잉은 best-effort 라 테스트에선 끈다(브로커 의존 제거).
    from app.routers import work_guide as wg_router
    monkeypatch.setattr(wg_router, "_queue_embedding_recompute", lambda _id: None)


def _cleanup_guides(db, ids):
    db.query(WorkGuide).filter(WorkGuide.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


# ── D-158: 하위가 있는 가이드 삭제 → 409 ──────────────────────────────────────

def test_delete_guide_with_children_returns_409(db, client):
    parent = client.post("/api/v1/work-guides", json={"title": f"p-{uuid.uuid4().hex[:6]}"})
    assert parent.status_code == 201, parent.text
    parent_id = parent.json()["id"]
    child = client.post("/api/v1/work-guides", json={"title": "child", "parent_id": parent_id})
    assert child.status_code == 201, child.text
    child_id = child.json()["id"]
    try:
        r = client.delete(f"/api/v1/work-guides/{parent_id}")
        assert r.status_code == 409, r.text
        assert "하위 페이지 1개" in r.json()["detail"]
        # 부모·하위 모두 그대로 남는다.
        assert client.get(f"/api/v1/work-guides/{parent_id}").status_code == 200
        assert client.get(f"/api/v1/work-guides/{child_id}").status_code == 200

        # 하위부터 지우면 부모도 지워진다.
        assert client.delete(f"/api/v1/work-guides/{child_id}").status_code == 204
        assert client.delete(f"/api/v1/work-guides/{parent_id}").status_code == 204
        assert client.get(f"/api/v1/work-guides/{parent_id}").status_code == 404
    finally:
        _cleanup_guides(db, [parent_id, child_id])


def test_delete_leaf_guide_returns_204(db, client):
    r = client.post("/api/v1/work-guides", json={"title": f"leaf-{uuid.uuid4().hex[:6]}"})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    try:
        assert client.delete(f"/api/v1/work-guides/{gid}").status_code == 204
    finally:
        _cleanup_guides(db, [gid])


# ── D-162: 가이드 수정에서 null = 비우기 ─────────────────────────────────────

def test_guide_put_null_clears_optional_fields(db, client):
    parent = client.post("/api/v1/work-guides", json={"title": f"p-{uuid.uuid4().hex[:6]}"})
    parent_id = parent.json()["id"]
    r = client.post("/api/v1/work-guides", json={
        "title": f"g-{uuid.uuid4().hex[:6]}", "content": "<p>본문</p>", "category": "배포",
        "tags": "a,b", "author": "홍길동", "confluence_url": "https://c.example/x",
        "parent_id": parent_id,
    })
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    try:
        r = client.put(f"/api/v1/work-guides/{gid}", json={
            "content": None, "category": None, "tags": None, "author": None,
            "confluence_url": None, "parent_id": None,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("content", "category", "tags", "author", "confluence_url", "parent_id"):
            assert body[k] is None, k
        assert body["title"].startswith("g-")  # 안 보낸 필드는 유지

        for k in ("title", "priority", "status", "sort_order"):
            r = client.put(f"/api/v1/work-guides/{gid}", json={k: None})
            assert r.status_code == 422, (k, r.text)
    finally:
        _cleanup_guides(db, [gid, parent_id])


# ── D-162: 워크플로·단계 수정에서 null = 비우기 ──────────────────────────────

def test_workflow_and_step_put_null_clears_optional_fields(db, client):
    r = client.post("/api/v1/workflows", json={
        "title": f"wf-{uuid.uuid4().hex[:6]}", "description": "설명",
        "confluence_url": "https://c.example/wf",
    })
    assert r.status_code == 201, r.text
    wf_id = r.json()["id"]
    try:
        r = client.put(f"/api/v1/workflows/{wf_id}", json={"description": None, "confluence_url": None})
        assert r.status_code == 200, r.text
        assert r.json()["description"] is None
        assert r.json()["confluence_url"] is None
        assert client.put(f"/api/v1/workflows/{wf_id}", json={"title": None}).status_code == 422

        r = client.post(f"/api/v1/workflows/{wf_id}/steps", json={
            "title": "단계 1", "description": "상세", "reference_type": "cluster",
            "reference_id": str(uuid.uuid4()),
        })
        assert r.status_code == 201, r.text
        step_id = r.json()["id"]

        r = client.put(f"/api/v1/workflows/{wf_id}/steps/{step_id}", json={
            "description": None, "reference_type": None, "reference_id": None,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("description", "reference_type", "reference_id"):
            assert body[k] is None, k
        assert body["title"] == "단계 1"

        for k in ("title", "completed", "step_type", "status", "pos_x", "pos_y", "order_index"):
            r = client.put(f"/api/v1/workflows/{wf_id}/steps/{step_id}", json={k: None})
            assert r.status_code == 422, (k, r.text)
    finally:
        db.query(WorkflowEdge).filter(WorkflowEdge.workflow_id == wf_id).delete(synchronize_session=False)
        db.query(WorkflowStep).filter(WorkflowStep.workflow_id == wf_id).delete(synchronize_session=False)
        db.query(Workflow).filter(Workflow.id == wf_id).delete(synchronize_session=False)
        db.commit()


def test_guide_parent_cycle_rejected(db, client):
    """자기 자신·자기 하위를 상위로 지정하면 422 — 순환은 트리에서 사라지고 삭제도 막힌다."""
    a = client.post("/api/v1/work-guides", json={"title": f"a-{uuid.uuid4().hex[:6]}"}).json()["id"]
    b = client.post("/api/v1/work-guides", json={"title": "b", "parent_id": a}).json()["id"]
    try:
        assert client.put(f"/api/v1/work-guides/{a}", json={"parent_id": a}).status_code == 422
        assert client.put(f"/api/v1/work-guides/{a}", json={"parent_id": b}).status_code == 422
        assert client.put(f"/api/v1/work-guides/{b}", json={"parent_id": None}).status_code == 200
        assert client.delete(f"/api/v1/work-guides/{b}").status_code == 204
        assert client.delete(f"/api/v1/work-guides/{a}").status_code == 204
    finally:
        _cleanup_guides(db, [a, b])
