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
    assert list(SERVICE_KEYS) == ["etcd", "containerd", "cilium", "linux", "kube-apiserver", "kube-controller-manager", "kube-scheduler", "kubelet"]
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
        assert r.status_code == 200 and [s["key"] for s in r.json()["items"]] == ["etcd", "containerd", "cilium", "linux", "kube-apiserver", "kube-controller-manager", "kube-scheduler", "kubelet"]
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


# ── 2단계: 의존 규칙(순수) ───────────────────────────────────────────────────

def _rules():
    from app.services.service_config.catalog_seed import RULES

    return [SimpleNamespace(id=uuid.uuid4(), enabled=True, params=r.get("params"), target_service=r.get("target_service"),
                            target_key=r.get("target_key"), **{k: r[k] for k in ("rule_key", "service", "key", "kind",
                                                                                  "rule_type", "reason")})
            for r in RULES]


def test_rules_recommend_only_when_touched_and_require_blocks():
    from app.services.service_config import rules as RU

    linux = {"net.core.somaxconn": "8192", "net.ipv4.tcp_max_syn_backlog": "4096", "net.ipv4.ip_forward": "1"}
    vals = {"linux": linux, "cilium": {"routing-mode": "tunnel"}}
    # somaxconn 을 바꾸면 SYN 백로그 제안
    res = RU.evaluate(_rules(), "linux", vals, {"net.core.somaxconn"})
    rec = [r for r in res if r["rule_key"] == "linux.syn_backlog_ge_somaxconn"]
    assert rec and rec[0]["suggested"] == "8192" and rec[0]["fixable_here"] and not rec[0]["blocking"]
    # 아무것도 안 바꿨으면 제안 없음(기존 상태 잡음 방지)
    assert not [r for r in RU.evaluate(_rules(), "linux", vals, set()) if r["kind"] == "recommend"]
    # ip_forward=0 으로 바꾸면 CILIUM 규칙이 저장을 막는다
    bad = {**vals, "linux": {**linux, "net.ipv4.ip_forward": "0"}}
    req = [r for r in RU.evaluate(_rules(), "linux", bad, {"net.ipv4.ip_forward"}) if r["kind"] == "require"]
    assert req and req[0]["blocking"] and req[0]["suggested"] == "1"
    # CILIUM 화면에서 보면 같은 위반은 다른 서비스에서 고칠 것이라 막지 않는다
    req2 = [r for r in RU.evaluate(_rules(), "cilium", bad, {"routing-mode"}) if r["rule_key"] == "cilium.requires_ip_forward"]
    assert req2 and not req2[0]["blocking"]
    # CILIUM 을 관리하지 않으면(값 없음) ip_forward 조건도 없다
    assert not RU.evaluate(_rules(), "linux", {"linux": bad["linux"]}, {"net.ipv4.ip_forward"})


def test_rules_etcd_and_cilium_requires_when():
    from app.services.service_config import rules as RU

    res = RU.evaluate(_rules(), "etcd", {"etcd": {"heartbeat-interval": "250", "election-timeout": "1000",
                                                  "quota-backend-bytes": "17179869184"}},
                      {"heartbeat-interval", "quota-backend-bytes"})
    by = {r["rule_key"]: r for r in res}
    assert by["etcd.election_ge_5x_heartbeat"]["blocking"] and by["etcd.election_ge_5x_heartbeat"]["suggested"] == "1250"
    assert by["etcd.election_10x_heartbeat"]["suggested"] == "2500"
    assert by["etcd.quota_max_8gib"]["suggested"] == "8589934592"
    assert by["etcd.quota_defrag_check"]["kind"] == "impact"
    res = RU.evaluate(_rules(), "cilium", {"cilium": {"kube-proxy-replacement": "true", "routing-mode": "native",
                                                      "k8s-service-port": "6443"}}, {"kube-proxy-replacement"})
    by = {r["rule_key"]: r for r in res}
    assert by["cilium.kpr_requires_host"]["blocking"]
    assert "cilium.kpr_requires_port" not in by
    assert not by["cilium.native_requires_cidr"]["blocking"]  # 이번 편집과 무관한 기존 위반은 경고만
    assert "cilium.restart_notice" in by


# ── 2단계: 저장·비교·되돌리기·그룹(실제 DB) ──────────────────────────────────

@pytest.fixture
def linux_v1(db, cluster):
    from app.models.service_config import ServiceConfigGroup
    from app.services.service_config import view as V
    from app.services.service_config.catalog_seed import seed_rules

    seed_rules(db)
    for n, (sw, sm) in {"w1": ("1", "4096"), "w2": ("1", "4096"), "gpu-1": ("10", "4096")}.items():
        _add_snap(db, cluster, f"node_params:{n}", {"runtime": {"vm.swappiness": sw, "net.core.somaxconn": sm,
                                                               "net.ipv4.tcp_max_syn_backlog": "4096",
                                                               "net.ipv4.ip_forward": "1"}})
    _add_snap(db, cluster, "cilium_config", {"data": {"routing-mode": "tunnel"}})  # CILIUM 이 있어야 ip_forward 조건이 걸린다
    V.import_v1(db, cluster, "linux", "tester")
    yield cluster
    db.query(ServiceConfigGroup).filter(ServiceConfigGroup.cluster_id == cluster.id).delete(synchronize_session=False)
    db.commit()


def test_save_compare_revert_flow(db, linux_v1):
    from app.services.service_config import view as V

    c = linux_v1
    v1 = V.build_view(db, c, "linux")["version"]["version_no"]
    draft = {**{k: v for k, v in V.list_versions(db, c.id, "linux")[0].values.items()}, "net.core.somaxconn": "8192"}
    ev = V.evaluate_draft(db, c, "linux", None, draft)
    assert ev["changed"] == ["net.core.somaxconn"]
    assert any(r["rule_key"] == "linux.syn_backlog_ge_somaxconn" for r in ev["results"])

    with pytest.raises(V.ServiceConfigError) as e:  # 낙관적 잠금
        V.save_version(db, c, "linux", None, 0, draft, "x", "tester")
    assert e.value.status == 409
    with pytest.raises(V.ServiceConfigError) as e:  # 필수 위반
        V.save_version(db, c, "linux", None, v1, {**draft, "net.ipv4.ip_forward": "0"}, None, "tester")
    assert e.value.status == 422 and e.value.detail["violations"][0]["target_key"] == "net.ipv4.ip_forward"
    with pytest.raises(V.ServiceConfigError) as e:  # 바뀐 것 없음
        V.save_version(db, c, "linux", None, v1, dict(V.list_versions(db, c.id, "linux")[0].values), None, "tester")
    assert e.value.status == 422

    out = V.save_version(db, c, "linux", None, v1, {**draft, "net.ipv4.tcp_max_syn_backlog": "8192"}, "백로그 상향", "tester")
    assert out["version"]["version_no"] == 2 and out["version"]["status"] == "saved"
    view = V.build_view(db, c, "linux")
    assert view["pending"]["count"] == 2 and view["pending"]["baseline_version_no"] == 1
    rows = {r["key"]: r for s in view["sections"] for r in s["items"]}
    assert rows["net.core.somaxconn"]["status"] == "differs"  # 노드는 아직 4096

    out3 = V.save_version(db, c, "linux", None, 2, {**draft, "net.ipv4.tcp_max_syn_backlog": "16384"}, None, "tester")
    statuses = {v.version_no: v.status for v in V.list_versions(db, c.id, "linux")}
    assert statuses == {3: "saved", 2: "superseded", 1: "imported"} and out3["version"]["version_no"] == 3

    cmp = V.compare_versions(db, c, "linux", None, 1, 3)
    assert {r["key"]: r["change"] for r in cmp["rows"]} == {"net.core.somaxconn": "changed", "net.ipv4.tcp_max_syn_backlog": "changed"}
    rv = V.revert_to(db, c, "linux", None, 1, "tester")
    assert rv["version"]["version_no"] == 4 and "V1" in rv["version"]["note"]
    assert V.build_view(db, c, "linux")["pending"]["count"] == 0


