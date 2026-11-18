"""서비스 구성 1단계 — 현재 값 파서·집계, 화면 데이터·V1 가져오기(실제 DB), containerd 수집(가짜 SSH)."""
import os
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.services.service_config import current as C  # noqa: E402
from app.services.service_config.catalog_seed import ITEMS, SERVICE_KEYS  # noqa: E402

CTD_V2 = '''
version = 2
root = "/var/lib/containerd"
[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    sandbox_image = "registry.local/pause:3.9"
    max_concurrent_downloads = 3
    [plugins."io.containerd.grpc.v1.cri".containerd]
      snapshotter = "overlayfs"
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
        SystemdCgroup = true
'''
CTD_V3 = '''
version = 3
[plugins."io.containerd.cri.v1.images".pinned_images]
  sandbox = "registry.local/pause:3.10"
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runc.options]
  SystemdCgroup = false
'''


def items_for(service):
    return [SimpleNamespace(key=i["key"], source_keys=i["source_keys"]) for i in ITEMS if i["service"] == service]


def snap(component, data, minutes=0):
    return SimpleNamespace(component=component, data=data, collected_at=datetime(2026, 11, 18) - timedelta(minutes=minutes))


# ── 파서 ─────────────────────────────────────────────────────────────────────

def test_parse_env_and_flags():
    env = C.parse_env_text('# c\nexport ETCD_QUOTA_BACKEND_BYTES="8589934592"\nETCD_SNAPSHOT_COUNT=10000\nbad\n')
    assert env == {"ETCD_QUOTA_BACKEND_BYTES": "8589934592", "ETCD_SNAPSHOT_COUNT": "10000"}
    flags = C.parse_cli_flags("/usr/local/bin/etcd --heartbeat-interval=250 --election-timeout 2500 --debug")
    assert flags == {"heartbeat-interval": "250", "election-timeout": "2500", "debug": "true"}


def test_flatten_toml_v2_and_v3_paths():
    v2 = C.parse_containerd_toml(CTD_V2)
    assert v2['plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options.SystemdCgroup'] == "true"
    assert v2['plugins."io.containerd.grpc.v1.cri".sandbox_image'] == "registry.local/pause:3.9"
    assert v2["version"] == "2"
    v3 = C.parse_containerd_toml(CTD_V3)
    assert v3['plugins."io.containerd.cri.v1.images".pinned_images.sandbox'] == "registry.local/pause:3.10"


# ── 서비스별 현재 값 ─────────────────────────────────────────────────────────

def test_containerd_current_values_handle_both_config_versions():
    cur = C.current_values("containerd", [
        snap("containerd_config:10.0.0.1", {"flat": C.parse_containerd_toml(CTD_V2)}),
        snap("containerd_config:10.0.0.2", {"flat": C.parse_containerd_toml(CTD_V3)}),
        snap("kubelet_config:10.0.0.1", {"x": 1}),  # 다른 서비스 스냅샷은 무시
    ], items_for("containerd"))
    assert cur["values"]["SystemdCgroup"] == {"10.0.0.1": "true", "10.0.0.2": "false"}
    assert cur["values"]["sandbox_image"] == {"10.0.0.1": "registry.local/pause:3.9", "10.0.0.2": "registry.local/pause:3.10"}
    assert {s["node"] for s in cur["sources"]} == {"10.0.0.1", "10.0.0.2"}


def test_etcd_current_values_from_static_pod_and_systemd():
    cur = C.current_values("etcd", [
        snap("etcd", {"podName": "etcd-cp-1", "flags": {"quota-backend-bytes": "8589934592", "heartbeat-interval": "100"}}),
        snap("etcd_systemd:10.0.0.9", {"env_file": "/etc/etcd.env",
                                       "env_content": "ETCD_QUOTA_BACKEND_BYTES=2147483648\nETCD_HEARTBEAT_INTERVAL=250\n",
                                       "exec_start": "/usr/local/bin/etcd --heartbeat-interval=300"}),
    ], items_for("etcd"))
    assert cur["values"]["quota-backend-bytes"] == {"cp-1": "8589934592", "10.0.0.9": "2147483648"}
    assert cur["values"]["heartbeat-interval"]["10.0.0.9"] == "300"  # 실행 플래그가 env 보다 우선


