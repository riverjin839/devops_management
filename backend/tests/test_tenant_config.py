"""멀티테넌시 4단계 — 메트릭 카드 공유 범위 + 테넌트별 LLM 라우팅·사용량 회귀 테스트.

- metric_cards.tenant_id: NULL = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다
  (목록·단건·쿼리·스파크라인·/query/all 캐시 응답까지).
- tenants.llm_routing: 사용자 요청의 LLM 컨텍스트(llm_tenant_context)가 있으면 지정한
  purpose 만 전역 라우팅을 덮는다. embedding 은 덮을 수 없다(pgvector 호환).
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
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.audit_log import AuditLog
from app.models.metric_card import MetricCard
from app.models.tenant import Tenant, TenantMember
from app.models.user import User
from app.services.llm.service import effective_route, llm_tenant_context, current_llm_tenant
from app.services.tenant_scope import resolve_llm_tenant


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()  # 구버전 테스트 DB 에도 tenant_id / llm_routing 컬럼 보강


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
    t_a = Tenant(name=f"a-{tag}")
    t_b = Tenant(name=f"b-{tag}", llm_routing={"chat": {"primary": "local-ollama", "fallback": None}})
    db.add_all([t_a, t_b, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=t_a.id, user_id=users["member"].id),
        TenantMember(tenant_id=t_b.id, user_id=users["member"].id),
    ])
    private = MetricCard(title=f"card-private-{tag}", promql="up", tenant_id=t_a.id)
    shared = MetricCard(title=f"card-shared-{tag}", promql="up")
    db.add_all([private, shared])
    db.commit()
    yield {"tag": tag, "a": t_a, "b": t_b, "private": private, "shared": shared, **users}

    db.rollback()
    db.query(MetricCard).filter(MetricCard.title.like(f"%{tag}%")).delete(synchronize_session=False)
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client_as(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    from app.routers import promql as promql_router
    from app.services.prometheus_service import prometheus_service

    async def _fake_query(_promql):
        return {"status": "ok", "value": 1.0}

    # 실제 Prometheus 없이 /query/* 를 검증 — 캐시도 테스트마다 비운다.
    monkeypatch.setattr(prometheus_service, "query", _fake_query)
    promql_router._invalidate_query_all_cache()

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── 메트릭 카드 ──────────────────────────────────────────────────────────────

def test_metric_cards_list_and_detail(client_as, world):
    def titles(user):
        r = client_as(user).get("/api/v1/promql/cards")
        assert r.status_code == 200
        return {c["title"] for c in r.json()["data"]}

    tag = world["tag"]
    assert f"card-private-{tag}" not in titles(world["outsider"])
    assert f"card-shared-{tag}" in titles(world["outsider"])
    assert f"card-private-{tag}" in titles(world["member"])
    cid = world["private"].id
    for path in (f"/api/v1/promql/cards/{cid}", f"/api/v1/promql/query/{cid}"):
        assert client_as(world["outsider"]).get(path).status_code == 404
        assert client_as(world["member"]).get(path).status_code == 200


def test_query_all_is_filtered_even_from_cache(client_as, world):
    # 멤버가 먼저 불러 캐시를 채운 뒤 비멤버가 같은 캐시를 받아도 비공개 카드는 빠져야 한다.
    member_ids = {r["card_id"] for r in client_as(world["member"]).get("/api/v1/promql/query/all").json()}
    assert str(world["private"].id) in member_ids
    outsider_ids = {r["card_id"] for r in client_as(world["outsider"]).get("/api/v1/promql/query/all").json()}
    assert str(world["private"].id) not in outsider_ids
    assert str(world["shared"].id) in outsider_ids


def test_metric_card_foreign_tenant_forbidden(client_as, world):
    body = {"title": f"card-new-{world['tag']}", "promql": "up", "tenant_id": str(world["a"].id)}
    assert client_as(world["outsider"]).post("/api/v1/promql/cards", json=body).status_code == 403
    assert client_as(world["member"]).post("/api/v1/promql/cards", json=body).status_code == 200


def test_tenant_delete_blocked_by_metric_cards(client_as, world):
    r = client_as(world["admin"]).delete(f"/api/v1/tenants/{world['a'].id}")
    assert r.status_code == 409
    assert "metric_cards" in r.json()["detail"]


# ── LLM 라우팅 ───────────────────────────────────────────────────────────────

CFG = {
    "profiles": [{"name": "global-llm"}, {"name": "team-llm"}, {"name": "backup-llm"}],
    "routing": {
        "chat": {"primary": "global-llm", "fallback": None},
        "embedding": {"primary": "global-llm", "fallback": None},
        "incident_analysis": {"primary": "global-llm", "fallback": None},
    },
}


def test_effective_route_without_tenant_is_global():
    assert current_llm_tenant() is None
    assert effective_route(CFG, "chat")["primary"] == "global-llm"


def test_effective_route_applies_tenant_override():
    tenant = {"id": "t", "routing": {
        "chat": {"primary": "team-llm", "fallback": "backup-llm"},
        "embedding": {"primary": "team-llm"},          # 무시돼야 함
        "incident_analysis": {"primary": "deleted-profile"},  # 없는 프로필 → 전역
    }}
    with llm_tenant_context(tenant):
        assert effective_route(CFG, "chat") == {"primary": "team-llm", "fallback": "backup-llm"}
        assert effective_route(CFG, "embedding")["primary"] == "global-llm"
        assert effective_route(CFG, "incident_analysis")["primary"] == "global-llm"
    assert current_llm_tenant() is None  # 컨텍스트 밖으로 새지 않는다


def test_resolve_llm_tenant_prefers_tenant_with_routing(db, world):
    t = resolve_llm_tenant(db, world["member"])
    assert t is not None and t["id"] == str(world["b"].id)  # a 가 이름순 먼저지만 라우팅 지정은 b
    assert t["routing"]["chat"]["primary"] == "local-ollama"
    assert resolve_llm_tenant(db, world["outsider"]) is None


def test_put_llm_routing_validation(client_as, world):
    c = client_as(world["admin"])
    url = f"/api/v1/tenants/{world['a'].id}/llm-routing"
    assert c.put(url, json={"routing": {"chat": {"primary": "no-such-profile"}}}).status_code == 422
    assert c.put(url, json={"routing": {"embedding": {"primary": "local-ollama"}}}).status_code == 422
    r = c.put(url, json={"routing": {"chat": {"primary": "local-ollama", "fallback": "local-ollama"}}})
    assert r.status_code == 200
    assert r.json()["llm_routing"] == {"chat": {"primary": "local-ollama", "fallback": None}}
    # 비우면 오버라이드 제거
    assert c.put(url, json={"routing": {"chat": {"primary": None}}}).json()["llm_routing"] == {}
    assert client_as(world["member"]).put(url, json={"routing": {}}).status_code == 403


def test_tenant_llm_usage_endpoint(client_as, world):
    r = client_as(world["admin"]).get("/api/v1/tenants/llm-usage")
    assert r.status_code == 200  # Redis 미가용이면 빈 목록(fail-open)
    assert isinstance(r.json(), list)
    assert client_as(world["member"]).get("/api/v1/tenants/llm-usage").status_code == 403
