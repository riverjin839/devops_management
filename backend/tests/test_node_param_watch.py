"""노드 OS 파라미터 감시 — 판정 로직·에이전트 파일 해석·매니페스트·보고 처리(실제 DB) 테스트."""
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.node_param_agent import agent as A  # noqa: E402
from app.services.node_param_watch import rules as R  # noqa: E402
from app.services.node_param_watch.manifest import TOKEN_PLACEHOLDER, render_manifest  # noqa: E402

CID = uuid.uuid4()
OTHER = uuid.uuid4()


def rule(param, op="any", expected=None, *, cluster_id=None, node_pattern=None, severity="warning",
         alert_on_change=True, check_persistent=True, enabled=True):
    return SimpleNamespace(id=uuid.uuid4(), cluster_id=cluster_id, param=param, operator=op, expected=expected,
                           node_pattern=node_pattern, severity=severity, alert_on_change=alert_on_change,
                           check_persistent=check_persistent, enabled=enabled)


# ── 판정 로직 ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("op,expected,actual,ok", [
    ("any", None, "5", True),
    ("eq", "1", "1", True),
    ("eq", "1", "0", False),
    ("eq", "4096 131072 6291456", "4096\t131072   6291456", True),  # 공백 정규화
    ("ne", "0", "1", True),
    ("ne", "0", "0", False),
    ("gte", "65535", "1048576", True),
    ("gte", "65535", "1024", False),
    ("lte", "10", "60", False),
    ("gte", "10", "abc", False),
    ("in", "cubic|bbr", "bbr", True),
    ("in", "cubic|bbr", "reno", False),
    ("eq", "1", None, False),  # 노드에 파라미터가 없음
])
def test_check_expected(op, expected, actual, ok):
    assert R.check_expected(op, expected, R.normalize_value(actual))[0] is ok


def test_cluster_rule_overrides_common_and_node_pattern():
    common = rule("vm.swappiness", "eq", "1")
    scoped = rule("vm.swappiness", "eq", "10", cluster_id=CID)
    other = rule("vm.max_map_count", "any", cluster_id=OTHER)
    gpu_only = rule("kernel.pid_max", "any", node_pattern="gpu-*, infer-?")
    disabled = rule("fs.file-max", "any", enabled=False)
    rules = [common, scoped, other, gpu_only, disabled]

    by = R.rules_for_node(rules, CID, "worker-1")
    assert set(by) == {"vm.swappiness"}
    assert by["vm.swappiness"] == [scoped]  # 공통 규칙은 가려진다
    assert set(R.rules_for_node(rules, CID, "gpu-03")) == {"vm.swappiness", "kernel.pid_max"}
    assert set(R.rules_for_node(rules, OTHER, "infer-1")) == {"vm.swappiness", "vm.max_map_count", "kernel.pid_max"}


def test_diff_runtime_ignores_watch_list_growth():
    old = {"a": "1", "b": "2", "gone": "3"}
    new = {"a": "1", "b": "5", "added_to_watch": "9", "gone": None}
    changes = R.diff_runtime(old, new)
    assert [(c["param"], c["change_type"]) for c in changes] == [("b", "changed"), ("gone", "removed")]


def test_evaluate_node_violation_mismatch_and_unreported():
    by = {
        "net.ipv4.ip_forward": [rule("net.ipv4.ip_forward", "eq", "1", severity="critical")],
        "net.core.somaxconn": [rule("net.core.somaxconn", "gte", "4096")],
        "vm.swappiness": [rule("vm.swappiness", check_persistent=False)],
        "fs.file-max": [rule("fs.file-max")],
    }
    runtime = {"net.ipv4.ip_forward": "0", "net.core.somaxconn": "4096", "vm.swappiness": "60"}
    persistent = {
        "net.core.somaxconn": {"value": "8192", "source": "/etc/sysctl.conf:1"},
        "vm.swappiness": {"value": "1", "source": "/etc/sysctl.d/90.conf:1"},
    }
    st = {s.param: s for s in R.evaluate_node(by, runtime, persistent)}
    assert st["net.ipv4.ip_forward"].ok is False and st["net.ipv4.ip_forward"].severity == "critical"
    assert st["net.core.somaxconn"].ok is True and st["net.core.somaxconn"].persisted_ok is False
    assert st["vm.swappiness"].persisted_ok is True  # check_persistent 꺼짐
    assert st["fs.file-max"].reported is False and st["fs.file-max"].ok is True