def test_linux_prefers_agent_over_ssh_and_cilium_cluster_value():
    linux = C.current_values("linux", [
        snap("node_params:worker-1", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "4096"}}),
        snap("kernel_params:10.0.0.1", {"params": {"vm.swappiness": "60"}}),
    ], items_for("linux"))
    assert linux["values"]["vm.swappiness"] == {"worker-1": "1"}
    only_ssh = C.current_values("linux", [snap("kernel_params:10.0.0.1", {"params": {"vm.swappiness": "60"}})],
                                items_for("linux"))
    assert only_ssh["values"]["vm.swappiness"] == {"10.0.0.1": "60"}
    cil = C.current_values("cilium", [snap("cilium_config", {"data": {"routing-mode": "native", "enable-hubble": "true"}})],
                           items_for("cilium"))
    assert cil["values"]["routing-mode"] == {C.CLUSTER_NODE: "native"}


def test_summarize_and_status():
    s = C.summarize({"a": "1", "b": "1", "c": "2"})
    assert s["uniform"] is False and s["value"] == "1" and s["groups"][0]["nodes"] == ["a", "b"]
    assert C.item_status("1", s) == "mixed"
    assert C.item_status("1", C.summarize({"a": "1"})) == "same"
    assert C.item_status("2", C.summarize({"a": "1"})) == "differs"
    assert C.item_status(None, C.summarize({})) == "unknown"


def test_catalog_shape():
    assert set(SERVICE_KEYS) == {"etcd", "containerd", "cilium", "linux"}
    keys = [(i["service"], i["key"]) for i in ITEMS]
    assert len(keys) == len(set(keys))
    for i in ITEMS:
        assert i["section"] and i["source_keys"], i["key"]


# ── 화면 데이터·V1 (실제 DB) ─────────────────────────────────────────────────

@pytest.fixture
def db():
    from app.database import Base, SessionLocal, engine
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def cluster(db):
    from app.models import ClusterConfigSnapshot
    from app.models.cluster import Cluster
    from app.models.service_config import ServiceConfigVersion
    from app.services.service_config.catalog_seed import seed_catalog

    seed_catalog(db)
    c = Cluster(name=f"svc-{uuid.uuid4().hex[:8]}", api_endpoint="https://svc:6443")
    db.add(c)
    db.commit()
    yield c
    db.rollback()
    db.query(ServiceConfigVersion).filter(ServiceConfigVersion.cluster_id == c.id).delete(synchronize_session=False)
    db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == c.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


def _add_snap(db, cluster, component, data, minutes=0):
    from app.models import ClusterConfigSnapshot

    db.add(ClusterConfigSnapshot(cluster_id=cluster.id, component=component, category="os", data=data,
                                 content_hash=uuid.uuid4().hex, collected_at=datetime.utcnow() - timedelta(minutes=minutes)))
    db.commit()


