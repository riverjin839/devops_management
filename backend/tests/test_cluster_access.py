"""멀티테넌시 1단계 — 테넌트 클러스터 바인딩 기반 실행 권한 회귀 테스트.

규칙 (services/cluster_access.py):
- 바인딩 없는 클러스터는 열려 있다(기존 설치 호환).
- 바인딩 있는 클러스터는 바인딩된 테넌트 멤버만, access='operate' 일 때만 실행·변경 가능.
- admin 은 항상 허용. 조회(GET)는 1단계 범위 밖이라 막지 않는다.
실제 DB 로 검증한다.
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

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.alert_event import AlertEvent
from app.models.user import User
from app.services.cluster_access import (
    cluster_access_level,
    cluster_ids_for_host,
    has_cluster_access,
    hidden_cluster_ids,
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
    """클러스터 2개 + 테넌트 1개 + 사용자(admin/operator 멤버/operator 비멤버/viewer 멤버)."""
    tag = uuid.uuid4().hex[:8]
    c_open = Cluster(name=f"open-{tag}", api_endpoint="https://open:6443",
                     node_ips=json.dumps(["10.9.0.1"]))
    c_bound = Cluster(name=f"bound-{tag}", api_endpoint="https://bound:6443",
                      node_ips=json.dumps(["10.9.1.1", "10.9.1.2"]))
    users = {
        role_key: User(username=f"{role_key}-{tag}", hashed_password="x", role=role)
        for role_key, role in (
            ("admin", "admin"), ("op_member", "operator"), ("op_outsider", "operator"),
            ("viewer_member", "viewer"),
        )
    }
    tenant = Tenant(name=f"team-{tag}")
    db.add_all([c_open, c_bound, tenant, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["op_member"].id),
        TenantMember(tenant_id=tenant.id, user_id=users["viewer_member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="operate"),
    ])
    db.commit()
    w = {"open": c_open, "bound": c_bound, "tenant": tenant, **users}
    yield w
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_([c_open.id, c_bound.id])).delete(
        synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_([c_open.id, c_bound.id])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


# ── 판정 서비스 ──────────────────────────────────────────────────────────────

def test_unbound_cluster_is_open(db, world):
    assert cluster_access_level(db, world["op_outsider"], world["open"].id) == "operate"


def test_bound_cluster_requires_membership(db, world):
    assert has_cluster_access(db, world["op_member"], world["bound"].id, "operate")
    assert not has_cluster_access(db, world["op_outsider"], world["bound"].id, "read")
    assert cluster_access_level(db, world["op_outsider"], world["bound"].id) is None


def test_admin_always_allowed(db, world):
    assert has_cluster_access(db, world["admin"], world["bound"].id, "operate")


def test_read_binding_blocks_operate(db, world):
    b = db.query(ClusterBinding).filter(ClusterBinding.cluster_id == world["bound"].id).one()
    b.access = "read"
    db.commit()
    assert has_cluster_access(db, world["op_member"], world["bound"].id, "read")
    assert not has_cluster_access(db, world["op_member"], world["bound"].id, "operate")


def test_highest_binding_wins(db, world):
    other = Tenant(name=f"other-{world['tenant'].name}")
    db.add(other)
    db.commit()
    db.add_all([
        TenantMember(tenant_id=other.id, user_id=world["op_outsider"].id),
        ClusterBinding(tenant_id=other.id, cluster_id=world["bound"].id, access="read"),
        TenantMember(tenant_id=other.id, user_id=world["op_member"].id),
    ])
    db.commit()
    assert cluster_access_level(db, world["op_outsider"], world["bound"].id) == "read"
    assert cluster_access_level(db, world["op_member"], world["bound"].id) == "operate"


def test_cluster_ids_for_host(db, world):
    assert cluster_ids_for_host(db, "10.9.1.2") == {world["bound"].id}
    assert cluster_ids_for_host(db, "192.0.2.123") == set()
    assert cluster_ids_for_host(db, "") == set()


# ── 라우터 강제 ──────────────────────────────────────────────────────────────

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


def _dismiss_url(cluster_id):
    # 존재하지 않는 추천 id — 권한을 통과하면 404, 막히면 403. 부작용 없는 변경 엔드포인트.
    return f"/api/v1/k8s/{cluster_id}/efficiency/recommendations/{uuid.uuid4()}/dismiss"


def test_path_dependency_blocks_outsider_on_bound_cluster(client_as, world):
    r = client_as(world["op_outsider"]).post(_dismiss_url(world["bound"].id))
    assert r.status_code == 403
    assert "테넌트" in r.json()["detail"]


def test_path_dependency_allows_member_and_unbound(client_as, world):
    assert client_as(world["op_member"]).post(_dismiss_url(world["bound"].id)).status_code == 404
    assert client_as(world["op_outsider"]).post(_dismiss_url(world["open"].id)).status_code == 404


def test_get_requires_read_binding(client_as, world, db):
    # 2단계: 조회(GET)도 바인딩 범위로 격리 — 비멤버는 403, read 멤버는 통과.
    url = f"/api/v1/k8s/{world['bound'].id}/efficiency/policies"
    assert client_as(world["op_outsider"]).get(url).status_code == 403
    assert client_as(world["op_member"]).get(url).status_code != 403
    b = db.query(ClusterBinding).filter(ClusterBinding.cluster_id == world["bound"].id).one()
    b.access = "read"
    db.commit()
    assert client_as(world["op_member"]).get(url).status_code != 403
    assert client_as(world["op_member"]).post(_dismiss_url(world["bound"].id)).status_code == 403


def test_bulk_exec_checks_target_clusters(client_as, world):
    body = {
        "action": "ssh", "command": "true", "username": "root", "password": "x",
        "targets": [{"host": "10.9.1.1", "cluster_id": str(world["bound"].id)}],
    }
    r = client_as(world["op_outsider"]).post("/api/v1/bulk-exec/run", json=body)
    assert r.status_code == 403


def test_bulk_exec_host_only_target_is_scoped(client_as, world):
    # cluster_id 를 빼고 host 만 넘겨도 host 가 속한 클러스터로 판정한다.
    body = {"action": "ssh", "command": "true", "username": "root", "password": "x",
            "targets": [{"host": "10.9.1.2"}]}
    assert client_as(world["op_outsider"]).post("/api/v1/bulk-exec/run", json=body).status_code == 403


def test_bulk_exec_fetch_file_is_scoped(client_as, world):
    body = {"host": "10.9.1.1", "remote_path": "/etc/hosts", "username": "root", "password": "x"}
    assert client_as(world["op_outsider"]).post("/api/v1/bulk-exec/fetch-file", json=body).status_code == 403


# ── 테넌트 관리 API ──────────────────────────────────────────────────────────

def test_tenants_api_is_admin_only(client_as, world):
    assert client_as(world["op_member"]).get("/api/v1/tenants").status_code == 403
    assert client_as(world["op_member"]).post("/api/v1/tenants", json={"name": "x"}).status_code == 403


def test_tenants_api_crud(client_as, world, db):
    c = client_as(world["admin"])
    name = f"crud-{world['tenant'].name}"
    r = c.post("/api/v1/tenants", json={"name": name, "description": "d"})
    assert r.status_code == 201
    tid = r.json()["id"]
    assert c.post("/api/v1/tenants", json={"name": name}).status_code == 409

    r = c.put(f"/api/v1/tenants/{tid}/members", json={"user_ids": [world["op_outsider"].id]})
    assert r.status_code == 200
    assert [m["user_id"] for m in r.json()["members"]] == [world["op_outsider"].id]

    r = c.put(f"/api/v1/tenants/{tid}/bindings",
              json={"bindings": [{"cluster_id": str(world["open"].id), "access": "read"}]})
    assert r.status_code == 200
    assert r.json()["bindings"][0]["access"] == "read"
    # 바인딩이 생기는 순간 open 클러스터도 제한된다 — outsider 는 read 만
    assert cluster_access_level(db, world["op_outsider"], world["open"].id) == "read"

    assert c.put(f"/api/v1/tenants/{tid}/bindings",
                 json={"bindings": [{"cluster_id": str(uuid.uuid4())}]}).status_code == 422

    assert c.delete(f"/api/v1/tenants/{tid}").status_code == 204
    db.expire_all()
    assert db.query(ClusterBinding).filter(ClusterBinding.tenant_id == uuid.UUID(tid)).count() == 0
    assert cluster_access_level(db, world["op_outsider"], world["open"].id) == "operate"


def test_my_cluster_access(client_as, world):
    r = client_as(world["op_outsider"]).get("/api/v1/tenants/my-cluster-access")
    assert r.status_code == 200
    clusters = r.json()["clusters"]
    assert clusters[str(world["bound"].id)] is None
    assert str(world["open"].id) not in clusters


# ── 2단계: 조회 격리 ─────────────────────────────────────────────────────────

def test_hidden_cluster_ids(db, world):
    assert world["bound"].id in hidden_cluster_ids(db, world["op_outsider"])
    assert world["open"].id not in hidden_cluster_ids(db, world["op_outsider"])
    assert hidden_cluster_ids(db, world["op_member"]) == frozenset()
    assert hidden_cluster_ids(db, world["admin"]) == frozenset()


def test_cluster_list_is_filtered(client_as, world):
    def ids(user):
        r = client_as(user).get("/api/v1/clusters")
        assert r.status_code == 200
        return {c["id"] for c in r.json()["data"]}

    outsider = ids(world["op_outsider"])
    assert str(world["bound"].id) not in outsider
    assert str(world["open"].id) in outsider
    assert str(world["bound"].id) in ids(world["op_member"])
    assert str(world["bound"].id) in ids(world["admin"])


def test_cluster_detail_is_blocked(client_as, world):
    assert client_as(world["op_outsider"]).get(f"/api/v1/clusters/{world['bound'].id}").status_code == 403
    assert client_as(world["op_member"]).get(f"/api/v1/clusters/{world['bound'].id}").status_code == 200


def test_check_matrix_grid_hides_columns(client_as, world):
    r = client_as(world["op_outsider"]).get("/api/v1/check-matrix/grid")
    assert r.status_code == 200
    cols = {c["id"] for c in r.json()["clusters"]}
    assert str(world["bound"].id) not in cols
    assert str(world["open"].id) in cols
    for row in r.json()["cells"].values():
        assert str(world["bound"].id) not in row


def test_dashboard_summary_is_filtered(client_as, world):
    r = client_as(world["op_outsider"]).get("/api/v1/daily-check/summary")
    assert r.status_code == 200
    assert str(world["bound"].id) not in {s["cluster_id"] for s in r.json()}


def test_alerts_are_filtered(client_as, world, db):
    tag = world["tenant"].name
    rows = [
        AlertEvent(fingerprint=f"fp-bound-{tag}", alertname=f"A-{tag}", status="firing", severity="critical",
                   cluster_id=world["bound"].id),
        AlertEvent(fingerprint=f"fp-none-{tag}", alertname=f"A-{tag}", status="firing", severity="warning",
                   cluster_id=None),
    ]
    db.add_all(rows)
    db.commit()
    try:
        r = client_as(world["op_outsider"]).get("/api/v1/observability/alerts", params={"alertname": f"A-{tag}"})
        assert r.status_code == 200
        got = {a["fingerprint"] for a in r.json()["data"]}
        assert got == {f"fp-none-{tag}"}  # 클러스터 무관 알람은 남고, 가려진 클러스터 알람은 빠진다
        assert client_as(world["op_outsider"]).get(
            f"/api/v1/observability/alerts/{rows[0].id}").status_code == 404
        assert client_as(world["op_member"]).get(
            f"/api/v1/observability/alerts/{rows[0].id}").status_code == 200
    finally:
        db.query(AlertEvent).filter(AlertEvent.id.in_([r.id for r in rows])).delete(synchronize_session=False)
        db.commit()
