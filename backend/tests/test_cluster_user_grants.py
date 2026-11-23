"""사용자별 클러스터 권한 직접 지정(ClusterUserGrant) 회귀 테스트.

규칙 (services/cluster_access.py):
- admin → 항상 operate.
- 직접 지정이 있으면 테넌트 판정보다 우선('none' = 숨김).
- read/operate 지정이 하나라도 있는 클러스터는 제한된 클러스터 — 지정·멤버십 없는 사용자에겐 숨김.
- 'none' 지정만으로는 제한되지 않는다(그 사용자만 숨김).
- 전역 role 게이트는 그대로 — viewer 에게 operate 를 줘도 실행 불가.
"""
import json
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.tenant import ClusterBinding, ClusterUserGrant, Tenant, TenantMember
from app.models.user import User
from app.services.cluster_access import (
    cluster_access_level,
    cluster_access_with_source,
    hidden_cluster_ids,
    restricted_cluster_ids,
)


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    c1 = Cluster(name=f"g1-{tag}", api_endpoint="https://g1:6443", node_ips=json.dumps(["10.8.0.1"]))
    c2 = Cluster(name=f"g2-{tag}", api_endpoint="https://g2:6443", node_ips=json.dumps(["10.8.1.1"]))
    users = {
        k: User(username=f"{k}-{tag}", hashed_password="x", role=role)
        for k, role in (("admin", "admin"), ("alice", "operator"), ("bob", "operator"), ("vic", "viewer"))
    }
    tenant = Tenant(name=f"gteam-{tag}")
    db.add_all([c1, c2, tenant, *users.values()])
    db.commit()
    w = {"c1": c1, "c2": c2, "tenant": tenant, **users}
    yield w
    uids = [u.id for u in users.values()]
    cids = [c1.id, c2.id]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterUserGrant).filter(ClusterUserGrant.cluster_id.in_(cids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_(cids)).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_(cids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


def _grant(db, user, cluster, access):
    db.add(ClusterUserGrant(user_id=user.id, cluster_id=cluster.id, access=access))
    db.commit()


# ── 판정 ────────────────────────────────────────────────────────────────────

def test_no_grant_is_open(db, world):
    assert cluster_access_level(db, world["bob"], world["c1"].id) == "operate"
    assert cluster_access_with_source(db, world["bob"], world["c1"].id) == ("operate", "open")


def test_read_grant_restricts_cluster_for_others(db, world):
    _grant(db, world["alice"], world["c1"], "read")
    assert cluster_access_with_source(db, world["alice"], world["c1"].id) == ("read", "grant")
    assert cluster_access_with_source(db, world["bob"], world["c1"].id) == (None, "restricted")
    assert cluster_access_level(db, world["admin"], world["c1"].id) == "operate"
    assert world["c1"].id in restricted_cluster_ids(db)
    assert world["c1"].id in hidden_cluster_ids(db, world["bob"])
    assert world["c1"].id not in hidden_cluster_ids(db, world["alice"])
    assert hidden_cluster_ids(db, world["admin"]) == frozenset()
    # 다른 클러스터는 영향 없음
    assert cluster_access_level(db, world["bob"], world["c2"].id) == "operate"


def test_none_grant_hides_only_that_user(db, world):
    _grant(db, world["alice"], world["c1"], "none")
    assert cluster_access_level(db, world["alice"], world["c1"].id) is None
    assert cluster_access_level(db, world["bob"], world["c1"].id) == "operate"
    assert world["c1"].id not in restricted_cluster_ids(db)
    assert world["c1"].id in hidden_cluster_ids(db, world["alice"])
    assert world["c1"].id not in hidden_cluster_ids(db, world["bob"])


def test_user_grant_overrides_tenant(db, world):
    db.add_all([
        TenantMember(tenant_id=world["tenant"].id, user_id=world["alice"].id),
        TenantMember(tenant_id=world["tenant"].id, user_id=world["bob"].id),
        ClusterBinding(tenant_id=world["tenant"].id, cluster_id=world["c1"].id, access="operate"),
    ])
    db.commit()
    tname = world["tenant"].name
    assert cluster_access_with_source(db, world["bob"], world["c1"].id) == ("operate", f"tenant:{tname}")
    _grant(db, world["alice"], world["c1"], "read")
    _grant(db, world["bob"], world["c1"], "none")
    assert cluster_access_level(db, world["alice"], world["c1"].id) == "read"
    assert cluster_access_level(db, world["bob"], world["c1"].id) is None
    assert world["c1"].id in hidden_cluster_ids(db, world["bob"])


def test_grant_opens_tenant_bound_cluster_for_non_member(db, world):
    db.add(ClusterBinding(tenant_id=world["tenant"].id, cluster_id=world["c1"].id, access="operate"))
    db.commit()
    assert cluster_access_level(db, world["bob"], world["c1"].id) is None
    _grant(db, world["bob"], world["c1"], "read")
    assert cluster_access_level(db, world["bob"], world["c1"].id) == "read"
    assert world["c1"].id not in hidden_cluster_ids(db, world["bob"])


def test_notify_and_public_follow_grants(db, world):
    from app.services.public_pages import public_clusters
    from app.services.user_notify import restrict_to_cluster_viewers

    uids = [world[k].id for k in ("admin", "alice", "bob", "vic")]

    def viewers():
        q = restrict_to_cluster_viewers(db, db.query(User).filter(User.id.in_(uids)), world["c1"].id)
        return {u.username.split("-")[0] for u in q.all()}

    assert viewers() == {"admin", "alice", "bob", "vic"}
    _grant(db, world["vic"], world["c1"], "none")
    assert viewers() == {"admin", "alice", "bob"}
    assert world["c1"].id in {c.id for c in public_clusters(db, None)}
    _grant(db, world["alice"], world["c1"], "read")
    assert viewers() == {"admin", "alice"}
    assert world["c1"].id not in {c.id for c in public_clusters(db, None)}


# ── 라우터 ──────────────────────────────────────────────────────────────────

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
        app.dependency_overrides.clear()


def test_bulk_api_admin_only(world, client_as):
    body = {"changes": [{"user_id": world["bob"].id, "cluster_id": str(world["c1"].id), "access": "read"}]}
    r = client_as(world["alice"]).put("/api/v1/cluster-access/grants/bulk", json=body)
    assert r.status_code == 403


def test_bulk_api_roundtrip(db, world, client_as):
    c = client_as(world["admin"])
    body = {"changes": [
        {"user_id": world["alice"].id, "cluster_id": str(world["c1"].id), "access": "read"},
        {"user_id": world["vic"].id, "cluster_id": str(world["c1"].id), "access": "operate"},
    ]}
    r = c.put("/api/v1/cluster-access/grants/bulk", json=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"created": 2, "updated": 0, "removed": 0}

    r = c.get(f"/api/v1/cluster-access/users/{world['vic'].id}")
    assert r.status_code == 200
    row = next(x for x in r.json()["clusters"] if x["cluster_id"] == str(world["c1"].id))
    assert row["grant"] == "operate" and row["effective"] == "operate" and row["role_limited"] is True

    r = c.get(f"/api/v1/cluster-access/users/{world['bob'].id}")
    row = next(x for x in r.json()["clusters"] if x["cluster_id"] == str(world["c1"].id))
    assert row["grant"] is None and row["effective"] is None and row["source"] == "restricted"

    summary = {x["user_id"]: x["grants"] for x in c.get("/api/v1/cluster-access/summary").json()}
    assert summary[world["alice"].id] == 1

    body = {"changes": [
        {"user_id": world["alice"].id, "cluster_id": str(world["c1"].id), "access": None},
        {"user_id": world["vic"].id, "cluster_id": str(world["c1"].id), "access": "read"},
    ]}
    r = c.put("/api/v1/cluster-access/grants/bulk", json=body)
    assert r.json() == {"created": 0, "updated": 1, "removed": 1}
    db.expire_all()
    assert db.query(AuditLog).filter(
        AuditLog.action == "cluster_access.grant", AuditLog.actor_user_id == world["admin"].id
    ).count() == 4


def test_bulk_api_validation(world, client_as):
    c = client_as(world["admin"])
    bad = {"changes": [{"user_id": world["bob"].id, "cluster_id": str(world["c1"].id), "access": "write"}]}
    assert c.put("/api/v1/cluster-access/grants/bulk", json=bad).status_code == 422
    missing = {"changes": [{"user_id": "nope", "cluster_id": str(world["c1"].id), "access": "read"}]}
    assert c.put("/api/v1/cluster-access/grants/bulk", json=missing).status_code == 404


def test_my_cluster_access_and_path_enforcement(world, client_as, db):
    _grant(db, world["alice"], world["c1"], "read")
    _grant(db, world["bob"], world["c2"], "none")
    r = client_as(world["bob"]).get("/api/v1/tenants/my-cluster-access")
    assert r.status_code == 200
    got = r.json()["clusters"]
    assert got[str(world["c1"].id)] is None
    assert got[str(world["c2"].id)] is None
    r = client_as(world["alice"]).get("/api/v1/tenants/my-cluster-access")
    assert r.json()["clusters"][str(world["c1"].id)] == "read"
    # 클러스터 목록에서 숨김
    ids = {c["id"] for c in client_as(world["bob"]).get("/api/v1/clusters").json()["data"]}
    assert str(world["c1"].id) not in ids and str(world["c2"].id) not in ids
    ids = {c["id"] for c in client_as(world["alice"]).get("/api/v1/clusters").json()["data"]}
    assert str(world["c1"].id) in ids
