"""멀티테넌시 3단계 — 업무·지식 데이터 tenant_id 가시 범위 회귀 테스트.

규칙 (services/tenant_scope.py):
- tenant_id NULL = 전체 공유(기존 데이터), 값이 있으면 그 테넌트 멤버·admin 만 본다.
- 안 보이는 행은 단건 조회·수정·삭제 모두 404(존재 자체를 숨김).
- 속하지 않은 테넌트로 지정하면 403.
- 업무 항목은 소속 프로젝트의 테넌트도 따른다(비공개 프로젝트 = 프로젝트 멤버십).
실제 DB 로 검증한다.
"""
import os
import uuid
from datetime import datetime

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.audit_log import AuditLog
from app.models.mindmap import MindMap, MindMapNode
from app.models.ops_note import OpsNote
from app.models.project import Project
from app.models.tenant import Tenant, TenantMember
from app.models.user import User
from app.models.work_guide import WorkGuide
from app.models.work_item import WorkItem
from app.models.work_item_comment import WorkItemComment


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()  # 구버전 테스트 DB 에도 tenant_id 컬럼 보강


@pytest.fixture
def db(_schema):
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    users = {
        k: User(username=f"{k}-{tag}", hashed_password="x", role=role)
        for k, role in (("admin", "admin"), ("member", "operator"), ("outsider", "operator"))
    }
    tenant = Tenant(name=f"team-{tag}")
    db.add_all([tenant, *users.values()])
    db.commit()
    db.add(TenantMember(tenant_id=tenant.id, user_id=users["member"].id))

    private_project = Project(name=f"private-{tag}", tenant_id=tenant.id)
    db.add(private_project)
    db.commit()

    def _item(title, **kw):
        return WorkItem(type="task", assignee="t", primary_assignee="t", category="c",
                        content=title, title=title, started_at=datetime.utcnow(), **kw)

    rows = {
        "project": private_project,
        "note_private": OpsNote(id=str(uuid.uuid4()), service="k8s", title=f"n-private-{tag}", tenant_id=tenant.id),
        "note_shared": OpsNote(id=str(uuid.uuid4()), service="k8s", title=f"n-shared-{tag}"),
        "guide_private": WorkGuide(title=f"guide-private-{tag}", content="secret runbook", tenant_id=tenant.id),
        "guide_shared": WorkGuide(title=f"guide-shared-{tag}", content="public runbook"),
        "map_private": MindMap(title=f"map-private-{tag}", tenant_id=tenant.id),
        "item_private": _item(f"item-private-{tag}", tenant_id=tenant.id),
        # 항목 자체는 공유지만 비공개 프로젝트 소속 → 프로젝트 멤버만 보인다
        "item_in_private_project": _item(f"item-proj-{tag}", project_id=private_project.id),
        "item_shared": _item(f"item-shared-{tag}"),
    }
    db.add_all([v for k, v in rows.items() if k != "project"])
    db.commit()
    w = {"tag": tag, "tenant": tenant, **users, **rows}
    yield w

    db.rollback()
    item_ids = [rows[k].id for k in ("item_private", "item_in_private_project", "item_shared")]
    db.query(WorkItemComment).filter(WorkItemComment.work_item_id.in_(item_ids)).delete(synchronize_session=False)
    db.query(WorkItem).filter(WorkItem.title.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(MindMapNode).filter(MindMapNode.mindmap_id == rows["map_private"].id).delete(synchronize_session=False)
    db.query(MindMap).filter(MindMap.title.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(WorkGuide).filter(WorkGuide.title.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(OpsNote).filter(OpsNote.title.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(Project).filter(Project.name.like(f"%{tag}%")).delete(synchronize_session=False)
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client_as():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── 운영 노트 ────────────────────────────────────────────────────────────────

def test_ops_notes_list_and_detail(client_as, world):
    def titles(user):
        r = client_as(user).get("/api/v1/ops-notes")
        assert r.status_code == 200
        return {n["title"] for n in r.json()["data"]}

    tag = world["tag"]
    assert f"n-private-{tag}" not in titles(world["outsider"])
    assert f"n-shared-{tag}" in titles(world["outsider"])
    assert f"n-private-{tag}" in titles(world["member"])
    assert f"n-private-{tag}" in titles(world["admin"])
    nid = world["note_private"].id
    assert client_as(world["outsider"]).get(f"/api/v1/ops-notes/{nid}").status_code == 404
    assert client_as(world["outsider"]).put(f"/api/v1/ops-notes/{nid}", json={"title": "x"}).status_code == 404
    assert client_as(world["outsider"]).delete(f"/api/v1/ops-notes/{nid}").status_code == 404
    assert client_as(world["member"]).get(f"/api/v1/ops-notes/{nid}").status_code == 200


def test_create_with_foreign_tenant_is_forbidden(client_as, world):
    tid = str(world["tenant"].id)
    body = {"service": "k8s", "title": f"n-new-{world['tag']}", "tenant_id": tid}
    assert client_as(world["outsider"]).post("/api/v1/ops-notes", json=body).status_code == 403
    r = client_as(world["member"]).post("/api/v1/ops-notes", json=body)
    assert r.status_code == 201
    assert r.json()["tenant_id"] == tid


def test_member_can_make_private_note_shared(client_as, world):
    nid = world["note_private"].id
    r = client_as(world["member"]).put(f"/api/v1/ops-notes/{nid}", json={"tenant_id": None})
    assert r.status_code == 200
    assert client_as(world["outsider"]).get(f"/api/v1/ops-notes/{nid}").status_code == 200


# ── 업무 가이드 ──────────────────────────────────────────────────────────────

def test_guides_list_detail_and_search(client_as, world):
    tag = world["tag"]
    r = client_as(world["outsider"]).get("/api/v1/work-guides")
    names = {g["title"] for g in r.json()["data"]}
    assert f"guide-private-{tag}" not in names and f"guide-shared-{tag}" in names
    assert client_as(world["outsider"]).get(f"/api/v1/work-guides/{world['guide_private'].id}").status_code == 404

    r = client_as(world["outsider"]).get("/api/v1/work-guides/search", params={"q": f"guide-private-{tag}"})
    assert r.status_code == 200
    assert all(it["title"] != f"guide-private-{tag}" for it in r.json()["items"])


# ── 마인드맵 (노드는 부모 맵 기준) ─────────────────────────────────────────────

def test_mindmap_and_nodes(client_as, world):
    mid = world["map_private"].id
    r = client_as(world["outsider"]).get("/api/v1/mindmaps/")
    assert str(mid) not in {m["id"] for m in r.json()}
    assert client_as(world["outsider"]).get(f"/api/v1/mindmaps/{mid}").status_code == 404
    node = {"label": "x", "mindmap_id": str(mid)}
    assert client_as(world["outsider"]).post(f"/api/v1/mindmaps/{mid}/nodes", json=node).status_code == 404
    assert client_as(world["member"]).post(f"/api/v1/mindmaps/{mid}/nodes", json=node).status_code == 201


# ── 업무 항목 · 프로젝트 ─────────────────────────────────────────────────────

def test_work_items_follow_item_and_project_tenant(client_as, world):
    def titles(user):
        r = client_as(user).get("/api/v1/work-items", params={"q": world["tag"], "limit": 100})
        assert r.status_code == 200
        return {i["title"] for i in r.json()["data"]}

    tag = world["tag"]
    outsider = titles(world["outsider"])
    assert outsider == {f"item-shared-{tag}"}
    assert titles(world["member"]) == {f"item-shared-{tag}", f"item-private-{tag}", f"item-proj-{tag}"}

    for key in ("item_private", "item_in_private_project"):
        iid = world[key].id
        assert client_as(world["outsider"]).get(f"/api/v1/work-items/{iid}").status_code == 404
        assert client_as(world["outsider"]).get(f"/api/v1/work-items/{iid}/comments").status_code == 404
        assert client_as(world["outsider"]).post(
            f"/api/v1/work-items/{iid}/comments", json={"body": "x"}).status_code == 404


def test_projects_are_scoped(client_as, world):
    pid = world["project"].id
    r = client_as(world["outsider"]).get("/api/v1/projects")
    assert str(pid) not in {p["id"] for p in r.json()["data"]}
    assert client_as(world["outsider"]).get(f"/api/v1/projects/{pid}").status_code == 404
    assert client_as(world["member"]).get(f"/api/v1/projects/{pid}").status_code == 200


def test_cannot_attach_item_to_invisible_project(client_as, world):
    iid = world["item_shared"].id
    r = client_as(world["outsider"]).put(f"/api/v1/work-items/{iid}", json={"project_id": str(world["project"].id)})
    assert r.status_code == 404


def test_deleting_private_project_keeps_items_private(client_as, world, db):
    pid = world["project"].id
    assert client_as(world["member"]).delete(f"/api/v1/projects/{pid}").status_code == 204
    db.expire_all()
    item = db.query(WorkItem).filter(WorkItem.id == world["item_in_private_project"].id).one()
    assert item.project_id is None
    assert item.tenant_id == world["tenant"].id  # 프로젝트 테넌트를 물려받아 여전히 비공개
    assert client_as(world["outsider"]).get(f"/api/v1/work-items/{item.id}").status_code == 404


# ── 테넌트 관리 ──────────────────────────────────────────────────────────────

def test_tenant_delete_blocked_while_data_exists(client_as, world):
    r = client_as(world["admin"]).delete(f"/api/v1/tenants/{world['tenant'].id}")
    assert r.status_code == 409
    assert "ops_notes" in r.json()["detail"]


def test_my_tenants(client_as, world):
    names = {t["name"] for t in client_as(world["member"]).get("/api/v1/tenants/mine").json()}
    assert world["tenant"].name in names
    assert world["tenant"].name not in {t["name"] for t in client_as(world["outsider"]).get("/api/v1/tenants/mine").json()}