def test_groups_override_and_membership(db, linux_v1):
    from app.services.service_config import view as V

    c = linux_v1
    g = V.save_group(db, c, "linux", None, "GPU", "gpu-*", "GPU 노드", "tester")
    with pytest.raises(V.ServiceConfigError) as e:
        V.save_group(db, c, "linux", None, "GPU", "x-*", None, "tester")
    assert e.value.status == 409
    with pytest.raises(V.ServiceConfigError) as e:
        V.save_group(db, c, "cilium", None, "A", "a*", None, "tester")
    assert e.value.status == 422

    base = V.build_view(db, c, "linux")
    assert base["default_nodes"] == ["w1", "w2"] and base["groups"][0]["nodes"] == ["gpu-1"]
    rows = {r["key"]: r for s in base["sections"] for r in s["items"]}
    assert rows["vm.swappiness"]["status"] == "same"  # gpu-1(10) 은 기본 그룹 집계에서 빠진다

    gv = V.build_view(db, c, "linux", group_id=g.id)
    rows = {r["key"]: r for s in gv["sections"] for r in s["items"]}
    assert rows["vm.swappiness"]["inherited"] and rows["vm.swappiness"]["status"] == "differs"  # 기본 1 상속, 노드 10
    out = V.save_version(db, c, "linux", g.id, 0, {"vm.swappiness": "10"}, "GPU 스왑 허용", "tester")
    assert out["version"]["version_no"] == 1 and out["version"]["group_id"] == str(g.id)
    rows = {r["key"]: r for s in V.build_view(db, c, "linux", group_id=g.id)["sections"] for r in s["items"]}
    assert rows["vm.swappiness"]["override_value"] == "10" and rows["vm.swappiness"]["status"] == "same"
    assert not rows["net.core.somaxconn"]["override_value"] and rows["net.core.somaxconn"]["inherited"]

    assert V.delete_group(db, c, "linux", g.id) == "GPU"
    assert V.list_versions(db, c.id, "linux", g.id) == []


def test_api_evaluate_allowed_for_viewer_but_save_forbidden(db, linux_v1):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    c = linux_v1
    viewer = SimpleNamespace(id=uuid.uuid4(), username="v", role="viewer", is_active=True, tenant_ids=[])
    app.dependency_overrides[get_current_user] = lambda: viewer
    try:
        client = TestClient(app)
        r = client.post("/api/v1/service-config/evaluate",
                        json={"cluster_id": str(c.id), "service": "linux", "values": [{"key": "net.core.somaxconn", "value": "9999"}]})
        assert r.status_code == 200, r.text
        r = client.post(f"/api/v1/service-config/clusters/{c.id}/linux/versions",
                        json={"base_version_no": 1, "values": [{"key": "net.core.somaxconn", "value": "9999"}]})
        assert r.status_code == 403
        r = client.get(f"/api/v1/service-config/clusters/{c.id}/linux/versions/compare?a=1&b=1")
        assert r.status_code == 200 and r.json()["rows"] == []
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── 3단계: 적용(OS·CILIUM) ───────────────────────────────────────────────────

def test_validate_pairs_and_render():
    from app.services.service_config import apply as A

    ok = A.validate_pairs({"net.core.somaxconn": "8192", "net.ipv4.ip_local_port_range": "10000  65000"})
    assert ok["net.ipv4.ip_local_port_range"] == "10000 65000"
    assert A.validate_pairs({"vm.swappiness": "1\n2"}) == {"vm.swappiness": "1 2"}  # 줄바꿈은 공백으로 정규화돼 줄을 끼워 넣을 수 없다
    for bad in ("1; reboot", "$(id)", "a'b", "`x`", 'a"b', "1|2", "x>y"):
        with pytest.raises(A.ApplyError):
            A.validate_pairs({"vm.swappiness": bad})
    with pytest.raises(A.ApplyError):
        A.validate_pairs({"vm swappiness": "1"})
    text = A.render_sysctl_file(ok, cluster_name="c", version_no=3, group_name="기본")
    assert "net.core.somaxconn = 8192\n" in text and text.startswith("# PEP")


class FakeNodes:
    """노드별 커널 값·관리 파일을 흉내 내는 가짜 SSH."""

    def __init__(self, nodes, broken=(), ignore_writes=()):
        self.state = {n: {"net.core.somaxconn": "4096", "net.ipv4.tcp_max_syn_backlog": "4096",
                          "net.ipv4.ip_forward": "1", "vm.swappiness": "1"} for n in nodes}
        self.files = {}
        self.broken = set(broken)
        self.ignore = set(ignore_writes)
        self.cmds = []

    def __call__(self, target, cmd, connect_timeout=8, exec_timeout=30):
        from app.services.ssh_runner import SSHResult

        h = target.host
        self.cmds.append((h, cmd))
        if h in self.broken:
            return SSHResult(host=h, status="connect_error", exit_code=None, stdout="", stderr="", duration_ms=1,
                             error="connection refused")
        ok = lambda out="": SSHResult(host=h, status="ok", exit_code=0, stdout=out, stderr="", duration_ms=1, error=None)  # noqa: E731
        if "sysctl -e" in cmd:
            keys = cmd.split("sysctl -e", 1)[1].split()
            return ok("\n".join(f"{k} = {self.state[h].get(k)}" for k in keys if k in self.state[h]))
        if " tee " in cmd or cmd.startswith("tee "):
            self.files[h] = cmd.split("<<'PEP_SYSCTL_EOF'\n", 1)[1].rsplit("PEP_SYSCTL_EOF", 1)[0]
            return ok()
        if "sysctl -p" in cmd:
            if h not in self.ignore:
                for line in self.files.get(h, "").splitlines():
                    if "=" in line and not line.startswith("#"):
                        k, v = line.split("=", 1)
                        self.state[h][k.strip()] = v.strip()
            return ok("applied")
        if "sysctl -w" in cmd:
            if h not in self.ignore:
                for pair in cmd.split("sysctl -w", 1)[1].split():
                    k, v = pair.split("=", 1)
                    self.state[h][k] = v.strip("'")
            return ok()
        return ok()


def _save_v2(db, c):
    from app.services.service_config import view as V

    vals = dict(V.list_versions(db, c.id, "linux")[0].values)
    vals.update({"net.core.somaxconn": "8192", "net.ipv4.tcp_max_syn_backlog": "8192"})
    return V.save_version(db, c, "linux", None, 1, vals, "상향", "tester")["version"]["version_no"]


async def _run_apply(db, c, service, plan, opts, creds=None):
    from app.services.service_config import apply as A

    run = A.start_run(db, c, service, plan, opts, "tester")
    return await A.execute(db, c, run.id, plan, opts, creds or {"username": "root", "password": "x"}, lambda e: None)


async def test_apply_os_success_marks_applied_and_updates_watch_rules(db, linux_v1, monkeypatch):
    from app.models.node_param_watch import NodeParamWatchRule
    from app.models.service_config import ServiceConfigApplyRun
    from app.services import ssh_runner
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    c = linux_v1
    fake = FakeNodes(["w1", "w2", "gpu-1"])
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    v2 = _save_v2(db, c)
    plan = A.plan_apply(db, c, "linux", v2, None)
    assert [t["node"] for t in plan["targets"]] == ["gpu-1", "w1", "w2"]
    assert {ch["key"] for ch in plan["changes"]} == {"net.core.somaxconn", "net.ipv4.tcp_max_syn_backlog"}
    try:
        out = await _run_apply(db, c, "linux", plan, {"batch_size": 2, "pause_sec": 0})
        assert out["status"] == "succeeded", out
        assert all(r["status"] == "ok" and r["after"]["net.core.somaxconn"] == "8192" for r in out["node_results"])
        assert "net.core.somaxconn = 8192" in fake.files["w1"]
        assert any("cp -p /etc/sysctl.d/99-zz-pep.conf" in cmd for _, cmd in fake.cmds)
        assert V.list_versions(db, c.id, "linux")[0].status == "applied"
        assert V.build_view(db, c, "linux")["pending"] is None
        rule = db.query(NodeParamWatchRule).filter(NodeParamWatchRule.cluster_id == c.id,
                                                   NodeParamWatchRule.param == "net.core.somaxconn").one()
        assert rule.operator == "eq" and rule.expected == "8192" and rule.created_by == "service-config"
        run = db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == c.id).one()
        assert "password" not in str(run.options) and "x" not in (run.options or {}).values()
        assert any("확인 4/4" in line[2] or "일치" in line[2] for line in run.log_lines)
    finally:
        db.query(NodeParamWatchRule).filter(NodeParamWatchRule.cluster_id == c.id).delete(synchronize_session=False)
        db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == c.id).delete(synchronize_session=False)
        db.commit()