def test_change_severity_uses_alert_on_change_rules_only():
    by = {"a": [rule("a", severity="critical", alert_on_change=False)], "b": [rule("b", severity="warning")]}
    assert R.change_severity(by, [{"param": "a"}]) is None
    assert R.change_severity(by, [{"param": "a"}, {"param": "b"}]) == "warning"


@pytest.mark.parametrize("name,ok", [
    ("net.core.somaxconn", True), ("net.ipv4.conf.eth0-1.rp_filter", True),
    ("", False), (".a", False), ("a..b", False), ("a b", False), ("a/b", False),
])
def test_valid_param_name(name, ok):
    assert R.valid_param_name(name) is ok


# ── 에이전트 ─────────────────────────────────────────────────────────────────

def _host(tmp_path: Path) -> Path:
    host = tmp_path / "host"
    (host / "etc/sysctl.d").mkdir(parents=True)
    (host / "usr/lib/sysctl.d").mkdir(parents=True)
    (host / "usr/lib/sysctl.d/50-default.conf").write_text("vm.swappiness = 60\nkernel.pid_max = 4194304\n")
    # 같은 이름이면 /etc 가 /usr/lib 를 가린다
    (host / "usr/lib/sysctl.d/90-k8s.conf").write_text("net.core.somaxconn = 1\n")
    (host / "etc/sysctl.d/90-k8s.conf").write_text("net.core.somaxconn=4096\n; c\n-vm/swappiness = 1\nnet.ipv4.conf.*.rp_filter = 2\n")
    (host / "etc/sysctl.conf").write_text("# last\nkernel.pid_max = 65536\n")
    (host / "etc/sysctl.d/99-sysctl.conf").symlink_to("/etc/sysctl.conf")  # 호스트 절대 경로 링크
    return host


def test_agent_read_persistent_precedence(tmp_path):
    host = _host(tmp_path)
    params = ["net.core.somaxconn", "vm.swappiness", "kernel.pid_max", "net.ipv4.conf.eth0.rp_filter", "fs.file-max"]
    got = A.read_persistent(params, host)
    assert got["net.core.somaxconn"] == {"value": "4096", "source": "/etc/sysctl.d/90-k8s.conf:1"}
    assert got["vm.swappiness"]["value"] == "1"
    assert got["kernel.pid_max"] == {"value": "65536", "source": "/etc/sysctl.conf:2"}
    assert got["net.ipv4.conf.eth0.rp_filter"]["value"] == "2"
    assert "fs.file-max" not in got


def test_agent_read_runtime(tmp_path):
    proc = tmp_path / "proc"
    (proc / "net/core").mkdir(parents=True)
    (proc / "net/core/somaxconn").write_text("4096\n")
    (proc / "net/ipv4").mkdir(parents=True)
    (proc / "net/ipv4/tcp_rmem").write_text("4096\t131072\t6291456\n")
    values, errors = A.read_runtime(["net.core.somaxconn", "net.ipv4.tcp_rmem", "net.nf_conntrack_max"], proc)
    assert values == {"net.core.somaxconn": "4096", "net.ipv4.tcp_rmem": "4096 131072 6291456",
                      "net.nf_conntrack_max": None}
    assert errors == []


def test_agent_requires_env(monkeypatch):
    for k in ("PEP_API_URL", "NODE_PARAM_INGEST_TOKEN", "PEP_CLUSTER"):
        monkeypatch.delenv(k, raising=False)
    assert A.run(once=True) == 2


