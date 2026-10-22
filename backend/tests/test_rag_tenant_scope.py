"""RAG 근거 검색의 테넌트 가시 범위 — 작업 가이드·업무 이력·운영 노트.

- 비멤버는 다른 테넌트의 가이드·노트·업무 항목(비공개 프로젝트 소속 포함)을 근거로 받지 못한다.
- 멤버는 받는다.
- tenant_scope 없이 부르면(fail-closed) 공유(tenant_id NULL) 행만.
실제 DB(pgvector) + 임베딩 mock.
"""
import os
import random
import uuid
from datetime import datetime

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.config import settings  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.ops_note import OpsNote  # noqa: E402
from app.models.project import Project  # noqa: E402
from app.models.tenant import Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.work_guide import WorkGuide  # noqa: E402
from app.models.work_item import WorkItem  # noqa: E402
from app.services import rag_service  # noqa: E402
from app.services.llm import service as llm_service_module  # noqa: E402
from app.services.tenant_scope import TenantScope, user_tenant_ids  # noqa: E402

PRIVATE = {"guide-private", "note-private", "item-private", "item-proj"}
SHARED = {"guide-shared", "note-shared", "item-shared"}


@pytest.fixture(scope="module", autouse=True)
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def world(db, monkeypatch):
    tag = uuid.uuid4().hex[:8]
    # 이 테스트 행끼리만 유사도 1.0 이 되도록 무작위 방향 벡터를 쓴다(다른 테스트 데이터와 분리).
    rnd = random.Random(tag)
    vec = [rnd.uniform(-1, 1) for _ in range(settings.embedding_dim)]

    async def _fake_embed(self, text, *, db=None):
        return vec
    monkeypatch.setattr(llm_service_module.LLMService, "embed", _fake_embed)

    users = {k: User(username=f"rag-{k}-{tag}", hashed_password="x", role=role)
             for k, role in (("admin", "admin"), ("member", "operator"), ("outsider", "operator"))}
    tenant = Tenant(name=f"rag-team-{tag}")
    db.add_all([tenant, *users.values()])
    db.commit()
    db.add(TenantMember(tenant_id=tenant.id, user_id=users["member"].id))
    project = Project(name=f"rag-private-{tag}", tenant_id=tenant.id)
    db.add(project)
    db.commit()

    def _item(title, **kw):
        return WorkItem(type="task", assignee="t", primary_assignee="t", category="c", content=title,
                        title=f"{title}-{tag}", started_at=datetime.utcnow(), embedding=vec, **kw)

    db.add_all([
        WorkGuide(title=f"guide-private-{tag}", content="x", tenant_id=tenant.id, embedding=vec),
        WorkGuide(title=f"guide-shared-{tag}", content="x", embedding=vec),
        OpsNote(id=str(uuid.uuid4()), service="k8s", title=f"note-private-{tag}", tenant_id=tenant.id,
                embedding=vec),
        OpsNote(id=str(uuid.uuid4()), service="k8s", title=f"note-shared-{tag}", embedding=vec),
        _item("item-private", tenant_id=tenant.id),
        _item("item-proj", project_id=project.id),  # 항목은 공유지만 비공개 프로젝트 소속
        _item("item-shared"),
    ])
    db.commit()
    yield {"tag": tag, **users}

    db.rollback()
    db.query(WorkItem).filter(WorkItem.title.like(f"%-{tag}")).delete(synchronize_session=False)
    db.query(WorkGuide).filter(WorkGuide.title.like(f"%-{tag}")).delete(synchronize_session=False)
    db.query(OpsNote).filter(OpsNote.title.like(f"%-{tag}")).delete(synchronize_session=False)
    db.query(Project).filter(Project.id == project.id).delete(synchronize_session=False)
    uids = [u.id for u in users.values()]
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


def _scope(db, user):
    return TenantScope(is_admin=user.role == "admin", tenant_ids=user_tenant_ids(db, user))


def _names(citations, tag):
    suffix = f"-{tag}"
    return {c["title"][: -len(suffix)] for c in citations if c["title"].endswith(suffix)}


@pytest.mark.asyncio
async def test_non_member_does_not_get_other_tenant_rows(db, world):
    got = _names(await rag_service.retrieve(db, "q", k=20, tenant_scope=_scope(db, world["outsider"])),
                 world["tag"])
    assert got == SHARED


@pytest.mark.asyncio
async def test_member_and_admin_get_tenant_rows(db, world):
    for who in ("member", "admin"):
        got = _names(await rag_service.retrieve(db, "q", k=20, tenant_scope=_scope(db, world[who])),
                     world["tag"])
        assert got == PRIVATE | SHARED, who


@pytest.mark.asyncio
async def test_no_scope_is_shared_only(db, world):
    got = _names(await rag_service.retrieve(db, "q", k=20), world["tag"])
    assert got == SHARED


@pytest.mark.asyncio
async def test_agent_retrieve_citations_uses_user_tenant_scope(db, world):
    from app.routers.agent import _retrieve_citations
    # k=3 고정 — 순위 동률이라 어떤 3건인지는 비결정적이므로 "안 보여야 할 행이 없다" 만 본다.
    for _ in range(3):
        got = _names(await _retrieve_citations(db, "q", world["outsider"]), world["tag"])
        assert got and not (got & PRIVATE)


def test_rag_search_endpoint_applies_tenant_scope(world):
    from fastapi.testclient import TestClient
    from app.auth.deps import get_current_user
    from app.main import app

    def titles(user):
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            r = TestClient(app).get("/api/v1/llm/rag-search", params={"q": "q", "k": 20})
        finally:
            app.dependency_overrides.pop(get_current_user, None)
        assert r.status_code == 200, r.text
        return _names(r.json()["data"], world["tag"])

    assert titles(world["outsider"]) == SHARED
    assert titles(world["member"]) == PRIVATE | SHARED