async def test_apply_os_failures_stop_partial_and_verify(db, linux_v1, monkeypatch):
    from app.models.service_config import ServiceConfigApplyRun
    from app.services import ssh_runner
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    c = linux_v1
    v2 = _save_v2(db, c)
    try:
        # 첫 노드 접속 실패 + 실패 시 중단 → 나머지 건너뜀, failed
        monkeypatch.setattr(ssh_runner, "_exec_ssh", FakeNodes(["w1", "w2", "gpu-1"], broken={"gpu-1"}))
        out = await _run_apply(db, c, "linux", A.plan_apply(db, c, "linux", v2, None), {"batch_size": 1, "pause_sec": 0})
        assert out["status"] == "failed" and [r["status"] for r in out["node_results"]] == ["failed", "skipped", "skipped"]
        assert V.list_versions(db, c.id, "linux")[0].status == "saved"
        # 실패해도 계속 → partial
        monkeypatch.setattr(ssh_runner, "_exec_ssh", FakeNodes(["w1", "w2", "gpu-1"], broken={"gpu-1"}))
        out = await _run_apply(db, c, "linux", A.plan_apply(db, c, "linux", v2, None),
                               {"batch_size": 1, "pause_sec": 0, "stop_on_failure": False})
        assert out["status"] == "partial"
        # 다시 읽은 값이 다르면 실패
        monkeypatch.setattr(ssh_runner, "_exec_ssh", FakeNodes(["w1", "w2", "gpu-1"], ignore_writes={"w2"}))
        out = await _run_apply(db, c, "linux", A.plan_apply(db, c, "linux", v2, None, "nodes", ["w2"]),
                               {"batch_size": 1, "pause_sec": 0, "persist": False})
        assert out["status"] == "failed" and "다시 읽은 값" in out["node_results"][0]["error"]
        # 고른 노드만 성공 → 버전은 저장됨 유지
        monkeypatch.setattr(ssh_runner, "_exec_ssh", FakeNodes(["w1", "w2", "gpu-1"]))
        out = await _run_apply(db, c, "linux", A.plan_apply(db, c, "linux", v2, None, "nodes", ["w1"]),
                               {"batch_size": 1, "pause_sec": 0, "update_watch_rules": True})
        assert out["status"] == "succeeded" and V.list_versions(db, c.id, "linux")[0].status == "saved"
        with pytest.raises(A.ApplyError):
            A.plan_apply(db, c, "linux", v2, None, "nodes", ["nope"])
    finally:
        db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == c.id).delete(synchronize_session=False)
        db.commit()


async def test_apply_conflict_and_stop(db, linux_v1, monkeypatch):
    from app.models.service_config import ServiceConfigApplyRun
    from app.services import ssh_runner
    from app.services.service_config import apply as A

    c = linux_v1
    v2 = _save_v2(db, c)
    monkeypatch.setattr(ssh_runner, "_exec_ssh", FakeNodes(["w1", "w2", "gpu-1"]))
    plan = A.plan_apply(db, c, "linux", v2, None)
    try:
        run = A.start_run(db, c, "linux", plan, {"batch_size": 1}, "tester")
        with pytest.raises(A.ApplyError) as e:
            A.start_run(db, c, "linux", plan, {"batch_size": 1}, "tester")
        assert e.value.status == 409
        run.stop_requested = True
        db.commit()
        out = await A.execute(db, c, run.id, plan, {"batch_size": 1, "pause_sec": 0}, {"password": "x"}, lambda e: None)
        assert out["status"] == "stopped" and all(r["status"] == "skipped" for r in out["node_results"])
        with pytest.raises(A.ApplyError) as e:
            A.start_run(db, c, "kafka", {**plan, "service": {"label": "KAFKA"}}, {}, "tester")
        assert e.value.status == 422
    finally:
        db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == c.id).delete(synchronize_session=False)
        db.commit()


class FakeK8s:
    def __init__(self, data, ready_after=2):
        self.data = dict(data)
        self.patches = []
        self.restarts = 0
        self.reads = 0
        self.ready_after = ready_after

    def read_namespaced_config_map(self, name, ns, **_):
        return SimpleNamespace(data=dict(self.data))

    def patch_namespaced_config_map(self, name, ns, body, **_):
        self.patches.append(body)
        self.data.update(body["data"])

    def patch_namespaced_daemon_set(self, name, ns, body, **_):
        self.restarts += 1

    def read_namespaced_daemon_set(self, name, ns, **_):
        self.reads += 1
        done = self.reads >= self.ready_after
        return SimpleNamespace(metadata=SimpleNamespace(generation=2),
                               status=SimpleNamespace(desired_number_scheduled=3, observed_generation=2,
                                                      updated_number_scheduled=3 if done else 1,
                                                      number_available=3 if done else 2))


async def test_apply_cilium_patch_restart_and_snapshot(db, linux_v1, monkeypatch):
    from app.models.service_config import ServiceConfigApplyRun
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    c = linux_v1
    V.import_v1(db, c, "cilium", "tester")
    v1 = dict(V.list_versions(db, c.id, "cilium")[0].values)
    V.save_version(db, c, "cilium", None, 1, {**v1, "routing-mode": "tunnel", "enable-hubble": "true"}, None, "tester")
    k8s = FakeK8s({"routing-mode": "tunnel"})
    monkeypatch.setattr(A, "k8s_apis", lambda cluster: (k8s, k8s))
    try:
        plan = A.plan_apply(db, c, "cilium", None, None)
        assert plan["targets"][0]["node"] == "(클러스터)"
        out = await _run_apply(db, c, "cilium", plan, {"restart": True, "poll_sec": 0.01})
        assert out["status"] == "succeeded", out
        assert k8s.patches == [{"data": {"enable-hubble": "true"}}] and k8s.restarts == 1
        rows = {r["key"]: r for s in V.build_view(db, c, "cilium")["sections"] for r in s["items"]}
        assert rows["enable-hubble"]["current"]["value"] == "true"  # 스냅샷 갱신
        assert V.list_versions(db, c.id, "cilium")[0].status == "applied"
        # 롤아웃이 제한 시간 안에 끝나지 않으면 실패
        V.save_version(db, c, "cilium", None, 2, {**v1, "routing-mode": "tunnel", "enable-hubble": "false"}, None, "tester")
        slow = FakeK8s(dict(k8s.data), ready_after=10_000)
        monkeypatch.setattr(A, "k8s_apis", lambda cluster: (slow, slow))
        out = await _run_apply(db, c, "cilium", A.plan_apply(db, c, "cilium", None, None),
                               {"restart": True, "poll_sec": 0.05, "rollout_timeout_sec": 1})
        assert out["status"] == "failed" and "롤아웃" in out["node_results"][0]["error"]
    finally:
        db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == c.id).delete(synchronize_session=False)
        db.commit()


def test_apply_api_guards(db, linux_v1):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    c = linux_v1
    op = SimpleNamespace(id=uuid.uuid4(), username="op", role="operator", is_active=True, tenant_ids=[])
    app.dependency_overrides[get_current_user] = lambda: op
    try:
        client = TestClient(app)
        r = client.get(f"/api/v1/service-config/clusters/{c.id}/linux/apply/plan")
        assert r.status_code == 200 and len(r.json()["targets"]) == 3
        r = client.post(f"/api/v1/service-config/clusters/{c.id}/linux/apply/stream", json={})
        assert r.status_code == 422 and "SSH" in r.json()["detail"]
        r = client.put("/api/v1/service-config/settings", json={"sysctl_file": "/etc/x.conf"})
        assert r.status_code == 403
        assert client.get("/api/v1/service-config/settings").json()["sysctl_file"].startswith("/etc/sysctl.d/")
    finally:
        app.dependency_overrides.pop(get_current_user, None)



# ── 4단계: ETCD·CONTAINERD 적용 ──────────────────────────────────────────────