def test_view_import_and_conflicts(db, cluster):
    from app.services.service_config import view as V

    # 수집 전: V1 을 만들 수 없다
    with pytest.raises(V.ServiceConfigError) as e:
        V.import_v1(db, cluster, "linux", "tester")
    assert e.value.status == 422

    # 같은 노드의 옛 스냅샷은 무시하고 최신 것만 쓴다
    _add_snap(db, cluster, "node_params:w1", {"runtime": {"vm.swappiness": "60", "net.core.somaxconn": "128"}}, minutes=30)
    _add_snap(db, cluster, "node_params:w1", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "4096"}})
    _add_snap(db, cluster, "node_params:w2", {"runtime": {"vm.swappiness": "10", "net.core.somaxconn": "4096"}})
    _add_snap(db, cluster, "node_params:w3", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "4096"}})

    view = V.build_view(db, cluster, "linux")
    assert view["version"] is None and view["nodes"] == ["w1", "w2", "w3"]
    rows = {r["key"]: r for sec in view["sections"] for r in sec["items"]}
    assert rows["net.core.somaxconn"]["status"] == "same" and rows["net.core.somaxconn"]["current"]["value"] == "4096"
    assert rows["vm.swappiness"]["status"] == "mixed"
    assert rows["kernel.panic"]["status"] == "unknown"

    out = V.import_v1(db, cluster, "linux", "tester")
    assert out["version"]["version_no"] == 1 and out["version"]["status"] == "imported"
    assert out["mixed"] == ["vm.swappiness"]
    view = V.build_view(db, cluster, "linux", 1)
    rows = {r["key"]: r for sec in view["sections"] for r in sec["items"]}
    assert rows["vm.swappiness"]["version_value"] == "1" and rows["vm.swappiness"]["status"] == "mixed"
    assert rows["net.core.somaxconn"]["status"] == "same"

    # 그 뒤 노드 값이 바뀌면 '버전과 다름'
    _add_snap(db, cluster, "node_params:w1", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "8192"}}, minutes=-1)
    _add_snap(db, cluster, "node_params:w2", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "8192"}}, minutes=-1)
    _add_snap(db, cluster, "node_params:w3", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "8192"}}, minutes=-1)
    rows = {r["key"]: r for sec in V.build_view(db, cluster, "linux")["sections"] for r in sec["items"]}
    assert rows["net.core.somaxconn"]["status"] == "differs"

    with pytest.raises(V.ServiceConfigError) as e:
        V.import_v1(db, cluster, "linux", "tester")
    assert e.value.status == 409
    with pytest.raises(V.ServiceConfigError) as e:
        V.build_view(db, cluster, "nope")
    assert e.value.status == 404


def test_api_requires_operator_for_import(db, cluster):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    _add_snap(db, cluster, "cilium_config", {"data": {"routing-mode": "tunnel"}})
    viewer = SimpleNamespace(id=uuid.uuid4(), username="v", role="viewer", is_active=True, tenant_ids=[])
    app.dependency_overrides[get_current_user] = lambda: viewer
    try:
        client = TestClient(app)
        r = client.get("/api/v1/service-config/services")
        assert r.status_code == 200 and [s["key"] for s in r.json()["items"]] == ["etcd", "containerd", "cilium", "linux"]
        r = client.get(f"/api/v1/service-config/clusters/{cluster.id}/cilium")
        assert r.status_code == 200, r.text
        assert r.json()["counts"]["same"] >= 1
        r = client.post(f"/api/v1/service-config/clusters/{cluster.id}/cilium/import")
        assert r.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── containerd 수집(가짜 SSH) ────────────────────────────────────────────────

async def test_collect_containerd_config_dump_and_file_fallback(db, cluster, monkeypatch):
    from app.models import ClusterConfigSnapshot
    from app.routers import versions as VR
    from app.services.ssh_runner import SSHResult

    def fake_exec(target, cmd, connect_timeout=8, exec_timeout=20):
        def res(status, rc, out):
            return SSHResult(host=target.host, status=status, exit_code=rc, stdout=out, stderr="", duration_ms=1, error=None)
        if target.host == "10.0.0.3":
            return SSHResult(host=target.host, status="connect_error", exit_code=None, stdout="", stderr="",
                             duration_ms=1, error="connection refused")
        if "config dump" in cmd:
            return res("ok", 0, CTD_V2) if target.host == "10.0.0.1" else res("error", 127, "containerd: not found")
        return res("ok", 0, "===CTD_FILE===:/etc/containerd/config.toml\n" + CTD_V3)

    monkeypatch.setattr(VR, "_exec_ssh", fake_exec)
    payload = VR.ContainerdConfigCollectRequest(hosts=["10.0.0.1", "10.0.0.2", "10.0.0.3"], password="x")
    out = await VR.collect_containerd_config(cluster.id, payload, db=db, _=None)
    by = {h["host"]: h for h in out["hosts"]}
    assert by["10.0.0.1"]["source_label"] == "containerd config dump"
    assert by["10.0.0.2"]["source_label"] == "file:/etc/containerd/config.toml"
    assert by["10.0.0.3"]["status"] == "connect_error" and out["changed"] == 2
    snaps = db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id,
                                                    ClusterConfigSnapshot.component.like("containerd_config:%")).all()
    assert len(snaps) == 2

    from app.services.service_config import view as V
    rows = {r["key"]: r for sec in V.build_view(db, cluster, "containerd")["sections"] for r in sec["items"]}
    assert rows["SystemdCgroup"]["status"] == "mixed"
