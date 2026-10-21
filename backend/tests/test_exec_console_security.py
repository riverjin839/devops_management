"""실행형 콘솔 권한·감사 회귀 (D-169·D-170·D-172·정책 2·5·6·7).

- 테넌트 판정: etcdctl·mc·tcpdump(+interfaces)·node-ssh test 는 **접속 host 가 속한 클러스터**까지
  operate 를 본다. topology-trace 의 추적·패킷 흐름·Hubble 은 본문 cluster_id 로 read 판정.
- 감사: 실행 **후** 실제 결과(status/exit_code/host)로 1행, 명령은 마스킹.
- cilium-dbg 직접 명령: 읽기 전용 allowlist 밖은 admin 만.
- WS close code: 토큰 문제 4401, 역할 부족 4402, 테넌트 거부 4413.

SSH·kubectl 은 전부 모킹한다(실제 DB 는 사용).
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

from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.ssh_runner import SSHResult  # noqa: E402

BOUND_HOST = "10.9.71.1"
OPEN_HOST = "10.9.70.1"
OUTSIDE_HOST = "192.0.2.77"  # 어느 클러스터에도 속하지 않는 host(관리 서버 등)


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
    c_open = Cluster(name=f"xopen-{tag}", api_endpoint="https://open:6443",
                     node_ips=json.dumps([OPEN_HOST]))
    c_bound = Cluster(name=f"xbound-{tag}", api_endpoint="https://bound:6443",
                      node_ips=json.dumps([BOUND_HOST]))
    users = {
        key: User(username=f"x{key}-{tag}", hashed_password="x", role=role, is_active=True)
        for key, role in (
            ("admin", "admin"), ("op_member", "operator"), ("op_outsider", "operator"),
            ("viewer_member", "viewer"), ("viewer_outsider", "viewer"),
        )
    }
    tenant = Tenant(name=f"xteam-{tag}")
    db.add_all([c_open, c_bound, tenant, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["op_member"].id),
        TenantMember(tenant_id=tenant.id, user_id=users["viewer_member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="operate"),
    ])
    db.commit()
    yield {"open": c_open, "bound": c_bound, "tenant": tenant, **users}
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_([c_open.id, c_bound.id])).delete(
        synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_([c_open.id, c_bound.id])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


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
        app.dependency_overrides.pop(get_current_user, None)


def _audits(db, user, action):
    db.expire_all()
    return (db.query(AuditLog)
            .filter(AuditLog.actor_user_id == user.id, AuditLog.action == action)
            .order_by(AuditLog.created_at.asc()).all())


def _fake_run_bulk(status="ok", exit_code=0, error=None):
    calls = []

    async def _run(targets, **kw):
        calls.append({"targets": targets, **kw})
        return [SSHResult(host=t.host, status=status, exit_code=exit_code, stdout="out", stderr="",
                          duration_ms=7, error=error) for t in targets]

    _run.calls = calls
    return _run


SSH_CRED = {"username": "root", "password": "ssh-pw"}


# ── D-169 테넌트 판정 ────────────────────────────────────────────────────────

def test_etcdctl_host_override_into_bound_cluster_is_403(client_as, world, monkeypatch):
    import app.routers.etcdctl as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    body = {"host": BOUND_HOST, "args": "endpoint health", **SSH_CRED}
    r = client_as(world["op_outsider"]).post(f"/api/v1/clusters/{world['open'].id}/etcdctl/run", json=body)
    assert r.status_code == 403 and "테넌트" in r.json()["detail"]
    r = client_as(world["op_outsider"]).post(
        f"/api/v1/clusters/{world['open'].id}/etcdctl/logs", json={"host": BOUND_HOST, **SSH_CRED})
    assert r.status_code == 403
    assert fake.calls == []  # SSH 는 시도조차 하지 않는다


def test_mc_host_override_into_bound_cluster_is_403(client_as, world, monkeypatch):
    import app.routers.mc_client as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    body = {"host": BOUND_HOST, "args": "ls {alias}", **SSH_CRED}
    r = client_as(world["op_outsider"]).post(f"/api/v1/clusters/{world['open'].id}/mc/run", json=body)
    assert r.status_code == 403
    assert fake.calls == []


def test_tcpdump_and_interfaces_check_host_cluster(client_as, world, monkeypatch):
    import app.routers.topology_trace as mod
    monkeypatch.setattr(mod, "tcpdump_capture", lambda *a, **k: pytest.fail("must not capture"))
    monkeypatch.setattr(mod, "list_remote_interfaces", lambda *a, **k: pytest.fail("must not ssh"))
    c = client_as(world["op_outsider"])
    r = c.post("/api/v1/topology-trace/tcpdump", json={"host": BOUND_HOST, "interface": "eth0", **SSH_CRED})
    assert r.status_code == 403
    # 화면이 보낸 cluster_id(바인딩 클러스터)도 본다
    r = c.post("/api/v1/topology-trace/tcpdump",
               json={"host": OUTSIDE_HOST, "interface": "eth0", "cluster_id": str(world["bound"].id), **SSH_CRED})
    assert r.status_code == 403
    r = c.post("/api/v1/topology-trace/tcpdump/interfaces", json={"host": BOUND_HOST, **SSH_CRED})
    assert r.status_code == 403


def test_node_ssh_test_checks_host_cluster(client_as, world, monkeypatch):
    import app.routers.node_ssh as mod
    monkeypatch.setattr(mod, "test_connection", lambda *a, **k: pytest.fail("must not ssh"))
    r = client_as(world["op_outsider"]).post("/api/v1/node-ssh/test", json={"host": BOUND_HOST, **SSH_CRED})
    assert r.status_code == 403


def test_node_ssh_test_outside_host_allowed_and_audited(client_as, world, monkeypatch, db):
    import app.routers.node_ssh as mod
    monkeypatch.setattr(mod, "test_connection", lambda tgt, **k: SSHResult(
        host=tgt.host, status="auth_error", exit_code=None, stdout="", stderr="", duration_ms=3,
        error="Authentication failed."))
    r = client_as(world["op_outsider"]).post("/api/v1/node-ssh/test", json={"host": OUTSIDE_HOST, **SSH_CRED})
    assert r.status_code == 200
    rows = _audits(db, world["op_outsider"], "node.ssh.test")
    assert len(rows) == 1 and rows[0].status == "failure"
    assert rows[0].target_type == "host" and rows[0].target_id == OUTSIDE_HOST
    assert "ssh-pw" not in json.dumps(rows[0].details)


def test_packet_flow_and_hubble_require_read_binding(client_as, world, monkeypatch):
    import app.routers.topology_trace as mod
    monkeypatch.setattr(mod, "ensure_kubeconfig_file", lambda c: None)
    v2 = {"cluster_id": str(world["bound"].id), "direction": "east-west",
          "source": "ns/a", "destination": "ns/b"}
    hub = {"cluster_id": str(world["bound"].id)}
    for path, body in (("/api/v1/topology-trace/packet-flow-v2", v2),
                       ("/api/v1/topology-trace/hubble-flows", hub),
                       ("/api/v1/topology-trace/packet-flow", {"cluster_id": str(world["bound"].id), "host": "a.b"}),
                       ("/api/v1/topology-trace", {"cluster_id": str(world["bound"].id), "namespace": "default",
                                                   "target_type": "service", "target_name": "x"})):
        r = client_as(world["viewer_outsider"]).post(path, json=body)
        assert r.status_code == 403, (path, r.status_code, r.text)
    # 바인딩 테넌트의 viewer 는 조회 허용(정책 6) — 권한 판정을 통과해 kubeconfig 안내까지 간다
    r = client_as(world["viewer_member"]).post("/api/v1/topology-trace/hubble-flows", json=hub)
    assert r.status_code == 200 and "kubeconfig" in (r.json().get("error") or "")


def test_tcpdump_is_operator_only(client_as, world):
    r = client_as(world["viewer_member"]).post(
        "/api/v1/topology-trace/tcpdump", json={"host": OPEN_HOST, "interface": "eth0", **SSH_CRED})
    assert r.status_code == 403


# ── D-170 실행 감사 ──────────────────────────────────────────────────────────

def test_etcdctl_audit_after_run_masks_secrets(client_as, world, monkeypatch, db):
    import app.routers.etcdctl as mod
    monkeypatch.setattr(mod, "run_bulk", _fake_run_bulk(status="error", exit_code=1, error="exit 1"))
    body = {"host": OPEN_HOST, "args": "--user root:etcd-pw --password=etcd-pw2 member list",
            "extra_env": {"ETCDCTL_PASSWORD": "env-pw"}, **SSH_CRED}
    r = client_as(world["op_member"]).post(f"/api/v1/clusters/{world['open'].id}/etcdctl/run", json=body)
    assert r.status_code == 200
    executed = r.json()["executed_command"]
    for secret in ("etcd-pw", "etcd-pw2", "env-pw"):
        assert secret not in executed
    rows = _audits(db, world["op_member"], "etcdctl.run")
    assert len(rows) == 1
    row = rows[0]
    assert row.status == "failure"  # 실행 전 success 고정 기록 금지 — 실제 결과
    assert row.details["host"] == OPEN_HOST and row.details["exit_code"] == 1
    dumped = json.dumps(row.details)
    for secret in ("etcd-pw", "etcd-pw2", "env-pw", "ssh-pw"):
        assert secret not in dumped
    assert "****" in row.details["command"] and len(row.details["command"]) <= 500


def test_etcdctl_logs_audited(client_as, world, monkeypatch, db):
    import app.routers.etcdctl as mod
    monkeypatch.setattr(mod, "run_bulk", _fake_run_bulk())
    r = client_as(world["op_member"]).post(
        f"/api/v1/clusters/{world['open'].id}/etcdctl/logs", json={"host": OPEN_HOST, **SSH_CRED})
    assert r.status_code == 200
    rows = _audits(db, world["op_member"], "etcdctl.logs")
    assert len(rows) == 1 and rows[0].status == "success" and "journalctl" in rows[0].details["command"]


def test_mc_run_audited_and_alias_keys_masked(client_as, world, monkeypatch, db):
    import app.routers.mc_client as mod
    monkeypatch.setattr(mod, "run_bulk", _fake_run_bulk())
    body = {"host": OPEN_HOST, "args": "alias set local http://h:9000 AKIAXX SECRETXX", **SSH_CRED}
    r = client_as(world["op_member"]).post(f"/api/v1/clusters/{world['bound'].id}/mc/run", json=body)
    assert r.status_code == 200
    assert "SECRETXX" not in r.json()["executed_command"]
    rows = _audits(db, world["op_member"], "mc.run")
    assert len(rows) == 1 and rows[0].status == "success"
    assert rows[0].target_id == str(world["bound"].id)
    assert "SECRETXX" not in rows[0].details["command"] and "AKIAXX" not in rows[0].details["command"]


def test_mc_shared_presets_update_audited(client_as, world, db):
    from app.models.app_setting import AppSetting
    prev = db.query(AppSetting).filter(AppSetting.key == "mc_presets_shared").first()
    prev_value = prev.value if prev else None
    try:
        r = client_as(world["admin"]).put("/api/v1/mc/presets/shared", json={"presets": [
            {"key": "k1", "label": "l", "args": "alias set x http://h AK SK"}]})
        assert r.status_code == 200
        rows = _audits(db, world["admin"], "mc.presets.shared.update")
        assert len(rows) == 1 and rows[0].details["count"] == 1
        assert "SK" not in rows[0].details["presets"][0]["args"].split()
    finally:
        db.expire_all()
        row = db.query(AppSetting).filter(AppSetting.key == "mc_presets_shared").first()
        if prev is None and row is not None:
            db.delete(row)
        elif row is not None:
            row.value = prev_value
        db.commit()


def test_bulk_exec_audit_after_run_with_hosts_cap(client_as, world, monkeypatch, db):
    import app.routers.bulk_exec as mod
    monkeypatch.setattr(mod, "run_bulk", _fake_run_bulk())
    targets = [{"host": f"192.0.2.{i}"} for i in range(25)]
    body = {"action": "ssh", "command": "export API_KEY=abc123 && uptime", "targets": targets, **SSH_CRED}
    r = client_as(world["op_outsider"]).post("/api/v1/bulk-exec/run", json=body)
    assert r.status_code == 200
    rows = _audits(db, world["op_outsider"], "bulk_exec.run")
    assert len(rows) == 1
    d = rows[0].details
    assert rows[0].status == "success"
    assert d["target_count"] == 25 and len(d["hosts"]) == 20 and d["hosts"][0] == "192.0.2.0"
    assert "abc123" not in d["command"] and "uptime" in d["command"]
    assert d["ok_count"] == 25 and d["error_count"] == 0


def test_tcpdump_capture_audited_as_host_target(client_as, world, monkeypatch, db):
    import app.routers.topology_trace as mod
    from app.services.tcpdump_runner import CaptureResult
    monkeypatch.setattr(mod, "tcpdump_capture", lambda target, **k: CaptureResult(
        host=target.host, status="ok", executed="tcpdump -i eth0 -c 10", exit_code=0, duration_ms=5))
    r = client_as(world["op_outsider"]).post(
        "/api/v1/topology-trace/tcpdump", json={"host": OUTSIDE_HOST, "interface": "eth0", **SSH_CRED})
    assert r.status_code == 200
    rows = _audits(db, world["op_outsider"], "tcpdump.capture")
    assert len(rows) == 1 and rows[0].status == "success"
    assert rows[0].target_type == "host" and rows[0].target_id == OUTSIDE_HOST


# ── 실행 도중 예외 — 감사 정확히 1행(failure + 마스킹한 예외 요약) ───────────

def _raising_run_bulk(msg="boom --password=leak-pw"):
    async def _run(targets, **kw):
        raise RuntimeError(msg)
    return _run


def _assert_one_failure(db, user, action):
    rows = _audits(db, user, action)
    assert len(rows) == 1, [r.status for r in rows]
    row = rows[0]
    assert row.status == "failure" and row.details["result"] == "exception"
    assert "RuntimeError" in row.details["error"] and "leak-pw" not in json.dumps(row.details)
    return row


def test_etcdctl_exception_mid_run_audited_once(client_as, world, monkeypatch, db):
    import app.routers.etcdctl as mod
    monkeypatch.setattr(mod, "run_bulk", _raising_run_bulk())
    c = client_as(world["op_member"])
    with pytest.raises(RuntimeError):
        c.post(f"/api/v1/clusters/{world['open'].id}/etcdctl/run",
               json={"host": OPEN_HOST, "args": "--password=etcd-pw member list", **SSH_CRED})
    row = _assert_one_failure(db, world["op_member"], "etcdctl.run")
    assert "etcd-pw" not in row.details["command"] and row.details["host"] == OPEN_HOST
    with pytest.raises(RuntimeError):
        c.post(f"/api/v1/clusters/{world['open'].id}/etcdctl/logs", json={"host": OPEN_HOST, **SSH_CRED})
    _assert_one_failure(db, world["op_member"], "etcdctl.logs")


def test_mc_exception_mid_run_audited_once(client_as, world, monkeypatch, db):
    import app.routers.mc_client as mod
    monkeypatch.setattr(mod, "run_bulk", _raising_run_bulk())
    with pytest.raises(RuntimeError):
        client_as(world["op_member"]).post(
            f"/api/v1/clusters/{world['open'].id}/mc/run",
            json={"host": OPEN_HOST, "args": "alias set x http://h:9000 AKX SKX", **SSH_CRED})
    row = _assert_one_failure(db, world["op_member"], "mc.run")
    assert "SKX" not in row.details["command"]


def test_bulk_exec_exception_mid_run_audited_once(client_as, world, monkeypatch, db):
    import app.routers.bulk_exec as mod
    monkeypatch.setattr(mod, "run_bulk", _raising_run_bulk())
    with pytest.raises(RuntimeError):
        client_as(world["op_outsider"]).post("/api/v1/bulk-exec/run", json={
            "action": "ssh", "command": "export API_KEY=abc123 && uptime",
            "targets": [{"host": OUTSIDE_HOST}], **SSH_CRED})
    rows = _audits(db, world["op_outsider"], "bulk_exec.run")
    assert len(rows) == 1 and rows[0].status == "failure"
    d = rows[0].details
    assert d["ok_count"] == 0 and "RuntimeError" in d["error"]
    assert "leak-pw" not in json.dumps(d) and "abc123" not in json.dumps(d)


def test_bulk_exec_fetch_file_exception_audited_once(client_as, world, monkeypatch, db):
    import app.routers.bulk_exec as mod

    def _boom(*a, **k):
        raise RuntimeError("boom --password=leak-pw")
    monkeypatch.setattr(mod, "fetch_remote_file", _boom)
    with pytest.raises(RuntimeError):
        client_as(world["op_outsider"]).post("/api/v1/bulk-exec/fetch-file", json={
            "host": OUTSIDE_HOST, "remote_path": "/etc/hosts", **SSH_CRED})
    _assert_one_failure(db, world["op_outsider"], "bulk_exec.fetch_file")


def test_tcpdump_exception_mid_run_audited_once(client_as, world, monkeypatch, db):
    import app.routers.topology_trace as mod

    def _boom(*a, **k):
        raise RuntimeError("boom --password=leak-pw")
    monkeypatch.setattr(mod, "tcpdump_capture", _boom)
    monkeypatch.setattr(mod, "list_remote_interfaces", _boom)
    c = client_as(world["op_outsider"])
    with pytest.raises(RuntimeError):
        c.post("/api/v1/topology-trace/tcpdump", json={"host": OUTSIDE_HOST, "interface": "eth0", **SSH_CRED})
    row = _assert_one_failure(db, world["op_outsider"], "tcpdump.capture")
    assert row.target_type == "host" and row.target_id == OUTSIDE_HOST
    with pytest.raises(RuntimeError):
        c.post("/api/v1/topology-trace/tcpdump/interfaces", json={"host": OUTSIDE_HOST, **SSH_CRED})
    rows = _audits(db, world["op_outsider"], "tcpdump.interfaces")
    assert len(rows) == 1 and rows[0].status == "failure" and "RuntimeError" in rows[0].details["error"]
    assert "leak-pw" not in json.dumps(rows[0].details)


# ── host → cluster 매칭 정규화(우회 표기) ────────────────────────────────────

def _bound_variants(ip: str) -> list[str]:
    import ipaddress
    a, b, c, d = (int(x) for x in ip.split("."))
    return [
        str(int(ipaddress.IPv4Address(ip))),        # 정수
        f"{a}.{b}.{c * 256 + d}",                     # 축약(a.b.c16)
        f"{a}.{(b << 16) | (c << 8) | d}",            # 축약(a.b24)
        f"0{a:o}.0{b:o}.0{c:o}.0{d:o}",               # 8진
        f"0x{a:02x}.0x{b:02x}.0x{c:02x}.0x{d:02x}",   # 16진
        f"::ffff:{ip}",                               # IPv4-mapped
        f"[::FFFF:{ip}]",
        f" {ip} ",
    ]


def test_norm_ip_legacy_and_mapped_forms():
    from app.services.cluster_access import _norm_ip
    for v in _bound_variants("10.0.0.11"):
        assert _norm_ip(v) == "10.0.0.11", v
    assert _norm_ip("fe80::1%eth0") == "fe80::1"
    for v in ("node1", "node1.", "10.0.0.11 x", "", "999999999999"):
        assert _norm_ip(v) is None, v


def test_host_variants_match_bound_cluster(world, db):
    from app.services.cluster_access import cluster_ids_for_host
    for v in [BOUND_HOST, *_bound_variants(BOUND_HOST)]:
        assert world["bound"].id in cluster_ids_for_host(db, v), v
    assert cluster_ids_for_host(db, OUTSIDE_HOST) == set()


def test_host_variant_bypass_is_403(client_as, world, monkeypatch):
    import app.routers.etcdctl as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    c = client_as(world["op_outsider"])
    for v in _bound_variants(BOUND_HOST):
        r = c.post(f"/api/v1/clusters/{world['open'].id}/etcdctl/run",
                   json={"host": v, "args": "endpoint health", **SSH_CRED})
        assert r.status_code == 403, (v, r.status_code)
    assert fake.calls == []


def test_infra_hostname_case_and_trailing_dot(world, db):
    from app.models.infra_node import InfraNode
    from app.services.cluster_access import cluster_ids_for_host
    name = f"xnode-{uuid.uuid4().hex[:6]}.example"
    node = InfraNode(cluster_id=world["bound"].id, hostname=name, role="worker")
    db.add(node)
    db.commit()
    try:
        for v in (name, name.upper(), name + ".", f" {name.upper()}. "):
            assert world["bound"].id in cluster_ids_for_host(db, v), v
    finally:
        db.delete(node)
        db.commit()


def test_dns_resolved_name_matches_and_failure_falls_back(world, db, monkeypatch):
    import socket
    import time

    import app.services.cluster_access as ca

    def _fake(host):
        if host == "bound-alias.test":
            return {BOUND_HOST}
        if host == "slow.test":
            time.sleep(0.5)
            return {BOUND_HOST}
        raise socket.gaierror("no such host")
    monkeypatch.setattr(ca, "_getaddrinfo_ips", _fake)
    monkeypatch.setattr(ca, "_RESOLVE_TIMEOUT_SEC", 0.1)
    ids, ips = ca.resolve_hosts_scope(db, ["bound-alias.test", "missing.test", "::ffff:" + OPEN_HOST])
    assert world["bound"].id in ids and world["open"].id in ids
    assert ips["bound-alias.test"] == [BOUND_HOST]
    assert ips["missing.test"] == [] and ips["::ffff:" + OPEN_HOST] == [OPEN_HOST]
    # 해석 실패·시간 초과는 리터럴 비교만(예외 없이) — 이전 동작 수준
    assert ca.cluster_ids_for_host(db, "missing.test") == set()
    assert ca.cluster_ids_for_host(db, "slow.test") == set()


async def test_async_host_scope_matches_sync(world, db, monkeypatch):
    """async 판은 sync 판과 같은 코어를 쓴다 — 우회 표기·DNS 결과·실패 폴백이 같은 판정."""
    import socket

    import app.services.cluster_access as ca

    def _fake(host):
        if host == "bound-alias.test":
            return {BOUND_HOST}
        raise socket.gaierror("no such host")
    monkeypatch.setattr(ca, "_getaddrinfo_ips", _fake)
    hosts = ["bound-alias.test", "missing.test", OUTSIDE_HOST, "::ffff:" + OPEN_HOST,
             *_bound_variants(BOUND_HOST)]
    assert await ca.aresolve_hosts_scope(db, hosts) == ca.resolve_hosts_scope(db, hosts)
    assert await ca.acluster_ids_for_hosts(db, (h for h in hosts)) == ca.cluster_ids_for_hosts(db, hosts)
    assert world["bound"].id in await ca.acluster_ids_for_host(db, "bound-alias.test")
    assert await ca.acluster_ids_for_host(db, "missing.test") == set()
    assert await ca.acluster_ids_for_host(db, OUTSIDE_HOST) == set()
    assert await ca.acluster_ids_for_hosts(db, []) == set()


async def test_async_host_scope_does_not_block_event_loop(world, db, monkeypatch):
    """느린 DNS 를 기다리는 동안 다른 코루틴이 계속 돌고, 전체 상한 안에 리터럴 폴백으로 끝난다."""
    import asyncio
    import time

    import app.services.cluster_access as ca

    def _fake(host):
        if host == "bound-alias.test":
            return {BOUND_HOST}
        time.sleep(0.6)  # slow.test — 상한보다 오래 걸리는 조회
        return {BOUND_HOST}
    monkeypatch.setattr(ca, "_getaddrinfo_ips", _fake)
    monkeypatch.setattr(ca, "_RESOLVE_TIMEOUT_SEC", 0.3)

    ticks = 0

    async def _ticker():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    async def _measure(coro_fn):
        nonlocal ticks
        task = asyncio.create_task(_ticker())
        await asyncio.sleep(0)  # ticker 를 한 번 돌려 둔다
        ticks = 0
        started = time.monotonic()
        result = await coro_fn()
        elapsed = time.monotonic() - started
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return result, elapsed, ticks

    async def _async_call():
        return await ca.aresolve_hosts_scope(db, ["slow.test", "bound-alias.test"])

    (ids, ips), elapsed, async_ticks = await _measure(_async_call)
    assert elapsed < 0.55, elapsed  # 0.3s 상한 + DB 여유 — 0.6s 조회를 기다리지 않는다
    assert async_ticks >= 10, async_ticks  # 기다리는 동안 루프가 다른 코루틴을 돌렸다
    assert world["bound"].id in ids  # 제때 풀린 이름은 반영
    assert ips["slow.test"] == [] and ips["bound-alias.test"] == [BOUND_HOST]  # 시간 초과 = 리터럴 폴백

    # 대조군: sync 판을 루프 안에서 부르면 같은 대기 동안 다른 코루틴이 전혀 돌지 못한다(측정이 유효함).
    async def _sync_call():
        return ca.resolve_hosts_scope(db, ["slow.test"])

    _, _, sync_ticks = await _measure(_sync_call)
    assert sync_ticks == 0, sync_ticks


# ── 정책 2: cilium-dbg 읽기 전용 allowlist ───────────────────────────────────

@pytest.fixture
def cilium_stub(monkeypatch):
    import app.routers.cilium_trace as mod
    calls = []

    def _exec(kc, **kw):
        calls.append(kw)
        return {"raw": "ok", "exit_code": 0, "error": None, "executed": "kubectl exec", "pod_name": "cilium-x",
                "duration_ms": 1}

    monkeypatch.setattr(mod, "ensure_kubeconfig_file", lambda c: "/tmp/fake-kubeconfig")
    monkeypatch.setattr(mod, "exec_cilium_command", _exec)
    return calls


def test_cilium_mutating_command_admin_only(client_as, world, cilium_stub, db):
    url = f"/api/v1/cilium/{world['open'].id}/exec-command"
    body = {"command_args": "bpf ct flush global"}
    assert client_as(world["viewer_member"]).post(url, json=body).status_code == 403
    r = client_as(world["op_member"]).post(url, json=body)
    assert r.status_code == 403 and "admin" in r.json()["detail"]
    assert cilium_stub == []
    denied = _audits(db, world["op_member"], "cilium.exec")
    assert len(denied) == 1 and denied[0].status == "failure"
    r = client_as(world["admin"]).post(url, json=body)
    assert r.status_code == 200
    assert cilium_stub[-1]["allow_any"] is True


def test_cilium_readonly_command_allowed_for_operator(client_as, world, cilium_stub):
    url = f"/api/v1/cilium/{world['open'].id}/exec-command"
    r = client_as(world["op_member"]).post(url, json={"command_args": "bpf lb list"})
    assert r.status_code == 200
    assert cilium_stub[-1]["allow_any"] is False
    r = client_as(world["viewer_member"]).get(f"/api/v1/cilium/{world['open'].id}/exec-command/allowlist")
    assert r.status_code == 200 and "status" in r.json()["commands"]


def test_cilium_service_refuses_outside_allowlist_without_flag():
    from app.services.cilium_trace_service import exec_cilium_command
    res = exec_cilium_command("/nonexistent", pod_name="p", command_args="endpoint delete 1")
    assert res.get("forbidden") is True and res["executed"] is None


# ── D-172 WS close code ──────────────────────────────────────────────────────

def _ws_close_code(path: str, init: dict | None = None) -> int:
    from fastapi.testclient import TestClient

    from app.main import app
    client = TestClient(app)
    with client.websocket_connect(path) as ws:
        if init is not None:
            ws.send_text(json.dumps({"type": "init", **init}))
        with pytest.raises(WebSocketDisconnect) as exc:
            for _ in range(5):
                ws.receive_text()
    return exc.value.code


def _token(user):
    from app.auth.security import create_access_token
    return create_access_token(user.username, role=user.role)


def test_ws_bad_token_is_4401(world):
    cid = world["open"].id
    assert _ws_close_code(f"/api/v1/k8s/{cid}/k9s?token=not-a-jwt") == 4401
    assert _ws_close_code(f"/api/v1/k8s/{cid}/k9s") == 4401
    assert _ws_close_code("/api/v1/node-ssh/session?token=bad") == 4401
    assert _ws_close_code(f"/api/v1/k8s/{cid}/exec?namespace=default&pod=p&token=bad") == 4401


def test_ws_viewer_role_is_4402(world):
    cid = world["open"].id
    tok = _token(world["viewer_member"])
    assert _ws_close_code(f"/api/v1/k8s/{cid}/k9s?token={tok}") == 4402
    assert _ws_close_code(f"/api/v1/node-ssh/session?token={tok}") == 4402
    assert _ws_close_code(f"/api/v1/k8s/{cid}/exec?namespace=default&pod=p&token={tok}") == 4402


def test_k9s_init_host_in_other_tenant_is_4413(world, db):
    # 바인딩 없는 경로 클러스터로 들어와 init host 를 다른 테넌트 control-plane 으로 겨눈다(D-169 ④).
    tok = _token(world["op_outsider"])
    code = _ws_close_code(f"/api/v1/k8s/{world['open'].id}/k9s?token={tok}",
                          init={"host": BOUND_HOST, "password": "pw"})
    assert code == 4413
    rows = _audits(db, world["op_outsider"], "k9s.ssh.open")
    assert len(rows) == 1 and rows[0].status == "failure"
    assert rows[0].details["reason"] == "tenant_forbidden"