ETCD_MANIFEST = """apiVersion: v1
kind: Pod
metadata:
  name: etcd
  namespace: kube-system
spec:
  containers:
  - command:
    - etcd
    - --advertise-client-urls=https://10.0.0.1:2379
    - --quota-backend-bytes=2147483648
    - --data-dir=/var/lib/etcd
    image: registry.k8s.io/etcd:3.5.15-0
    name: etcd
  hostNetwork: true
"""


def test_edit_etcd_manifest_replace_insert_and_verify():
    from app.services.service_config import apply_nodes as AN

    out = AN.edit_etcd_manifest(ETCD_MANIFEST, {"quota-backend-bytes": "8589934592", "snapshot-count": "5000",
                                                "listen-metrics-urls": "http://127.0.0.1:2381"})
    lines = out.splitlines()
    assert "    - --quota-backend-bytes=8589934592" in lines
    # 새 플래그는 마지막 플래그 줄 뒤에 같은 들여쓰기로, 다른 줄은 그대로
    i = lines.index("    - --data-dir=/var/lib/etcd")
    assert lines[i + 1].startswith("    - --") and "snapshot-count=5000" in out
    assert "image: registry.k8s.io/etcd:3.5.15-0" in out and out.count("\n") == ETCD_MANIFEST.count("\n") + 2
    assert AN.manifest_flags(out)["listen-metrics-urls"] == "http://127.0.0.1:2381"
    # 공백이 든 값은 따옴표로 감싸 YAML 이 깨지지 않게
    out2 = AN.edit_etcd_manifest(ETCD_MANIFEST, {"log-level": "a b: c"})
    assert AN.manifest_flags(out2)["log-level"] == "a b: c"
    with pytest.raises(AN.EditError):
        AN.edit_etcd_manifest("apiVersion: v1\nkind: Pod\n", {"snapshot-count": "1"})


def test_edit_env_file():
    from app.services.service_config import apply_nodes as AN

    out = AN.edit_env_file("# etcd\nexport ETCD_SNAPSHOT_COUNT=10000\nETCD_NAME=cp-1\n",
                           {"ETCD_SNAPSHOT_COUNT": "5000", "ETCD_LOG_LEVEL": "warn"})
    assert out == "# etcd\nexport ETCD_SNAPSHOT_COUNT=5000\nETCD_NAME=cp-1\nETCD_LOG_LEVEL=warn\n"
    assert AN.edit_env_file("", {"ETCD_X": "a b"}) == 'ETCD_X="a b"\n'


def test_edit_containerd_toml_v2_v3_and_reject():
    from app.services.service_config import apply_nodes as AN

    cri = 'plugins."io.containerd.grpc.v1.cri"'
    out = AN.edit_containerd_toml(CTD_V2, {
        f"{cri}.sandbox_image": ("registry.local/pause:3.10", "string"),
        f"{cri}.containerd.runtimes.runc.options.SystemdCgroup": ("false", "bool"),
        f"{cri}.enable_unprivileged_ports": ("true", "bool"),           # 있는 테이블에 추가
        f"{cri}.registry.config_path": ("/etc/containerd/certs.d", "string"),  # 테이블 새로 만듦
        "oom_score": ("-999", "int"),                                     # 최상위 키
    })
    flat = C.parse_containerd_toml(out)
    assert flat[f"{cri}.sandbox_image"] == "registry.local/pause:3.10"
    assert flat[f"{cri}.containerd.runtimes.runc.options.SystemdCgroup"] == "false"
    assert flat[f"{cri}.enable_unprivileged_ports"] == "true" and flat["oom_score"] == "-999"
    assert flat[f"{cri}.registry.config_path"] == "/etc/containerd/certs.d"
    assert '        SystemdCgroup = false' in out.splitlines()  # 들여쓰기 보존
    assert flat[f"{cri}.max_concurrent_downloads"] == "3"            # 손대지 않은 값 그대로
    # 경로 고르기 — 있는 경로 → 파일 version 에 맞는 후보
    paths = [f"{cri}.containerd.snapshotter", 'plugins."io.containerd.cri.v1.images".snapshotter']
    assert AN.choose_containerd_path(paths, C.parse_containerd_toml(CTD_V3)) == paths[1]
    assert AN.choose_containerd_path(paths, {"version": "2"}) == paths[0]
    with pytest.raises(AN.EditError):
        AN.choose_containerd_path(paths, {})
    with pytest.raises(AN.EditError):
        AN.render_toml_value("yes", "bool")
    # 인라인 테이블과 충돌 → 재해석 실패 → 쓰지 않음
    with pytest.raises(AN.EditError):
        AN.edit_containerd_toml('version = 2\n[a]\nb = {c = 1}\n', {"a.b.d": ("1", "int")})


def test_apply_settings_validation(db):
    from app.services.service_config import apply as A

    with pytest.raises(A.ApplyError):
        A.set_settings(db, {"etcd_health_cmd": "curl x\nrm -rf /"})
    with pytest.raises(A.ApplyError):
        A.set_settings(db, {"etcd_backup_dir": "/etc/kubernetes/manifests/bak"})
    with pytest.raises(A.ApplyError):
        A.set_settings(db, {"etcd_mode": "docker"})
    assert A._normalize_settings({"etcd_health_cmd": "a\tb", "node_ready_timeout_sec": 5})["node_ready_timeout_sec"] == 300


def _ok(h, out=""):
    from app.services.ssh_runner import SSHResult

    return SSHResult(host=h, status="ok", exit_code=0, stdout=out, stderr="", duration_ms=1, error=None)


def _fail(h, out=""):
    from app.services.ssh_runner import SSHResult

    return SSHResult(host=h, status="error", exit_code=1, stdout=out, stderr="fail", duration_ms=1, error=None)


class FakeEtcd:
    """정적 파드 etcd 노드 흉내 — 매니페스트 기록 시 '재시작'해 실행 플래그가 바뀐다. crash 노드는 새 설정으로 뜨지 못한다."""
    MANIFEST = "/etc/kubernetes/manifests/etcd.yaml"

    def __init__(self, hosts, unhealthy=(), crash=()):
        self.files = {h: {self.MANIFEST: ETCD_MANIFEST} for h in hosts}
        self.running = {h: ETCD_MANIFEST for h in hosts}
        self.unhealthy, self.crash = set(unhealthy), set(crash)
        self.cmds = []

    def __call__(self, target, cmd, connect_timeout=8, exec_timeout=30):
        from app.services.service_config import apply_nodes as AN

        h = target.host
        self.cmds.append((h, cmd))
        f = self.files[h]
        if "/health" in cmd:
            ok = h not in self.unhealthy and self.running[h] is not None
            return _ok(h, '{"health":"true","reason":""}') if ok else _fail(h, '{"health":"false"}')
        if "test -f" in cmd:
            return _ok(h, "static_pod")
        if "pgrep" in cmd:
            if self.running[h] is None:
                return _ok(h, "")
            fl = AN.manifest_flags(self.running[h])
            return _ok(h, "etcd " + " ".join(f"--{k}={v}" for k, v in fl.items()))
        if "<<'PEP_CFG_EOF'" in cmd:
            path = cmd.split("tee ", 1)[1].split(" ", 1)[0]
            f[path] = cmd.split("<<'PEP_CFG_EOF'\n", 1)[1].rsplit("PEP_CFG_EOF", 1)[0]
            self.running[h] = None if h in self.crash else f[path]
            return _ok(h)
        if "cp -p" in cmd:
            src, dst = cmd.split("cp -p ", 1)[1].split()[:2]
            f[dst] = f[src]
            if dst == self.MANIFEST:  # 복원 → kubelet 이 이전 매니페스트로 다시 띄움
                self.running[h] = f[dst]
            return _ok(h)
        if cmd.startswith("cat "):
            return _ok(h, f.get(cmd.split()[1], ""))
        return _ok(h)


