"""R-4 15차 감사 B-10·B-15 — 버전 그래프 응답 계약과 재수집 응답의 컴포넌트별 결과.

- 그래프 엣지는 양 끝이 모두 노드 집합에 있어야 한다(cilium_config 만 있고 cilium_agent 가 없을 때
  `configures` 엣지가 끝점 없이 나가면 d3 force 가 "node not found" 를 던진다).
- 컴포넌트 노드는 `flag_total`(수집된 플래그 전체 수)을 싣고, leaf 플래그는 6개까지만 그린다.
- `POST /collect-versions` 응답은 `components: [{component, version, changed}]` 를 준다.

K8s API 는 가짜 객체로 대신한다(실제 DB 사용).
"""
import os
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

import app.routers.versions as versions  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models import ClusterConfigSnapshot  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.config_snapshot import store_if_changed  # noqa: E402


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
    # 클러스터 이름에 HTML 이 들어 있어도 서버는 원문 그대로 준다 — 이스케이프는 화면 몫(B-3).
    cluster = Cluster(name=f"vg-<img src=x>-{tag}", api_endpoint="https://c:6443")
    op = User(username=f"vg-op-{tag}", hashed_password="x", role="operator")
    db.add_all([cluster, op])
    db.commit()
    yield {"cluster": cluster, "op": op}
    db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id == op.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id == op.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client(world):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: world["op"]
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _snap(db, cluster_id, component, category, version, data, when=None):
    store_if_changed(db, cluster_id, component, category, version, data, when or datetime.utcnow())
    db.commit()


def _graph(client, cluster_id) -> dict:
    res = client.get(f"/api/v1/clusters/{cluster_id}/versions/graph")
    assert res.status_code == 200, res.text
    return res.json()


def _assert_no_dangling(body: dict) -> None:
    ids = {n["id"] for n in body["nodes"]}
    dangling = [e for e in body["edges"] if e["source"] not in ids or e["target"] not in ids]
    assert dangling == []


# ── 그래프 (B-10) ─────────────────────────────────────────────────────────────


def test_graph_drops_configures_edge_without_cilium_agent(client, world, db):
    cid = world["cluster"].id
    _snap(db, cid, "cilium_config", "cni", "1.15.0",
          {"data": {"cilium-version": "1.15.0", "kube-proxy-replacement": "true"}})

    body = _graph(client, cid)
    ids = {n["id"] for n in body["nodes"]}
    assert "comp:cilium_config" in ids
    assert "comp:cilium_agent" not in ids
    _assert_no_dangling(body)
    assert not [e for e in body["edges"] if e["type"] in ("configures", "replaces")]


def test_graph_keeps_cross_edges_when_both_ends_exist(client, world, db):
    cid = world["cluster"].id
    _snap(db, cid, "cilium_config", "cni", "1.15.0", {"data": {"kube-proxy-replacement": "strict"}})
    _snap(db, cid, "cilium_agent", "cni", "v1.15.0", {"image": "cilium:v1.15.0", "flags": {}})
    _snap(db, cid, "kube_proxy", "control_plane", "v1.29.0", {"image": "kube-proxy:v1.29.0", "flags": {}})

    body = _graph(client, cid)
    _assert_no_dangling(body)
    pairs = {(e["source"], e["target"], e["type"]) for e in body["edges"]}
    assert ("comp:cilium_config", "comp:cilium_agent", "configures") in pairs
    assert ("comp:cilium_agent", "comp:kube_proxy", "replaces") in pairs


def test_graph_component_carries_flag_total_and_caps_leaves(client, world, db):
    cid = world["cluster"].id
    flags = {f"flag-{i:02d}": f"v{i}" for i in range(10)}
    _snap(db, cid, "kube_apiserver", "control_plane", "v1.29.0", {"image": "x:v1.29.0", "flags": flags})
    _snap(db, cid, "coredns", "control_plane", "v1.11.1", {"image": "coredns:v1.11.1", "flags": {"conf": "/etc/Corefile"}})
    _snap(db, cid, "k8s_server", "control_plane", "v1.29.0", {"major": "1"})

    body = _graph(client, cid)
    _assert_no_dangling(body)
    comps = {n["id"]: n for n in body["nodes"] if n["type"] == "component"}
    assert comps["comp:kube_apiserver"]["flag_total"] == 10
    assert comps["comp:coredns"]["flag_total"] == 1
    # 플래그가 없는 스냅샷(k8s_server)에는 flag_total 을 싣지 않는다.
    assert "flag_total" not in comps["comp:k8s_server"]
    leaves = [e for e in body["edges"] if e["type"] == "param" and e["source"] == "comp:kube_apiserver"]
    assert len(leaves) == versions._GRAPH_FLAG_LIMIT == 6