# ── 매니페스트 ───────────────────────────────────────────────────────────────

def test_manifest_is_least_privilege():
    import yaml

    text = render_manifest(cluster_id=str(CID), cluster_name="prod-a", api_base_url="https://pep/api/v1",
                           image="reg.local/pep-backend:1.2.3", namespace="k8s-monitor-agent", tls_verify=False)
    docs = [d for d in yaml.safe_load_all(text) if d]
    kinds = [d["kind"] for d in docs]
    assert kinds == ["Namespace", "Secret", "DaemonSet"]
    secret, ds = docs[1], docs[2]
    assert secret["stringData"]["NODE_PARAM_INGEST_TOKEN"] == TOKEN_PLACEHOLDER
    assert secret["stringData"]["PEP_CLUSTER"] == str(CID)
    assert secret["stringData"]["PEP_TLS_VERIFY"] == "false"
    spec = ds["spec"]["template"]["spec"]
    assert spec["hostNetwork"] is True and spec["hostIPC"] is True and "hostPID" not in spec
    assert spec["automountServiceAccountToken"] is False
    c = spec["containers"][0]
    assert c["image"] == "reg.local/pep-backend:1.2.3"
    assert c["command"] == ["python", "-m", "app.node_param_agent"]
    assert c["securityContext"]["capabilities"]["drop"] == ["ALL"]
    assert "privileged" not in c["securityContext"]
    assert all(m["readOnly"] for m in c["volumeMounts"])
    assert {v["hostPath"]["path"] for v in spec["volumes"]} == {
        "/etc/sysctl.conf", "/etc/sysctl.d", "/run/sysctl.d", "/usr/lib/sysctl.d",
        "/etc/containerd", "/var/lib/kubelet"}  # 서비스 구성 변경 감지용 설정 파일 디렉터리


def test_manifest_rust_agent_image_has_no_command_and_small_footprint():
    import yaml

    text = render_manifest(cluster_id=str(CID), cluster_name="prod-a", api_base_url="https://pep/api/v1",
                           image="ghcr.io/x/devops_management/node-agent:2.0.0", namespace="k8s-monitor-agent", tls_verify=True)
    c = [d for d in yaml.safe_load_all(text) if d][2]["spec"]["template"]["spec"]["containers"][0]
    assert "command" not in c  # ENTRYPOINT 가 바이너리
    assert {e["name"] for e in c["env"]} == {"NODE_NAME", "HOST_IP", "HOST_ROOT"}
    assert c["resources"]["requests"]["memory"] == "8Mi"
    assert c["securityContext"]["readOnlyRootFilesystem"] is True


@pytest.mark.parametrize("image,python", [
    ("ghcr.io/riverjin839/devops_management-backend:latest", True),   # 예전 기본값 — Python 방식 유지
    ("reg.local/pep/backend@sha256:abc", True),
    ("ghcr.io/riverjin839/devops_management/node-agent:latest", False),
    ("reg.local:5000/pep-node-agent:1.0", False),
])
def test_agent_image_runtime_detection(image, python):
    from app.services.node_param_watch.manifest import is_python_agent_image

    assert is_python_agent_image(image) is python