class FakeCore:
    """K8S CoreV1Api 흉내 — etcd 파드 목록, 노드(cordon·Ready), 파드·eviction."""

    def __init__(self, events=None, ready_after=1, pods=()):
        self.events = events if events is not None else []
        self.unsched = {}
        self.ready_reads = 0
        self.ready_after = ready_after
        self.pods = list(pods)

    def list_namespaced_pod(self, ns, label_selector=None, **_):
        return SimpleNamespace(items=[SimpleNamespace(spec=SimpleNamespace(node_name=f"cp-{i}"),
                                                      status=SimpleNamespace(host_ip=f"10.0.0.{i}")) for i in (1, 2, 3)])

    def list_node(self, **_):
        return SimpleNamespace(items=[SimpleNamespace(metadata=SimpleNamespace(name=n),
                                                      status=SimpleNamespace(addresses=[SimpleNamespace(address=a)]))
                                      for n, a in (("node-a", "10.0.1.1"), ("node-b", "10.0.1.2"))])

    def read_node(self, name, **_):
        self.ready_reads += 1
        ready = "True" if self.ready_reads >= self.ready_after else "False"
        return SimpleNamespace(spec=SimpleNamespace(unschedulable=self.unsched.get(name, False)),
                               status=SimpleNamespace(conditions=[SimpleNamespace(type="Ready", status=ready)]))

    def patch_node(self, name, body, **_):
        self.unsched[name] = body["spec"]["unschedulable"]
        self.events.append(("cordon" if self.unsched[name] else "uncordon", name))

    def list_pod_for_all_namespaces(self, field_selector=None, **_):
        return SimpleNamespace(items=list(self.pods))

    def create_namespaced_pod_eviction(self, name, ns, body, **_):
        self.events.append(("evict", name))
        self.pods = [p for p in self.pods if p.metadata.name != name]


def _pod(name, kind=None):
    owners = [SimpleNamespace(kind=kind)] if kind else []
    return SimpleNamespace(metadata=SimpleNamespace(name=name, namespace="default", annotations={}, owner_references=owners),
                           status=SimpleNamespace(phase="Running"))


@pytest.fixture
def etcd_v2(db, cluster, monkeypatch):
    from app.models.service_config import ServiceConfigApplyRun
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    core = FakeCore()
    monkeypatch.setattr(A, "k8s_apis", lambda c: (core, core))
    _add_snap(db, cluster, "etcd", {"podName": "etcd-cp-1", "flags": {"quota-backend-bytes": "2147483648"}})
    V.import_v1(db, cluster, "etcd", "tester")
    vals = dict(V.list_versions(db, cluster.id, "etcd")[0].values)
    V.save_version(db, cluster, "etcd", None, 1, {**vals, "quota-backend-bytes": "8589934592"}, None, "tester")
    yield cluster
    db.rollback()
    db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == cluster.id).delete(synchronize_session=False)
    db.commit()


async def test_apply_etcd_static_pod_success_one_by_one(db, etcd_v2, monkeypatch):
    from app.services import ssh_runner
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    c = etcd_v2
    fake = FakeEtcd(["10.0.0.1", "10.0.0.2", "10.0.0.3"])
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    plan = A.plan_apply(db, c, "etcd", None, None)
    assert [(t["node"], t["host"]) for t in plan["targets"]] == [("cp-1", "10.0.0.1"), ("cp-2", "10.0.0.2"), ("cp-3", "10.0.0.3")]
    assert any("pep-backup" in cmd for cmd in plan["commands"])
    out = await _run_apply(db, c, "etcd", plan, {"batch_size": 5, "pause_sec": 0, "poll_sec": 0, "settle_sec": 0})
    assert out["status"] == "succeeded", out
    for h in fake.files:
        assert "--quota-backend-bytes=8589934592" in fake.files[h][FakeEtcd.MANIFEST]
        assert fake.files[h]["/etc/kubernetes/pep-backup/etcd.yaml.pep-bak-v1"] == ETCD_MANIFEST
    # 한 대씩: 두 번째 노드 기록은 첫 노드 확인(pgrep) 뒤에
    order = [(h, "write" if "PEP_CFG_EOF" in cmd else "pgrep") for h, cmd in fake.cmds if "PEP_CFG_EOF" in cmd or "pgrep" in cmd]
    assert order.index(("10.0.0.2", "write")) > order.index(("10.0.0.1", "pgrep"))
    assert V.list_versions(db, c.id, "etcd")[0].status == "applied"


async def test_apply_etcd_preflight_blocks_and_crash_restores(db, etcd_v2, monkeypatch):
    from app.services import ssh_runner
    from app.services.service_config import apply as A

    c = etcd_v2
    hosts = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    fake = FakeEtcd(hosts, unhealthy={"10.0.0.3"})
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    out = await _run_apply(db, c, "etcd", A.plan_apply(db, c, "etcd", None, None), {"poll_sec": 0, "settle_sec": 0})
    assert out["status"] == "failed" and all(r["status"] == "skipped" for r in out["node_results"])
    assert not any("PEP_CFG_EOF" in cmd for _, cmd in fake.cmds)  # 아무 노드도 건드리지 않음
    # 첫 노드가 새 설정으로 못 뜸 → 시간 초과 → 복원, 나머지 건너뜀
    fake = FakeEtcd(hosts, crash={"10.0.0.1"})
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    out = await _run_apply(db, c, "etcd", A.plan_apply(db, c, "etcd", None, None),
                           {"poll_sec": 0.01, "settle_sec": 0, "health_timeout_sec": 1})
    assert [r["status"] for r in out["node_results"]] == ["failed", "skipped", "skipped"]
    assert "복원" in out["node_results"][0]["error"]
    assert fake.files["10.0.0.1"][FakeEtcd.MANIFEST] == ETCD_MANIFEST and fake.running["10.0.0.1"] == ETCD_MANIFEST
    assert "8589934592" not in fake.files["10.0.0.2"][FakeEtcd.MANIFEST]


class FakeCtd:
    PATH = "/etc/containerd/config.toml"

    def __init__(self, hosts, events, stale=()):
        self.files = {h: {self.PATH: CTD_V2} for h in hosts}
        self.running = {h: CTD_V2 for h in hosts}
        self.events = events
        self.stale = set(stale)  # 재시작해도 새 설정이 반영되지 않는 노드
        self.cmds = []

    def __call__(self, target, cmd, connect_timeout=8, exec_timeout=30):
        h = target.host
        self.cmds.append((h, cmd))
        f = self.files[h]
        if "<<'PEP_CFG_EOF'" in cmd:
            f[self.PATH] = cmd.split("<<'PEP_CFG_EOF'\n", 1)[1].rsplit("PEP_CFG_EOF", 1)[0]
            self.events.append(("write", h))
            return _ok(h)
        if "systemctl restart" in cmd:
            self.events.append(("restart", h))
            if h not in self.stale:
                self.running[h] = f[self.PATH]
            return _ok(h)
        if "is-active" in cmd:
            return _ok(h, "active\n")
        if "config dump" in cmd:
            return _ok(h, self.running[h])
        if "cp -p" in cmd:
            src, dst = cmd.split("cp -p ", 1)[1].split()[:2]
            f[dst] = f[src]
            return _ok(h)
        if cmd.startswith("cat "):
            return _ok(h, f.get(cmd.split()[1], ""))
        return _ok(h)


@pytest.fixture
def ctd_v2(db, cluster):
    from app.models.service_config import ServiceConfigApplyRun
    from app.services.service_config import view as V

    for h in ("10.0.1.1", "10.0.1.2"):
        _add_snap(db, cluster, f"containerd_config:{h}", {"flat": C.parse_containerd_toml(CTD_V2)})
    V.import_v1(db, cluster, "containerd", "tester")
    vals = dict(V.list_versions(db, cluster.id, "containerd")[0].values)
    V.save_version(db, cluster, "containerd", None, 1,
                   {**vals, "max_concurrent_downloads": "6", "enable_unprivileged_ports": "true"}, None, "tester")
    yield cluster
    db.rollback()
    db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == cluster.id).delete(synchronize_session=False)
    db.commit()


