"""D-100 — 인프라 노드 값 지우기·빈 문자열 정규화·클러스터 정보 프리필 회귀 테스트.

이전에는
  - 편집 화면에서 CPU/RAM/Disk 를 비우면 필드가 JSON 에서 빠져(부분 수정) 기존 값이 그대로 남았고,
  - 빈 문자열이 그대로 저장돼 랙/스위치 그룹핑에 이름 없는 그룹이 생겼으며,
  - 노드를 추가할 때마다 클러스터의 first_host·description 이 채워져 모든 노드가 같은 IP·메모를 가졌다.
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
from app.main import _ensure_pgvector_extension
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.topology_audit_log import TopologyAuditLog
from app.models.user import User
from app.schemas.infra_node import InfraNodeCreate, InfraNodeUpdate

EDIT = {"X-API-Scopes": "infra_topology.edit"}


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
    cluster = Cluster(
        name=f"infra-values-{tag}", api_endpoint="https://c:6443",
        first_host="10.9.0.1", description="desc-for-first-node",
    )
    op = User(username=f"op-{tag}", hashed_password="x", role="operator")
    db.add_all([cluster, op])
    db.commit()
    yield {"cluster": cluster, "op": op}
    db.query(TopologyAuditLog).filter(TopologyAuditLog.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(InfraNode).filter(InfraNode.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id == op.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id == op.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client(world):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: world["op"]
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_schema_blank_strings_become_none():
    cid = uuid.uuid4()
    body = InfraNodeCreate(cluster_id=cid, hostname="  n1  ", rack_name="  ", switch_name="", notes=" x ")
    assert body.hostname == "n1"
    assert body.rack_name is None
    assert body.switch_name is None
    assert body.notes == "x"
    upd = InfraNodeUpdate(version=1, os_info="", ip_address="  ")
    assert upd.os_info is None and upd.ip_address is None


def test_prefill_applies_to_first_node_only(client, world, db):
    cid = str(world["cluster"].id)
    first = client.post("/api/v1/infra-nodes", json={"cluster_id": cid, "hostname": "n-1"}, headers=EDIT)
    assert first.status_code == 201
    assert first.json()["ip_address"] == "10.9.0.1"
    assert "desc-for-first-node" in (first.json()["notes"] or "")

    second = client.post("/api/v1/infra-nodes", json={"cluster_id": cid, "hostname": "n-2"}, headers=EDIT)
    assert second.status_code == 201
    assert second.json()["ip_address"] is None
    assert second.json()["notes"] is None


def test_update_with_null_clears_values(client, world, db):
    node = InfraNode(cluster_id=world["cluster"].id, hostname="n-clear", cpu_cores=8, ram_gb=32,
                     rack_name="Rack-A", switch_name="sw-1")
    db.add(node)
    db.commit()
    res = client.put(
        f"/api/v1/infra-nodes/{node.id}",
        json={"version": node.version, "cpu_cores": None, "ram_gb": None, "rack_name": "", "switch_name": None},
        headers=EDIT,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["cpu_cores"] is None
    assert data["ram_gb"] is None
    assert data["rack_name"] is None
    assert data["switch_name"] is None


def test_update_ignores_null_for_required_columns(client, world, db):
    node = InfraNode(cluster_id=world["cluster"].id, hostname="n-keep", role="master")
    db.add(node)
    db.commit()
    res = client.put(
        f"/api/v1/infra-nodes/{node.id}",
        json={"version": node.version, "hostname": None, "role": None, "notes": "memo"},
        headers=EDIT,
    )
    assert res.status_code == 200, res.text
    assert res.json()["hostname"] == "n-keep"
    assert res.json()["role"] == "master"
    assert res.json()["notes"] == "memo"


def test_duplicate_hostname_conflict_message(client, world):
    cid = str(world["cluster"].id)
    assert client.post("/api/v1/infra-nodes", json={"cluster_id": cid, "hostname": "dup"}, headers=EDIT).status_code == 201
    res = client.post("/api/v1/infra-nodes", json={"cluster_id": cid, "hostname": "dup"}, headers=EDIT)
    assert res.status_code == 409
    assert "dup" in res.json()["detail"]