# ── 보고 처리(실제 DB) ───────────────────────────────────────────────────────

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
def world(db):
    from app.models import ClusterConfigSnapshot, OsParamChange
    from app.models.alert_event import AlertEvent
    from app.models.cluster import Cluster
    from app.models.node_param_watch import NodeParamAgent, NodeParamWatchRule
    from app.models.user_notification import UserNotification

    # 다른 테스트·시드가 남긴 공통 규칙이 판정에 끼지 않게 잠시 끈다(끝나면 되돌린다).
    disabled = [r.id for r in db.query(NodeParamWatchRule).filter(
        NodeParamWatchRule.cluster_id.is_(None), NodeParamWatchRule.enabled.is_(True)).all()]
    if disabled:
        db.query(NodeParamWatchRule).filter(NodeParamWatchRule.id.in_(disabled)).update(
            {"enabled": False}, synchronize_session=False)
    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"npw-{tag}", api_endpoint="https://npw:6443")
    db.add(cluster)
    db.commit()
    db.add_all([
        NodeParamWatchRule(cluster_id=cluster.id, param="net.ipv4.ip_forward", operator="eq", expected="1",
                           severity="critical"),
        NodeParamWatchRule(cluster_id=cluster.id, param="net.core.somaxconn", operator="any", severity="warning"),
        NodeParamWatchRule(cluster_id=cluster.id, param="vm.swappiness", operator="any", severity="info",
                           alert_on_change=False),
    ])
    db.commit()
    yield SimpleNamespace(cluster=cluster, tag=tag)
    db.rollback()
    event_ids = [e.id for e in db.query(AlertEvent.id).filter(AlertEvent.cluster_id == cluster.id).all()]
    if event_ids:
        db.query(UserNotification).filter(
            UserNotification.link.in_([f"/alerts?id={i}" for i in event_ids])).delete(synchronize_session=False)
    db.query(AlertEvent).filter(AlertEvent.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(OsParamChange).filter(OsParamChange.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(NodeParamAgent).filter(NodeParamAgent.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(NodeParamWatchRule).filter(NodeParamWatchRule.cluster_id == cluster.id).delete(synchronize_session=False)
    if disabled:
        db.query(NodeParamWatchRule).filter(NodeParamWatchRule.id.in_(disabled)).update(
            {"enabled": True}, synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.commit()


def _firing(db, cluster_id, alertname):
    from app.models.alert_event import AlertEvent

    return db.query(AlertEvent).filter(AlertEvent.cluster_id == cluster_id, AlertEvent.alertname == alertname,
                                       AlertEvent.status == "firing").all()


def test_report_flow_changes_violations_and_resolution(db, world):
    from app.models import OsParamChange
    from app.services.node_param_watch import service as svc

    c = world.cluster
    # 1) 첫 보고(감시 목록 없음) — 목록만 돌려받고 스냅샷·알람은 없다
    out = svc.handle_report(db, c, {"node": "w1", "host_ip": "10.0.0.1", "runtime": {}, "persistent": {}})
    assert out["params"] == ["net.core.somaxconn", "net.ipv4.ip_forward", "vm.swappiness"]
    assert out["interval_sec"] >= 15

    # 2) 기준선 — ip_forward=0 위반, somaxconn 런타임 ≠ 영구 설정
    base = {"node": "w1", "host_ip": "10.0.0.1",
            "runtime": {"net.ipv4.ip_forward": "0", "net.core.somaxconn": "4096", "vm.swappiness": "60"},
            "persistent": {"net.core.somaxconn": {"value": "8192", "source": "/etc/sysctl.conf:1"}}}
    out = svc.handle_report(db, c, base)
    assert out["changes"] == 0 and out["violations"] == 1 and out["mismatches"] == 1 and out["alerts_opened"] == 2
    viol = _firing(db, c.id, svc.ALERT_VIOLATION)
    assert len(viol) == 1 and viol[0].severity == "critical" and viol[0].resource == "w1"
    assert len(_firing(db, c.id, svc.ALERT_NOT_PERSISTED)) == 1

    # 3) 같은 값 재보고 — 알람이 다시 열리지 않는다(반복 알림 방지)
    out = svc.handle_report(db, c, base)
    assert out["alerts_opened"] == 0 and out["alerts_resolved"] == 0
    assert viol[0].occurrences == 1

    # 4) 값 변경 — 변경 이력·변경 알람, 해소된 위반·불일치는 닫힌다. swappiness 는 alert_on_change=False
    fixed = {**base, "runtime": {"net.ipv4.ip_forward": "1", "net.core.somaxconn": "8192", "vm.swappiness": "1"}}
    out = svc.handle_report(db, c, fixed)
    assert out["changes"] == 3 and out["change_alert"] is True and out["alerts_resolved"] == 2
    assert _firing(db, c.id, svc.ALERT_VIOLATION) == [] and _firing(db, c.id, svc.ALERT_NOT_PERSISTED) == []
    changed = _firing(db, c.id, svc.ALERT_CHANGED)
    assert len(changed) == 1 and changed[0].severity == "critical"
    assert "net.ipv4.ip_forward 0→1" in changed[0].summary
    rows = db.query(OsParamChange).filter(OsParamChange.cluster_id == c.id).all()
    assert {r.param for r in rows} == {"net.ipv4.ip_forward", "net.core.somaxconn", "vm.swappiness"}
    assert all((r.extra or {}).get("source") == "agent" and r.node == "w1" for r in rows)

    # 5) 화면 상태
    state = svc.node_states(db, c)
    node = state["nodes"][0]
    assert node["node"] == "w1" and node["state"] == "reporting" and node["violation_count"] == 0
    assert {p["param"] for p in node["params"]} == {"net.core.somaxconn", "net.ipv4.ip_forward", "vm.swappiness"}


def test_watchdog_opens_and_report_resolves(db, world):
    from app.models.node_param_watch import NodeParamAgent
    from app.services.node_param_watch import service as svc

    c = world.cluster
    svc.handle_report(db, c, {"node": "w2", "runtime": {"net.core.somaxconn": "4096"}, "persistent": {}})
    agent = db.query(NodeParamAgent).filter(NodeParamAgent.cluster_id == c.id, NodeParamAgent.node == "w2").one()
    agent.last_seen_at = datetime.utcnow() - timedelta(hours=2)
    db.commit()
    svc.run_watchdog(db)
    svc.run_watchdog(db)  # 두 번 돌아도 하나만
    assert len(_firing(db, c.id, svc.ALERT_AGENT_OFFLINE)) == 1
    svc.handle_report(db, c, {"node": "w2", "runtime": {"net.core.somaxconn": "4096"}, "persistent": {}})
    assert _firing(db, c.id, svc.ALERT_AGENT_OFFLINE) == []


def test_ingest_endpoint_token_fail_closed(db, world, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app

    client = TestClient(app)
    body = {"cluster": world.cluster.name, "node": "w3", "runtime": {}, "persistent": {}}
    monkeypatch.setattr(settings, "node_param_ingest_token", "")
    assert client.post("/api/v1/node-params/agent/report", json=body).status_code == 503
    monkeypatch.setattr(settings, "node_param_ingest_token", "s3cret")
    assert client.post("/api/v1/node-params/agent/report", json=body,
                       headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.post("/api/v1/node-params/agent/report", json=body, headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200, r.text
    assert "net.ipv4.ip_forward" in r.json()["params"]
    r = client.post("/api/v1/node-params/agent/report", json={**body, "cluster": "no-such-cluster"},
                    headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 404


def test_repo_deploy_bundle_matches_renderer():
    """deploy/k8s/node-param-agent/daemonset.yaml 은 화면 매니페스트 렌더러와 같은 DaemonSet 이어야 한다."""
    import yaml

    repo = Path(__file__).resolve().parents[2] / "deploy/k8s/node-param-agent/daemonset.yaml"
    if not repo.exists():
        pytest.skip("deploy 디렉터리가 없는 실행 환경(이미지 안 등)")
    on_disk = yaml.safe_load(repo.read_text())
    rendered = [d for d in yaml.safe_load_all(render_manifest(
        cluster_id="x", cluster_name="x", api_base_url="https://x/api/v1",
        image=on_disk["spec"]["template"]["spec"]["containers"][0]["image"],
        namespace=on_disk["metadata"]["namespace"], tls_verify=True)) if d][2]
    assert on_disk == rendered