async def test_apply_containerd_cordon_drain_restart_ready_and_snapshot(db, ctd_v2, monkeypatch):
    from app.services import ssh_runner
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    c = ctd_v2
    events = []
    core = FakeCore(events, ready_after=2, pods=[_pod("app-1"), _pod("cilium-x", "DaemonSet")])
    monkeypatch.setattr(A, "k8s_apis", lambda cl: (core, core))
    fake = FakeCtd(["10.0.1.1", "10.0.1.2"], events)
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    plan = A.plan_apply(db, c, "containerd", None, None)
    assert [t["node"] for t in plan["targets"]] == ["10.0.1.1", "10.0.1.2"]
    out = await _run_apply(db, c, "containerd", plan, {"batch_size": 1, "pause_sec": 0, "poll_sec": 0, "drain": True})
    assert out["status"] == "succeeded", out
    first = events[:events.index(("uncordon", "node-a")) + 1]
    assert first == [("cordon", "node-a"), ("evict", "app-1"), ("write", "10.0.1.1"), ("restart", "10.0.1.1"), ("uncordon", "node-a")]
    assert ("evict", "cilium-x") not in events  # DaemonSet 파드는 내보내지 않음
    cri = 'plugins."io.containerd.grpc.v1.cri"'
    assert C.parse_containerd_toml(fake.files["10.0.1.2"][FakeCtd.PATH])[f"{cri}.max_concurrent_downloads"] == "6"
    rows = {r["key"]: r for s in V.build_view(db, c, "containerd")["sections"] for r in s["items"]}
    assert rows["max_concurrent_downloads"]["current"]["value"] == "6"  # 스냅샷 갱신
    assert V.list_versions(db, c.id, "containerd")[0].status == "applied"


async def test_apply_containerd_verify_mismatch_restores(db, ctd_v2, monkeypatch):
    from app.services import ssh_runner
    from app.services.service_config import apply as A

    c = ctd_v2
    events = []
    core = FakeCore(events)
    monkeypatch.setattr(A, "k8s_apis", lambda cl: (core, core))
    fake = FakeCtd(["10.0.1.1", "10.0.1.2"], events, stale={"10.0.1.1"})
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    out = await _run_apply(db, c, "containerd", A.plan_apply(db, c, "containerd", None, None),
                           {"batch_size": 1, "pause_sec": 0, "poll_sec": 0})
    assert out["status"] == "failed" and [r["status"] for r in out["node_results"]] == ["failed", "skipped"]
    assert "실효 설정" in out["node_results"][0]["error"] and "복원" in out["node_results"][0]["error"]
    assert fake.files["10.0.1.1"][FakeCtd.PATH] == CTD_V2
    assert events[-1] == ("uncordon", "node-a")  # 복원 성공 → uncordon
    # K8S 를 못 써도 SSH 만으로 진행(cordon·Ready 건너뜀)
    def no_k8s(cl):
        raise RuntimeError("no kubeconfig")
    monkeypatch.setattr(A, "k8s_apis", no_k8s)
    monkeypatch.setattr(ssh_runner, "_exec_ssh", FakeCtd(["10.0.1.1", "10.0.1.2"], []))
    out = await _run_apply(db, c, "containerd", A.plan_apply(db, c, "containerd", None, None),
                           {"batch_size": 2, "pause_sec": 0, "poll_sec": 0})
    assert out["status"] == "succeeded", out


def test_apply_api_requires_ssh_for_etcd_containerd(db, ctd_v2):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    c = ctd_v2
    op = SimpleNamespace(id=uuid.uuid4(), username="op", role="operator", is_active=True, tenant_ids=[])
    app.dependency_overrides[get_current_user] = lambda: op
    try:
        client = TestClient(app)
        r = client.get(f"/api/v1/service-config/clusters/{c.id}/containerd/apply/plan")
        assert r.status_code == 200 and r.json()["supported"] and r.json()["commands"]
        r = client.post(f"/api/v1/service-config/clusters/{c.id}/containerd/apply/stream", json={})
        assert r.status_code == 422 and "SSH" in r.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── 5단계: 서비스 상태(드리프트·알람·최근 변경) ──────────────────────────────

def test_drift_rows_pure():
    from app.services.service_config import status as S

    values = {"vm.swappiness": {"w1": "1", "w2": "60", "g1": "10"}, "x": {"w1": "a"}}
    scopes = [{"group_id": None, "group_name": "기본", "baseline_version_no": 1, "nodes": ["w1", "w2"],
               "expected": {"vm.swappiness": "1", "x": ""}},
              {"group_id": "g", "group_name": "GPU", "baseline_version_no": 2, "nodes": ["g1"],
               "expected": {"vm.swappiness": "10"}}]
    rows = S.drift_rows(values, scopes)
    assert [(r["node"], r["current"], r["expected"]) for r in rows] == [("w2", "60", "1")]
    level, reasons = S.judge(1, [{"severity": "critical"}, {"severity": "warning"}], {"status": "failed", "version_no": 3}, [])
    assert level == "critical" and len(reasons) == 4
    assert S.judge(0, [], {"status": "succeeded", "version_no": 1}, [])[0] == "ok"
    assert S.judge(0, [], None, ["w9"])[0] == "warning"


def test_service_status_drift_alerts_changes_and_api(db, linux_v1):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app
    from app.models.alert_event import AlertEvent
    from app.models.os_param_change import OsParamChange
    from app.models.service_config import ServiceConfigGroup
    from app.services.service_config import status as S
    from app.services.service_config import view as V

    c = linux_v1
    try:
        # V1 은 다수 값(swappiness=1) — gpu-1(10)이 드리프트
        st = S.service_status(db, c, "linux")
        assert st["drift"]["nodes"] == ["gpu-1"] and st["drift"]["keys"] == ["vm.swappiness"]
        assert st["level"] == "warning" and st["drift"]["baseline_version_no"] == 1
        # 미적용 저장본은 드리프트로 치지 않는다(기준은 V1 그대로)
        vals = dict(V.list_versions(db, c.id, "linux")[0].values)
        V.save_version(db, c, "linux", None, 1, {**vals, "net.core.somaxconn": "8192"}, None, "tester")
        st = S.service_status(db, c, "linux")
        assert st["drift"]["keys"] == ["vm.swappiness"] and st["pending"]["version_no"] == 2
        # gpu-* 그룹의 적용된 재정의(10)가 있으면 gpu-1 은 드리프트가 아니다
        gid = V.save_group(db, c, "linux", None, "GPU", "gpu-*", None, "tester").id
        V.save_version(db, c, "linux", gid, 0, {"vm.swappiness": "10"}, None, "tester")
        gv = V.list_versions(db, c.id, "linux", gid)[0]
        gv.status = "applied"
        db.commit()
        st = S.service_status(db, c, "linux")
        assert st["drift"]["nodes"] == []
        # 노드에서 ip_forward 를 0 으로 — 에이전트 알람·변경 이력이 키 신호로
        _add_snap(db, c, "node_params:w1", {"runtime": {"vm.swappiness": "1", "net.core.somaxconn": "4096",
                                                         "net.ipv4.tcp_max_syn_backlog": "4096", "net.ipv4.ip_forward": "0"}})
        db.add(AlertEvent(cluster_id=c.id, source="node-param-agent", fingerprint=uuid.uuid4().hex[:32],
                          alertname="NodeParamBaselineViolation", severity="critical", status="firing", resource="w1",
                          labels={"param": "net.ipv4.ip_forward"}, starts_at=datetime.utcnow()))
        db.add(AlertEvent(cluster_id=c.id, source="node-param-agent", fingerprint=uuid.uuid4().hex[:32],
                          alertname="NodeParamChanged", severity="critical", status="firing", resource="w1",
                          labels={"params": "net.ipv4.ip_forward"}, acked=True, starts_at=datetime.utcnow()))
        db.add(OsParamChange(cluster_id=c.id, node="w1", param="net.ipv4.ip_forward", old_value="1", new_value="0",
                             change_type="changed", detected_at=datetime.utcnow()))
        db.commit()
        st = S.service_status(db, c, "linux")
        assert st["level"] == "critical" and st["drift"]["nodes"] == ["w1"]
        sig = next(s for s in st["key_signals"] if s["key"] == "net.ipv4.ip_forward")
        assert sig["alerts"] == {"critical": 1, "warning": 0}  # 확인된 알람은 빠진다
        assert sig["last_change"]["new_value"] == "0" and st["recent_changes"][0]["node"] == "w1"
        assert S.all_status(db, c)["services"]["linux"]["level"] == "critical"

        viewer = SimpleNamespace(id=uuid.uuid4(), username="v", role="viewer", is_active=True, tenant_ids=[])
        app.dependency_overrides[get_current_user] = lambda: viewer
        client = TestClient(app)
        r = client.get(f"/api/v1/service-config/clusters/{c.id}/status")
        assert r.status_code == 200 and set(r.json()["services"]) == set(["etcd", "containerd", "cilium", "linux", "kube-apiserver", "kube-controller-manager", "kube-scheduler", "kubelet"])
        r = client.get(f"/api/v1/service-config/clusters/{c.id}/linux/status")
        assert r.status_code == 200 and r.json()["drift"]["rows"][0]["key"] == "net.ipv4.ip_forward"
        assert client.get(f"/api/v1/service-config/clusters/{c.id}/nope/status").status_code == 404
    finally:
        from app.auth.deps import get_current_user as _g
        app.dependency_overrides.pop(_g, None)
        db.rollback()
        db.query(AlertEvent).filter(AlertEvent.cluster_id == c.id).delete(synchronize_session=False)
        db.query(OsParamChange).filter(OsParamChange.cluster_id == c.id).delete(synchronize_session=False)
        db.query(ServiceConfigGroup).filter(ServiceConfigGroup.cluster_id == c.id).delete(synchronize_session=False)
        db.commit()



