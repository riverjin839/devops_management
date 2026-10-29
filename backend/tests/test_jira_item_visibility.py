"""Jira 업무 단건/일괄 엔드포인트의 테넌트 가시성 회귀 테스트.

규칙 (services/tenant_scope.py · routers/jira.py ``_get_visible_item``):
- 다른 테넌트(또는 비공개 프로젝트) 업무는 Jira 경로에서도 **없는 업무와 같은 404**
  ("업무를 찾을 수 없습니다.") — 존재 여부가 새지 않는다.
- 멤버는 기존 동작 그대로.
- 연결 점검(verify-links)은 보이는 업무만 훑는다.

Jira HTTP 는 실제 ``JiraService`` 에 ``httpx.MockTransport`` 를 주입해 흉내 낸다. DB 는 실제로 쓴다.
"""
import os
import uuid
from datetime import datetime

import httpx
import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.audit_log import AuditLog
from app.models.project import Project
from app.models.tenant import Tenant, TenantMember
from app.models.user import User
from app.models.work_item import WorkItem
from app.routers import jira as jira_router
from app.services.jira_service import JiraService

BASE = "https://jira.example.com"
NOT_FOUND = "업무를 찾을 수 없습니다."


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
def world(db):
    tag = uuid.uuid4().hex[:8]
    users = {
        k: User(username=f"{k}-{tag}", display_name=f"{k}-{tag}", hashed_password="x", role=role)
        for k, role in (("member", "operator"), ("outsider", "operator"))
    }
    tenant = Tenant(name=f"jira-team-{tag}")
    db.add_all([tenant, *users.values()])
    db.commit()
    db.add(TenantMember(tenant_id=tenant.id, user_id=users["member"].id))
    project = Project(name=f"jira-private-{tag}", tenant_id=tenant.id)
    db.add(project)
    db.commit()

    def _item(key, title, **kw):
        # 담당자를 두 사용자 모두로 둬 verify-links 기본(내 업무) 필터에도 걸리게 한다.
        who = f"member-{tag} outsider-{tag}"
        return WorkItem(
            type="task", assignee=who, primary_assignee=who, category="c",
            content=title, title=title, started_at=datetime.utcnow(),
            jira_issue_key=key, jira_url=f"{BASE}/browse/{key}", kanban_status="todo", **kw,
        )

    t = tag.upper()
    rows = {
        "private": _item(f"PRV{t[:4]}-1", f"jira-private-{tag}", tenant_id=tenant.id,
                         confluence_page_id="111"),
        "in_project": _item(f"PRJ{t[:4]}-2", f"jira-proj-{tag}", project_id=project.id),
        "shared": _item(f"SHR{t[:4]}-3", f"jira-shared-{tag}"),
    }
    db.add_all(rows.values())
    db.commit()
    yield {"tag": tag, "tenant": tenant, **users, **rows}

    db.rollback()
    # 새로고침이 제목을 Jira 값으로 바꾸므로 제목이 아니라 id 로 지운다.
    item_ids = [r.id for r in rows.values()]
    db.query(WorkItem).filter(WorkItem.id.in_(item_ids)).delete(synchronize_session=False)
    db.query(Project).filter(Project.name.like(f"%{tag}%")).delete(synchronize_session=False)
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


