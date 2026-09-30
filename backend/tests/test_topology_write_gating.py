"""D-087/D-090 — 인프라·서비스 토폴로지 변경 엔드포인트의 역할·테넌트 게이팅 회귀 테스트.

이전에는 인프라 노드가 클라이언트가 보내는 ``X-API-Scopes`` 헤더 문자열만 검사했고, 서비스 토폴로지는
아무 검사도 없었다(viewer 도, 다른 테넌트도 링크·외부 노드·노드를 만들고 지울 수 있었다). 이제:
  - 변경(POST/PUT/PATCH/DELETE)은 ``require_operator`` (viewer → 403).
  - 경로에 cluster_id 가 없는 엔드포인트(link_id/node_id)는 소유 클러스터로 테넌트 바인딩을 직접 판정.
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
from app.models import ServiceTopologyExternalNode, ServiceTopologyLink
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.topology_audit_log import TopologyAuditLog
from app.models.user import User

EDIT = {"X-API-Scopes": "infra_topology.edit"}
FORCE = {"X-API-Scopes": "infra_topology.force_fix"}
SYNC = {"X-API-Scopes": "infra_topology.sync"}


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    """바인딩된 클러스터 1개 + 테넌트 1개 + 사용자(operator 멤버/operator 비멤버/viewer 멤버)."""
    tag = uuid.uuid4().hex[:8]
    bound = Cluster(name=f"topo-bound-{tag}", api_endpoint="https://bound:6443",
                    node_ips=json.dumps(["10.8.1.1"]))
    users = {
        key: User(username=f"{key}-{tag}", hashed_password="x", role=role)
        for key, role in (("op_member", "operator"), ("op_outsider", "operator"), ("viewer_member", "viewer"))
    }
    tenant = Tenant(name=f"topo-team-{tag}")
    db.add_all([bound, tenant, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["op_member"].id),
        TenantMember(tenant_id=tenant.id, user_id=users["viewer_member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=bound.id, access="operate"),
    ])
    db.commit()
    yield {"bound": bound, **users}
    uids = [u.id for u in users.values()]
    db.query(ServiceTopologyLink).filter(ServiceTopologyLink.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(ServiceTopologyExternalNode).filter(
        ServiceTopologyExternalNode.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(TopologyAuditLog).filter(TopologyAuditLog.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(InfraNode).filter(InfraNode.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == bound.id).delete(synchronize_session=False)
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


def _link(db, cluster):
    row = ServiceTopologyLink(
        cluster_id=cluster.id, namespace="default", source_kind="Service", source_name="a",
        target_kind="Service", target_name="b", link_type="depends_on",
    )
    db.add(row)
    db.commit()
    return row


def _ext(db, cluster):
    row = ServiceTopologyExternalNode(cluster_id=cluster.id, namespace="default", name="ext-db", node_type="database")
    db.add(row)
    db.commit()
    return row


def _node(db, cluster, hostname=None):
    row = InfraNode(cluster_id=cluster.id, hostname=hostname or f"n-{uuid.uuid4().hex[:6]}", role="worker")
    db.add(row)
    db.commit()
    return row


# ── 서비스 토폴로지 ──────────────────────────────────────────────────────────

def test_service_topology_create_link_requires_operator(client_as, world):
    url = f"/api/v1/service-topology/{world['bound'].id}/links"
    body = {"source_kind": "Service", "source_name": "a", "target_kind": "Service", "target_name": "b"}
    assert client_as(world["viewer_member"]).post(url, json=body).status_code == 403
    assert client_as(world["op_outsider"]).post(url, json=body).status_code == 403
    assert client_as(world["op_member"]).post(url, json=body).status_code == 201


def test_service_topology_delete_link_checks_owning_cluster(client_as, world, db):
    link = _link(db, world["bound"])
    url = f"/api/v1/service-topology/links/{link.id}"
    assert client_as(world["viewer_member"]).delete(url).status_code == 403
    # 핵심(D-090): link_id 경로라 cluster_id 가 없어도 다른 테넌트의 링크는 못 지운다.
    assert client_as(world["op_outsider"]).delete(url).status_code == 403
    assert db.query(ServiceTopologyLink).filter(ServiceTopologyLink.id == link.id).count() == 1
    assert client_as(world["op_member"]).delete(url).status_code == 204


def test_service_topology_update_link_checks_owning_cluster(client_as, world, db):
    link = _link(db, world["bound"])
    url = f"/api/v1/service-topology/links/{link.id}"
    assert client_as(world["viewer_member"]).patch(url, json={"label": "x"}).status_code == 403
    assert client_as(world["op_outsider"]).patch(url, json={"label": "x"}).status_code == 403
    assert client_as(world["op_member"]).patch(url, json={"label": "x"}).status_code == 200


def test_service_topology_external_node_gating(client_as, world, db):
    create_url = f"/api/v1/service-topology/{world['bound'].id}/external-nodes"
    body = {"name": "ext-x", "node_type": "database"}
    assert client_as(world["viewer_member"]).post(create_url, json=body).status_code == 403
    assert client_as(world["op_outsider"]).post(create_url, json=body).status_code == 403
    assert client_as(world["op_member"]).post(create_url, json=body).status_code == 201

    ext = _ext(db, world["bound"])
    url = f"/api/v1/service-topology/external-nodes/{ext.id}"
    assert client_as(world["viewer_member"]).delete(url).status_code == 403
    assert client_as(world["op_outsider"]).delete(url).status_code == 403
    assert client_as(world["op_member"]).delete(url).status_code == 204


# ── 인프라 토폴로지 ──────────────────────────────────────────────────────────

def test_infra_create_requires_operator_and_binding(client_as, world):
    body = {"cluster_id": str(world["bound"].id), "hostname": f"h-{uuid.uuid4().hex[:6]}"}
    # 헤더 스코프가 맞아도 viewer 는 막힌다(이전엔 헤더만 검사).
    assert client_as(world["viewer_member"]).post("/api/v1/infra-nodes", json=body, headers=EDIT).status_code == 403
    # 본문 cluster_id 는 경로 의존성이 못 보므로 핸들러가 직접 테넌트 바인딩을 판정한다.
    assert client_as(world["op_outsider"]).post("/api/v1/infra-nodes", json=body, headers=EDIT).status_code == 403
    assert client_as(world["op_member"]).post("/api/v1/infra-nodes", json=body, headers=EDIT).status_code == 201


def test_infra_update_and_delete_check_owning_cluster(client_as, world, db):
    node = _node(db, world["bound"])
    put_url = f"/api/v1/infra-nodes/{node.id}"
    upd = {"notes": "n", "version": node.version}
    assert client_as(world["viewer_member"]).put(put_url, json=upd, headers=EDIT).status_code == 403
    assert client_as(world["op_outsider"]).put(put_url, json=upd, headers=EDIT).status_code == 403
    assert client_as(world["op_member"]).put(put_url, json=upd, headers=EDIT).status_code == 200

    assert client_as(world["viewer_member"]).delete(put_url, headers=FORCE).status_code == 403
    assert client_as(world["op_outsider"]).delete(put_url, headers=FORCE).status_code == 403
    assert db.query(InfraNode).filter(InfraNode.id == node.id).count() == 1
    assert client_as(world["op_member"]).delete(put_url, headers=FORCE).status_code == 204


def test_infra_verify_and_sync_are_denied_before_running_anything(client_as, world, db):
    node = _node(db, world["bound"])
    verify = f"/api/v1/infra-nodes/{node.id}/verify"
    assert client_as(world["viewer_member"]).post(verify, headers=SYNC).status_code == 403
    assert client_as(world["op_outsider"]).post(verify, headers=SYNC).status_code == 403
    sync = f"/api/v1/infra-nodes/sync/{world['bound'].id}"
    assert client_as(world["viewer_member"]).post(sync, headers=SYNC).status_code == 403
    assert client_as(world["op_outsider"]).post(sync, headers=SYNC).status_code == 403