# ── 6단계: 컨트롤 플레인 정적 파드 · KUBELET ─────────────────────────────────

APISERVER_MANIFEST = """apiVersion: v1
kind: Pod
metadata:
  name: kube-apiserver
  namespace: kube-system
spec:
  containers:
  - command:
    - kube-apiserver
    - --advertise-address=10.0.0.1
    - --max-requests-inflight=400
    - --service-node-port-range=30000-32767
    image: registry.k8s.io/kube-apiserver:v1.30.4
    name: kube-apiserver
"""

KUBELET_YAML = """apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
maxPods: 110
evictionHard:
  memory.available: 100Mi
"""


def test_static_pod_and_kubelet_current_values():
    items_api = items_for("kube-apiserver")
    cur = C.current_values("kube-apiserver", [
        snap("kube_apiserver", {"podName": "kube-apiserver-cp-1", "flags": {"max-requests-inflight": "400"}}),
    ], items_api)
    assert cur["values"]["max-requests-inflight"] == {"cp-1": "400"}  # 대표 파드 1개
    cur = C.current_values("kube-apiserver", [
        snap("kube_apiserver", {"podName": "kube-apiserver-cp-1", "flags": {"max-requests-inflight": "400"}}),
        snap("static_pod:kube-apiserver:cp-1", {"flags": {"max-requests-inflight": "800"}}),
        snap("static_pod:kube-apiserver:cp-2", {"flags": {"max-requests-inflight": "400"}}),
        snap("static_pod:kube-scheduler:cp-1", {"flags": {"profiling": "false"}}),  # 다른 서비스는 무시
    ], items_api)
    assert cur["values"]["max-requests-inflight"] == {"cp-1": "800", "cp-2": "400"}  # 노드별 수집이 우선
    cur = C.current_values("kubelet", [snap("kubelet_config:10.0.1.1", {"config_content": KUBELET_YAML})], items_for("kubelet"))
    assert cur["values"]["maxPods"] == {"10.0.1.1": "110"}
    assert cur["values"]["evictionHard.memory.available"] == {"10.0.1.1": "100Mi"}
    assert cur["values"]["cgroupDriver"] == {"10.0.1.1": "systemd"}


def test_edit_static_manifest_and_kubelet_config():
    from app.services.service_config import apply_nodes as AN

    out = AN.edit_etcd_manifest(APISERVER_MANIFEST, {"max-requests-inflight": "800", "profiling": "false"}, "kube-apiserver")
    assert "    - --max-requests-inflight=800" in out.splitlines()
    assert AN.manifest_flags(out, "kube-apiserver")["profiling"] == "false"
    assert "advertise-address=10.0.0.1" in out
    k = AN.edit_kubelet_config(KUBELET_YAML, {"maxPods": ("200", "int"), 'evictionHard."memory.available"': ("500Mi", "string"),
                                              "systemReserved.cpu": ("500m", "string"), "failSwapOn": ("false", "bool")})
    flat = C.parse_kubelet_yaml(k)
    assert flat["maxPods"] == "200" and flat['evictionHard."memory.available"'] == "500Mi"
    assert flat["systemReserved.cpu"] == "500m" and flat["failSwapOn"] == "false" and flat["kind"] == "KubeletConfiguration"
    assert "maxPods: 200" in k  # 정수는 따옴표 없이
    with pytest.raises(AN.EditError):
        AN.edit_kubelet_config("foo: 1\n", {"maxPods": ("1", "int")})
    with pytest.raises(AN.EditError):
        AN.edit_kubelet_config(KUBELET_YAML, {"maxPods": ("many", "int")})
    assert "pgrep -f" in AN._proc_cmdline("kube-controller-manager")


def test_kubelet_cgroup_rule_cross_service():
    from app.services.service_config.rules import evaluate

    res = evaluate(_rules(), "kubelet", {"kubelet": {"cgroupDriver": "systemd"}, "containerd": {"SystemdCgroup": "false"}},
                   {"cgroupDriver"})
    hit = [r for r in res if r["rule_id"] and r["target_key"] == "SystemdCgroup" and r["kind"] == "require"]
    assert hit and hit[0]["ok"] is False and hit[0]["suggested"] == "true"


class FakeStaticPod:
    """kube-apiserver 정적 파드 노드 — 매니페스트 기록 시 재시작. crash 노드는 새 설정으로 뜨지 못한다."""
    M = "/etc/kubernetes/manifests/kube-apiserver.yaml"

    def __init__(self, hosts, unhealthy=(), crash=()):
        self.files = {h: {self.M: APISERVER_MANIFEST} for h in hosts}
        self.running = {h: APISERVER_MANIFEST for h in hosts}
        self.unhealthy, self.crash = set(unhealthy), set(crash)
        self.cmds = []

    def __call__(self, target, cmd, connect_timeout=8, exec_timeout=30):
        from app.services.service_config import apply_nodes as AN

        h = target.host
        self.cmds.append((h, cmd))
        f = self.files[h]
        if "livez" in cmd:
            ok = h not in self.unhealthy and self.running[h] is not None
            return _ok(h, "ok") if ok else _fail(h, "connection refused")
        if "pgrep" in cmd:
            if self.running[h] is None:
                return _ok(h, "")
            fl = AN.manifest_flags(self.running[h], "kube-apiserver")
            return _ok(h, "kube-apiserver " + " ".join(f"--{k}={v}" for k, v in fl.items()))
        if "<<'PEP_CFG_EOF'" in cmd:
            path = cmd.split("tee ", 1)[1].split(" ", 1)[0]
            f[path] = cmd.split("<<'PEP_CFG_EOF'\n", 1)[1].rsplit("PEP_CFG_EOF", 1)[0]
            self.running[h] = None if h in self.crash else f[path]
            return _ok(h)
        if "cp -p" in cmd:
            src, dst = cmd.split("cp -p ", 1)[1].split()[:2]
            f[dst] = f[src]
            if dst == self.M:
                self.running[h] = f[dst]
            return _ok(h)
        if cmd.startswith("cat "):
            return _ok(h, f.get(cmd.split()[1], ""))
        return _ok(h)


class FakeCPCore(FakeCore):
    def list_namespaced_pod(self, ns, label_selector=None, **_):
        comp = (label_selector or "component=").split("=", 1)[1]
        if label_selector is None:  # 수집 — 전체 kube-system
            pods = []
            for c in ("kube-apiserver", "kube-scheduler"):
                for i in (1, 2):
                    pods.append(SimpleNamespace(
                        metadata=SimpleNamespace(name=f"{c}-cp-{i}", labels={"component": c, "tier": "control-plane"}),
                        spec=SimpleNamespace(node_name=f"cp-{i}", containers=[SimpleNamespace(
                            name=c, image=f"registry.k8s.io/{c}:v1.30.4",
                            command=[c, f"--max-requests-inflight={400 * i}"], args=[])]),
                        status=SimpleNamespace(host_ip=f"10.0.0.{i}")))
            pods.append(SimpleNamespace(metadata=SimpleNamespace(name="coredns-x", labels={"k8s-app": "kube-dns"}),
                                        spec=SimpleNamespace(node_name="w1", containers=[]), status=SimpleNamespace(host_ip="1")))
            return SimpleNamespace(items=pods)
        return SimpleNamespace(items=[SimpleNamespace(spec=SimpleNamespace(node_name=f"cp-{i}"),
                                                      status=SimpleNamespace(host_ip=f"10.0.0.{i}")) for i in (1, 2, 3)]
                               if comp == "kube-apiserver" else [])