def test_graph_without_snapshots_has_only_cluster_root(client, world):
    body = _graph(client, world["cluster"].id)
    assert [n["type"] for n in body["nodes"]] == ["cluster"]
    assert body["nodes"][0]["label"] == world["cluster"].name
    assert body["edges"] == []


def test_graph_uses_latest_snapshot_per_component(client, world, db):
    cid = world["cluster"].id
    old = datetime.utcnow() - timedelta(days=1)
    _snap(db, cid, "etcd", "control_plane", "3.5.9", {"image": "etcd:3.5.9", "flags": {"a": "1"}}, when=old)
    _snap(db, cid, "etcd", "control_plane", "3.5.12", {"image": "etcd:3.5.12", "flags": {"a": "1", "b": "2"}})

    body = _graph(client, cid)
    etcd = next(n for n in body["nodes"] if n["id"] == "comp:etcd")
    assert etcd["version"] == "3.5.12"
    assert etcd["flag_total"] == 2


# ── 재수집 응답 (B-15) ────────────────────────────────────────────────────────


def _container(image: str, args: list[str]):
    return SimpleNamespace(image=image, command=None, args=args)


def _pod(name: str, image: str, args: list[str], labels: dict | None = None):
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name, namespace="kube-system", labels=labels or {}),
        spec=SimpleNamespace(containers=[_container(image, args)]),
    )


class _FakeCore:
    def __init__(self, _api_client):
        pass

    def list_node(self, **_kw):
        ni = SimpleNamespace(
            kubelet_version="v1.29.0", kube_proxy_version="v1.29.0", container_runtime_version="containerd://1.7",
            kernel_version="5.15", os_image="Ubuntu", operating_system="linux", architecture="amd64",
        )
        return SimpleNamespace(items=[SimpleNamespace(metadata=SimpleNamespace(name="node-1"),
                                                      status=SimpleNamespace(node_info=ni))])

    def list_namespaced_pod(self, _ns, **_kw):
        return SimpleNamespace(items=[
            _pod("kube-apiserver-node-1", "registry.k8s.io/kube-apiserver:v1.29.0", ["--secure-port=6443"]),
            _pod("cilium-abcde", "quay.io/cilium/cilium:v1.15.0", ["--config-dir=/tmp"], {"k8s-app": "cilium"}),
        ])

    def read_namespaced_config_map(self, *_a, **_kw):
        from kubernetes.client import ApiException

        raise ApiException(status=404)


class _FakeVersion:
    def __init__(self, _api_client):
        pass

    def get_code(self, **_kw):
        return SimpleNamespace(git_version="v1.29.0", major="1", minor="29", platform="linux/amd64",
                               build_date="2024-01-01", go_version="go1.21")


@pytest.fixture
def fake_k8s(monkeypatch, tmp_path):
    kc = tmp_path / "kubeconfig"
    kc.write_text("apiVersion: v1\n")
    monkeypatch.setattr(versions, "_ensure_kubeconfig_file_for", lambda _c: str(kc))
    monkeypatch.setattr(versions, "get_api_client_for_path", lambda _p: object())
    monkeypatch.setattr(versions.k8s_client, "CoreV1Api", _FakeCore)
    monkeypatch.setattr(versions.k8s_client, "VersionApi", _FakeVersion)


def test_collect_versions_reports_each_component(client, world, fake_k8s):
    cid = world["cluster"].id
    res = client.post(f"/api/v1/clusters/{cid}/collect-versions")
    assert res.status_code == 200, res.text
    body = res.json()
    comps = {c["component"]: c for c in body["components"]}
    assert set(comps) == {"k8s_server", "kubelet:node-1", "kube_apiserver", "cilium_agent"}
    assert comps["kube_apiserver"] == {"component": "kube_apiserver", "version": "v1.29.0", "changed": True}
    assert comps["cilium_agent"]["version"] == "v1.15.0"
    assert body["changed"] == sum(1 for c in body["components"] if c["changed"]) == 4
    assert body["errors"] == []

    # 같은 상태로 다시 수집하면 줄은 그대로 나오고 changed 는 전부 false.
    again = client.post(f"/api/v1/clusters/{cid}/collect-versions").json()
    assert {c["component"] for c in again["components"]} == set(comps)
    assert all(c["changed"] is False for c in again["components"])
    assert again["changed"] == 0

    # 수집 직후 그래프에 컴포넌트가 생기고 끝점 없는 엣지는 없다.
    graph = _graph(client, cid)
    _assert_no_dangling(graph)
    assert {n["id"] for n in graph["nodes"] if n["type"] == "component"} >= {"comp:kube_apiserver", "comp:cilium_agent"}


def test_collect_versions_requires_operator(client, world, db, fake_k8s):
    world["op"].role = "viewer"
    db.commit()
    res = client.post(f"/api/v1/clusters/{world['cluster'].id}/collect-versions")
    assert res.status_code == 403