class _JiraMock:
    """Jira REST 흉내 — 받은 요청을 기록하고 이슈 조회는 200, 쓰기는 204 로 답한다."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.missing: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if request.method == "DELETE":
            return httpx.Response(204)
        if request.method == "PUT":
            return httpx.Response(204)
        if path.endswith("/transitions"):
            return httpx.Response(200, json={"transitions": []})
        if path.endswith("/remotelink"):
            return httpx.Response(200, json=[])
        if "/rest/api/2/issue/" in path:
            key = path.rsplit("/", 1)[-1]
            if key in self.missing:
                return httpx.Response(404, json={"errorMessages": ["Issue does not exist"]})
            return httpx.Response(200, json={
                "id": "10001", "key": key,
                "fields": {
                    "summary": f"remote {key}", "status": {
                        "name": "To Do", "statusCategory": {"key": "new"}},
                    "updated": "2026-01-01T00:00:00.000+0000",
                },
            })
        return httpx.Response(404, json={})

    def touched(self, fragment: str) -> bool:
        return any(fragment in p for _m, p in self.calls)


@pytest.fixture
def jira(monkeypatch):
    mock = _JiraMock()
    svc = JiraService(BASE, "tok", transport=httpx.MockTransport(mock))
    cfg = {**jira_router.DEFAULT_JIRA_SETTINGS, "base_url": BASE, "enabled": True,
           "default_project_key": "OPS"}

    async def _verified(db, actor, cfg):  # noqa: ARG001
        return svc, {}

    monkeypatch.setattr(jira_router, "_get_config", lambda _db: dict(cfg))
    monkeypatch.setattr(jira_router, "_jira_service_verified", _verified)
    monkeypatch.setattr(jira_router, "_user_credential", lambda db, u: ("tok", "pat"))
    return mock


@pytest.fixture
def client_as():
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _hidden_requests(item_id: str, item_key: str):
    """비멤버가 부르면 404 여야 하는 업무 단건 엔드포인트 전부."""
    return [
        ("post", f"/api/v1/jira/refresh/{item_id}", None),
        ("post", f"/api/v1/jira/unlink/{item_id}", {"delete_work_item": False}),
        ("post", f"/api/v1/jira/unlink/{item_id}", {"delete_work_item": True}),
        ("post", f"/api/v1/jira/relink/{item_id}", {"key_or_url": "NEW-1"}),
        ("post", f"/api/v1/jira/push/{item_id}", {"comment": "x"}),
        ("post", f"/api/v1/jira/confluence/sync/{item_id}", None),
        ("post", "/api/v1/jira/create", {"work_item_id": item_id, "summary": "s"}),
        ("post", "/api/v1/jira/provision", {"work_item_id": item_id}),
    ]


@pytest.mark.parametrize("which", ["private", "in_project"])
def test_outsider_gets_same_404_as_missing_item(client_as, world, jira, db, which):
    item = world[which]
    c = client_as(world["outsider"])
    for method, url, body in _hidden_requests(str(item.id), item.jira_issue_key):
        r = getattr(c, method)(url, json=body) if body is not None else getattr(c, method)(url)
        assert r.status_code == 404, (url, r.status_code, r.text)
        assert r.json()["detail"] == NOT_FOUND, url
    # 진짜 없는 업무와 응답이 같아야 존재 여부가 새지 않는다.
    ghost = str(uuid.uuid4())
    r = c.post(f"/api/v1/jira/refresh/{ghost}")
    assert (r.status_code, r.json()["detail"]) == (404, NOT_FOUND)

    # Jira 로는 아무 요청도 나가지 않았고 업무는 그대로다.
    assert jira.calls == []
    db.expire_all()
    fresh = db.query(WorkItem).filter(WorkItem.id == item.id).first()
    assert fresh is not None and fresh.jira_issue_key == item.jira_issue_key


def test_member_refresh_and_push_still_work(client_as, world, jira):
    c = client_as(world["member"])
    item = world["private"]
    r = c.post(f"/api/v1/jira/refresh/{item.id}")
    assert r.status_code == 200 and r.json()["status"] == "ok", r.text
    r = c.post(f"/api/v1/jira/push/{item.id}", json={"push_fields": False})
    assert r.status_code == 200 and r.json()["status"] == "ok", r.text
    assert jira.touched(f"/issue/{item.jira_issue_key}")


def test_member_unlink_and_relink_still_work(client_as, world, jira, db):
    c = client_as(world["member"])
    item = world["in_project"]
    new_key = f"NEW{world['tag'][:4].upper()}-9"
    r = c.post(f"/api/v1/jira/relink/{item.id}", json={"key_or_url": new_key})
    assert r.status_code == 200 and r.json()["status"] == "ok", r.text
    r = c.post(f"/api/v1/jira/unlink/{item.id}", json={"delete_work_item": False})
    assert r.status_code == 200 and r.json()["status"] == "ok", r.text
    db.expire_all()
    assert db.query(WorkItem).filter(WorkItem.id == item.id).first().jira_issue_key is None


def test_relink_duplicate_does_not_leak_hidden_title(client_as, world, jira):
    """키 중복은 막되, 안 보이는 업무의 제목은 응답에 넣지 않는다."""
    hidden_key = world["private"].jira_issue_key
    r = client_as(world["outsider"]).post(
        f"/api/v1/jira/relink/{world['shared'].id}", json={"key_or_url": hidden_key})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "error"
    assert world["private"].title not in body["detail"]
    r = client_as(world["member"]).post(
        f"/api/v1/jira/relink/{world['shared'].id}", json={"key_or_url": hidden_key})
    assert world["private"].title in r.json()["detail"]


def test_provision_defaults_hides_invisible_item(client_as, world, jira):
    iid = str(world["private"].id)
    r = client_as(world["outsider"]).get("/api/v1/jira/provision/defaults", params={"work_item_id": iid})
    assert r.status_code == 200
    assert r.json()["summary"] == ""  # 없는 업무와 같은 기본값
    r = client_as(world["member"]).get("/api/v1/jira/provision/defaults", params={"work_item_id": iid})
    assert r.json()["summary"] == world["private"].title


def test_delete_issue_does_not_unlink_hidden_item(client_as, world, jira, db):
    item = world["private"]
    r = client_as(world["outsider"]).delete(f"/api/v1/jira/issue/{item.jira_issue_key}")
    assert r.status_code == 200
    assert r.json()["unlinked_work_item_id"] is None
    db.expire_all()
    assert db.query(WorkItem).filter(WorkItem.id == item.id).first().jira_issue_key == item.jira_issue_key

    r = client_as(world["member"]).delete(f"/api/v1/jira/issue/{item.jira_issue_key}")
    assert r.json()["unlinked_work_item_id"] == str(item.id)


@pytest.mark.parametrize("all_users", [False, True])
def test_verify_links_excludes_invisible_items(client_as, world, jira, all_users):
    # 모든 이슈를 "missing" 으로 만들어, 점검 대상이 된 업무가 결과에 전부 드러나게 한다.
    jira.missing = {world[k].jira_issue_key for k in ("private", "in_project", "shared")}

    def missing_ids(user):
        r = client_as(user).post("/api/v1/jira/verify-links", params={"all_users": all_users})
        assert r.status_code == 200 and r.json()["status"] == "ok", r.text
        return {m["work_item_id"] for m in r.json()["missing"]}

    ids = {k: str(world[k].id) for k in ("private", "in_project", "shared")}
    outsider = missing_ids(world["outsider"])
    assert ids["shared"] in outsider
    assert ids["private"] not in outsider and ids["in_project"] not in outsider
    # 안 보이는 업무의 키로는 Jira 조회도 나가지 않는다.
    assert not jira.touched(world["private"].jira_issue_key)

    member = missing_ids(world["member"])
    assert set(ids.values()) <= member