@pytest.fixture
def api_v2(db, cluster, monkeypatch):
    from app.models.service_config import ServiceConfigApplyRun
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    core = FakeCPCore()
    monkeypatch.setattr(A, "k8s_apis", lambda c: (core, core))
    _add_snap(db, cluster, "kube_apiserver", {"podName": "kube-apiserver-cp-1", "flags": {"max-requests-inflight": "400"}})
    V.import_v1(db, cluster, "kube-apiserver", "tester")
    vals = dict(V.list_versions(db, cluster.id, "kube-apiserver")[0].values)
    V.save_version(db, cluster, "kube-apiserver", None, 1, {**vals, "max-requests-inflight": "800"}, None, "tester")
    yield cluster
    db.rollback()
    db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == cluster.id).delete(synchronize_session=False)
    db.commit()


def test_collect_static_pods_per_node(db, api_v2):
    from app.services.service_config import collect as CL
    from app.services.service_config import view as V

    out = CL.collect_static_pods(db, api_v2)
    assert out["changed"] == 4 and not out["errors"]
    assert CL.collect_static_pods(db, api_v2)["changed"] == 0  # 같은 내용은 저장하지 않음
    rows = {r["key"]: r for s in V.build_view(db, api_v2, "kube-apiserver")["sections"] for r in s["items"]}
    assert rows["max-requests-inflight"]["current"]["groups"] == [{"value": "400", "nodes": ["cp-1"]}, {"value": "800", "nodes": ["cp-2"]}] \
        or {g["value"] for g in rows["max-requests-inflight"]["current"]["groups"]} == {"400", "800"}


async def test_apply_static_pod_success_and_crash_restore(db, api_v2, monkeypatch):
    from app.services import ssh_runner
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    c = api_v2
    hosts = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    fake = FakeStaticPod(hosts)
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    plan = A.plan_apply(db, c, "kube-apiserver", None, None)
    assert [t["host"] for t in plan["targets"]] == hosts and any("livez" in x for x in plan["commands"])
    out = await _run_apply(db, c, "kube-apiserver", plan, {"batch_size": 3, "pause_sec": 0, "poll_sec": 0, "settle_sec": 0})
    assert out["status"] == "succeeded", out
    assert all("--max-requests-inflight=800" in fake.files[h][FakeStaticPod.M] for h in hosts)
    assert fake.files["10.0.0.1"]["/etc/kubernetes/pep-backup/kube-apiserver.yaml.pep-bak-v1"] == APISERVER_MANIFEST
    assert V.list_versions(db, c.id, "kube-apiserver")[0].status == "applied"
    # 비정상 노드가 있으면 시작 안 함
    fake = FakeStaticPod(hosts, unhealthy={"10.0.0.2"})
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    V.save_version(db, c, "kube-apiserver", None, 2,
                   {**dict(V.list_versions(db, c.id, "kube-apiserver")[0].values), "max-requests-inflight": "900"}, None, "tester")
    out = await _run_apply(db, c, "kube-apiserver", A.plan_apply(db, c, "kube-apiserver", None, None), {"poll_sec": 0, "settle_sec": 0})
    assert out["status"] == "failed" and not any("PEP_CFG_EOF" in cmd for _, cmd in fake.cmds)
    # 첫 노드가 새 설정으로 못 뜸 → 복원 + 나머지 건너뜀
    fake = FakeStaticPod(hosts, crash={"10.0.0.1"})
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    out = await _run_apply(db, c, "kube-apiserver", A.plan_apply(db, c, "kube-apiserver", None, None),
                           {"poll_sec": 0.01, "settle_sec": 0, "health_timeout_sec": 1})
    assert [r["status"] for r in out["node_results"]] == ["failed", "skipped", "skipped"]
    assert "복원" in out["node_results"][0]["error"] and fake.files["10.0.0.1"][FakeStaticPod.M] == APISERVER_MANIFEST


class FakeKubelet:
    PATH = "/var/lib/kubelet/config.yaml"

    def __init__(self, hosts, events):
        self.files = {h: {self.PATH: KUBELET_YAML} for h in hosts}
        self.events = events
        self.cmds = []

    def __call__(self, target, cmd, connect_timeout=8, exec_timeout=30):
        h = target.host
        self.cmds.append((h, cmd))
        f = self.files[h]
        if "<<'PEP_CFG_EOF'" in cmd:
            f[self.PATH] = cmd.split("<<'PEP_CFG_EOF'\n", 1)[1].rsplit("PEP_CFG_EOF", 1)[0]
            self.events.append(("write", h))
            return _ok(h)
        if "systemctl restart" in cmd:
            self.events.append(("restart", h))
            return _ok(h)
        if "is-active" in cmd:
            return _ok(h, "active\n")
        if "cp -p" in cmd:
            src, dst = cmd.split("cp -p ", 1)[1].split()[:2]
            f[dst] = f[src]
            return _ok(h)
        if cmd.startswith("cat "):
            return _ok(h, f.get(cmd.split()[1], ""))
        return _ok(h)


async def test_apply_kubelet_restart_ready_configz_and_snapshot(db, cluster, monkeypatch):
    import json

    import yaml

    from app.models.service_config import ServiceConfigApplyRun
    from app.services import ssh_runner
    from app.services.service_config import apply as A
    from app.services.service_config import view as V

    for h in ("10.0.1.1", "10.0.1.2"):
        _add_snap(db, cluster, f"kubelet_config:{h}", {"config_content": KUBELET_YAML, "config_file": FakeKubelet.PATH})
    V.import_v1(db, cluster, "kubelet", "tester")
    vals = dict(V.list_versions(db, cluster.id, "kubelet")[0].values)
    V.save_version(db, cluster, "kubelet", None, 1, {**vals, "maxPods": "200"}, None, "tester")
    events = []
    fake = FakeKubelet(["10.0.1.1", "10.0.1.2"], events)

    class Core(FakeCore):
        def connect_get_node_proxy_with_path(self, name, path, **_):
            host = {"node-a": "10.0.1.1", "node-b": "10.0.1.2"}[name]
            return json.dumps({"kubeletconfig": yaml.safe_load(fake.files[host][FakeKubelet.PATH])})

    core = Core(events)
    monkeypatch.setattr(A, "k8s_apis", lambda cl: (core, core))
    monkeypatch.setattr(ssh_runner, "_exec_ssh", fake)
    try:
        plan = A.plan_apply(db, cluster, "kubelet", None, None)
        out = await _run_apply(db, cluster, "kubelet", plan, {"batch_size": 1, "pause_sec": 0, "poll_sec": 0})
        assert out["status"] == "succeeded", out
        assert ("write", "10.0.1.1") in events and ("restart", "10.0.1.1") in events
        assert not any(e[0] == "cordon" for e in events)  # kubelet 재시작은 cordon 하지 않는다
        rows = {r["key"]: r for s in V.build_view(db, cluster, "kubelet")["sections"] for r in s["items"]}
        assert rows["maxPods"]["current"]["value"] == "200"  # 스냅샷 갱신
    finally:
        db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.cluster_id == cluster.id).delete(synchronize_session=False)
        db.commit()


def test_settings_backup_dir_inside_manifest_dir_rejected(db):
    from app.services.service_config import apply as A

    with pytest.raises(A.ApplyError):
        A.set_settings(db, {"static_pod_manifest_dir": "/etc/k8s/m", "etcd_backup_dir": "/etc/k8s/m/bak"})
    with pytest.raises(A.ApplyError):
        A.set_settings(db, {"kubelet_restart_cmd": "systemctl restart kubelet\nreboot"})
