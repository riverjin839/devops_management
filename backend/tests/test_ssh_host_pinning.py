"""SSH 콘솔 접속 주소 고정(DNS rebinding 차단) + 해석 실패 host 거부(fail-closed) 회귀.

- 테넌트 판정이 DNS 로 푼 이름은 판정한 IP(resolver 순서의 첫 IP)로 TCP 를 연다(``SSHTarget.connect_ip``).
  호스트 키 검증(TOFU)·결과 host·감사는 원래 이름 그대로.
- 격리 사용 중(ClusterBinding 존재) IP 리터럴도, 저장된 노드 리터럴도 아니고 DNS 도 실패한 이름은 403
  (WebSocket 은 4413) — SSH 는 시도조차 하지 않는다. 바인딩이 없으면 예전 동작(허용, 고정 없음).
- IP 리터럴은 고정·DNS 대상이 아니다(원문 그대로 접속).

DNS 는 ``cluster_access._getaddrinfo_ips`` 를, SSH 는 run_bulk/fetch_remote_file/tcpdump/test_connection/
connect_client 를 모킹한다. paramiko 수준 확인은 로컬 루프백 SSH 서버로 실제 핸드셰이크를 한다.
"""
import json
import os
import socket
import threading
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

import paramiko  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import app.services.cluster_access as ca  # noqa: E402
import app.services.ssh_runner as ssh_runner  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.infra_node import InfraNode  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.ssh_runner import SSHResult, SSHTarget  # noqa: E402

BOUND_HOST = "10.9.81.1"
OPEN_HOST = "10.9.80.1"
OPEN_HOST_2 = "10.9.80.2"
OUTSIDE_HOST = "192.0.2.88"

ALIAS = "pin-alias.test"          # → OPEN_HOST (바인딩 없는 클러스터) — 허용 + 고정
MULTI = "pin-multi.test"          # → [OPEN_HOST_2, OPEN_HOST] — 첫 IP 로 고정
SPLIT = "pin-split.test"          # → [OPEN_HOST, BOUND_HOST] — 판정은 IP 전부(바인딩 클러스터 포함)
MISSING = "pin-missing.test"      # 해석 실패

SSH_CRED = {"username": "root", "password": "ssh-pw"}
UNRESOLVED_MARK = "DNS 해석 실패"

_DNS = {
    ALIAS: [OPEN_HOST],
    MULTI: [OPEN_HOST_2, OPEN_HOST],
    SPLIT: [OPEN_HOST, BOUND_HOST],
}


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def fake_dns(monkeypatch):
    """이름 해석 대역 — 조회한 이름을 기록한다(IP 리터럴은 조회되면 안 된다)."""
    asked: list[str] = []

    def _fake(host):
        asked.append(host)
        if host in _DNS:
            return list(_DNS[host])
        raise socket.gaierror("no such host")

    monkeypatch.setattr(ca, "_getaddrinfo_ips", _fake)
    return asked


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    c_open = Cluster(name=f"pinopen-{tag}", api_endpoint="https://open:6443",
                     node_ips=json.dumps([OPEN_HOST, OPEN_HOST_2]))
    c_bound = Cluster(name=f"pinbound-{tag}", api_endpoint="https://bound:6443",
                      node_ips=json.dumps([BOUND_HOST]))
    users = {
        key: User(username=f"pin{key}-{tag}", hashed_password="x", role=role, is_active=True)
        for key, role in (("op_member", "operator"), ("op_outsider", "operator"))
    }
    tenant = Tenant(name=f"pinteam-{tag}")
    db.add_all([c_open, c_bound, tenant, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["op_member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="operate"),
    ])
    db.commit()
    yield {"open": c_open, "bound": c_bound, "tenant": tenant, **users}
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(InfraNode).filter(InfraNode.cluster_id.in_([c_open.id, c_bound.id])).delete(
        synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_([c_open.id, c_bound.id])).delete(
        synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_([c_open.id, c_bound.id])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def no_isolation(monkeypatch):
    """바인딩이 하나도 없는 설치(격리 미사용)를 흉내 — 공유 테스트 DB 의 다른 행과 무관하게."""
    monkeypatch.setattr(ca, "_isolation_enabled", lambda db: False)


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


def _fake_run_bulk():
    calls = []

    async def _run(targets, **kw):
        calls.append(list(targets))
        return [SSHResult(host=t.host, status="ok", exit_code=0, stdout="", stderr="",
                          duration_ms=1, error=None) for t in targets]

    _run.calls = calls
    return _run


def _audits(db, user, action):
    db.expire_all()
    return (db.query(AuditLog)
            .filter(AuditLog.actor_user_id == user.id, AuditLog.action == action)
            .order_by(AuditLog.created_at.asc()).all())


# ── 공용 코어 ────────────────────────────────────────────────────────────────

def test_scope_pins_first_resolved_ip_and_flags_unresolved(world, db, fake_dns):
    scope = ca.resolve_hosts_scope(db, [ALIAS, MULTI, MISSING, OUTSIDE_HOST, f" {ALIAS} "])
    assert scope.pinned == {ALIAS: OPEN_HOST, MULTI: OPEN_HOST_2}  # resolver 순서의 첫 IP
    assert scope.connect_ip(f"  {ALIAS} ") == OPEN_HOST  # 호출부의 공백 섞인 host 도 같은 키
    assert scope.connect_ip(OUTSIDE_HOST) is None  # IP 리터럴은 고정하지 않는다
    assert scope.unresolved == [MISSING]
    assert scope.ips_by_host[MULTI] == sorted([OPEN_HOST, OPEN_HOST_2])
    assert OUTSIDE_HOST not in fake_dns  # IP 리터럴은 DNS 조회 대상이 아니다


async def test_async_scope_matches_sync(world, db, fake_dns):
    hosts = [ALIAS, MULTI, SPLIT, MISSING, OUTSIDE_HOST]
    assert await ca.aresolve_hosts_scope(db, hosts) == ca.resolve_hosts_scope(db, hosts)


def test_multi_ip_name_checks_every_resolved_ip(world, db, fake_dns, client_as, monkeypatch):
    """한 IP 만 바인딩 클러스터여도 판정은 IP 전부(합집합)를 본다 — 첫 IP 로만 판정하지 않는다."""
    import app.routers.etcdctl as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    scope = ca.resolve_hosts_scope(db, [SPLIT])
    assert world["bound"].id in scope.cluster_ids and scope.pinned[SPLIT] == OPEN_HOST
    r = client_as(world["op_outsider"]).post(
        f"/api/v1/clusters/{world['open'].id}/etcdctl/run",
        json={"host": SPLIT, "args": "endpoint health", **SSH_CRED})
    assert r.status_code == 403 and "테넌트" in r.json()["detail"]
    assert fake.calls == []


def test_literal_infra_hostname_counts_as_resolved(world, db, fake_dns):
    name = f"pin-node-{uuid.uuid4().hex[:6]}.example"
    db.add(InfraNode(cluster_id=world["bound"].id, hostname=name, role="worker"))
    db.commit()
    scope = ca.resolve_hosts_scope(db, [name.upper() + "."])
    assert scope.unresolved == [] and scope.pinned == {}  # 거부 안 함, 고정할 IP 도 없음(원문으로 접속)
    assert world["bound"].id in scope.cluster_ids


def test_literal_cluster_node_ip_entry_counts_as_resolved(world, db, fake_dns):
    """``clusters.node_ips`` 에 이름이 리터럴로 들어 있어도(수집값이 호스트명인 설치) 알려진 이름이다."""
    name = f"pin-cp-{uuid.uuid4().hex[:6]}.example"
    world["open"].node_ips = json.dumps([OPEN_HOST, OPEN_HOST_2, name])
    db.commit()
    scope = ca.resolve_hosts_scope(db, [name])
    assert scope.unresolved == [] and world["open"].id in scope.cluster_ids


def test_no_bindings_keeps_old_behaviour(db, fake_dns, no_isolation):
    scope = ca.resolve_hosts_scope(db, [MISSING, ALIAS, OPEN_HOST])
    assert scope.unresolved == [] and scope.pinned == {} and scope.cluster_ids == set()
    assert fake_dns == []  # 격리 미사용이면 DNS 도 하지 않는다
    assert ca.cluster_ids_for_host(db, MISSING) == set()


# ── paramiko: TCP 는 고정 IP 로, 호스트 키는 이름으로 ────────────────────────

def _capture_paramiko(monkeypatch):
    seen: dict = {"socket": [], "socks": [], "connect": [], "known_key_host": []}

    class _Sock:
        closed = False

        def close(self):
            self.closed = True

    def _create_connection(addr, timeout=None):
        seen["socket"].append((addr, timeout))
        sock = _Sock()
        seen["socks"].append(sock)
        return sock

    def _connect(self, **kw):
        seen["connect"].append(kw)

    monkeypatch.setattr(ssh_runner.socket, "create_connection", _create_connection)
    monkeypatch.setattr(paramiko.SSHClient, "connect", _connect)
    monkeypatch.setattr(ssh_runner, "apply_known_key",
                        lambda client, host, port: seen["known_key_host"].append((host, port)))
    return seen


def test_build_client_connects_to_pinned_ip_keeps_hostname(monkeypatch):
    seen = _capture_paramiko(monkeypatch)
    tgt = SSHTarget(host="node-a.example", port=2222, password="pw", connect_ip="10.1.2.3")
    ssh_runner._build_client(tgt, connect_timeout=5)
    assert seen["socket"] == [(("10.1.2.3", 2222), 5)]  # TCP 는 판정한 IP 로
    kw = seen["connect"][0]
    assert kw["hostname"] == "node-a.example"  # paramiko 호스트 키 조회·TOFU 기록 키는 이름
    assert kw["sock"] is not None and kw["port"] == 2222
    assert seen["known_key_host"] == [("node-a.example", 2222)]  # 저장 키 로드도 이름 기준


def test_build_client_without_pin_unchanged(monkeypatch):
    seen = _capture_paramiko(monkeypatch)
    ssh_runner._build_client(SSHTarget(host="10.1.2.3", password="pw"), connect_timeout=5)
    assert seen["socket"] == []
    assert seen["connect"][0]["hostname"] == "10.1.2.3" and "sock" not in seen["connect"][0]


def test_build_client_closes_pinned_socket_on_failure(monkeypatch):
    seen = _capture_paramiko(monkeypatch)  # 가짜 소켓 — 실제 네트워크 연결 없음

    def _boom(self, **kw):
        raise paramiko.AuthenticationException("bad")

    monkeypatch.setattr(paramiko.SSHClient, "connect", _boom)
    with pytest.raises(paramiko.AuthenticationException):
        ssh_runner._build_client(SSHTarget(host="n", password="pw", connect_ip="10.1.2.3"), 5)
    assert len(seen["socks"]) == 1 and seen["socks"][0].closed


class _PwServer(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if password == "pw" else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"


def test_real_handshake_over_pinned_ip_uses_hostname_for_host_key(monkeypatch):
    """실제 paramiko 핸드셰이크 — 해석되지 않는 이름 + 루프백 IP 고정으로 접속이 성립하고,
    TOFU 기록(missing_host_key)·저장 키 로드는 이름 기준이다(IP 가 아니다)."""
    import app.services.ssh_host_keys as hk

    loaded, saved = [], []
    monkeypatch.setattr(hk, "_load", lambda host, port: loaded.append((host, port)))
    monkeypatch.setattr(hk, "_save", lambda host, port, key: saved.append((host, port, key.get_name())))

    host_key = paramiko.RSAKey.generate(2048)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    srv.settimeout(10)
    port = srv.getsockname()[1]
    server_err: list = []

    def _serve():
        try:
            conn, _ = srv.accept()
            t = paramiko.Transport(conn)
            t.add_server_key(host_key)
            t.start_server(server=_PwServer())
            t.accept(5)  # 채널 요청 없음 — 인증까지만
            t.close()
        except Exception as e:  # noqa: BLE001
            server_err.append(e)

    th = threading.Thread(target=_serve, daemon=True)
    th.start()
    name = "pinned-node.invalid"  # .invalid — 실제로는 해석될 수 없는 이름
    client = ssh_runner.connect_client(
        SSHTarget(host=name, port=port, username="u", password="pw", connect_ip="127.0.0.1"),
        connect_timeout=5)
    try:
        assert client.get_transport().is_authenticated()
        assert client.get_transport().getpeername()[0] == "127.0.0.1"
    finally:
        client.close()
        th.join(5)
        srv.close()
    assert not server_err, server_err
    assert loaded == [(name, port)]
    # paramiko 는 비표준 포트에서 "[이름]:포트" 를 넘기지만 저장은 _load 와 같은 (이름, 포트) 로 정규화한다.
    assert len(saved) == 1 and saved[0][0] == name and saved[0][1] == port


def test_non_default_port_known_key_is_actually_compared(monkeypatch):
    """22 외 포트 — 기록된 키가 서버 키와 다르면 접속을 거부한다(이전에는 "[host]:port" 이름이 어긋나
    기록 키가 조회되지 않아 바뀐 키가 TOFU 로 그대로 통과했다)."""
    import app.services.ssh_host_keys as hk

    stale = paramiko.RSAKey.generate(2048)
    monkeypatch.setattr(hk, "_load", lambda host, port: stale)
    monkeypatch.setattr(hk, "_save", lambda host, port, key: None)

    host_key = paramiko.RSAKey.generate(2048)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    srv.settimeout(10)
    port = srv.getsockname()[1]

    def _serve():
        try:
            conn, _ = srv.accept()
            t = paramiko.Transport(conn)
            t.add_server_key(host_key)
            t.start_server(server=_PwServer())
            t.accept(3)
            t.close()
        except Exception:  # noqa: BLE001
            pass

    th = threading.Thread(target=_serve, daemon=True)
    th.start()
    try:
        with pytest.raises(Exception) as ei:
            client = ssh_runner.connect_client(
                SSHTarget(host="changed-key.invalid", port=port, username="u", password="pw",
                          connect_ip="127.0.0.1"),
                connect_timeout=5)
            client.close()
        assert "key" in str(ei.value).lower() or isinstance(ei.value, paramiko.BadHostKeyException)
    finally:
        th.join(5)
        srv.close()


def test_pin_prefers_ipv4_over_ipv6(world, db, fake_dns, monkeypatch):
    """여러 주소로 풀리면 IPv4 를 고정한다 — 컨테이너에 IPv6 경로가 없을 때 접속 실패를 피한다."""
    monkeypatch.setitem(_DNS, "dual.example", ["2001:db8::5", "198.51.100.7"])
    scope = ca.resolve_hosts_scope(db, ["dual.example"])
    assert scope.connect_ip("dual.example") == "198.51.100.7"


# ── REST 콘솔: 고정 IP 전달 ──────────────────────────────────────────────────

def test_etcdctl_and_logs_connect_to_pinned_ip(world, fake_dns, client_as, monkeypatch, db):
    import app.routers.etcdctl as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    c = client_as(world["op_outsider"])
    base = f"/api/v1/clusters/{world['open'].id}/etcdctl"
    assert c.post(f"{base}/run", json={"host": MULTI, "args": "endpoint health", **SSH_CRED}).status_code == 200
    assert c.post(f"{base}/logs", json={"host": ALIAS, **SSH_CRED}).status_code == 200
    (run_t,), (logs_t,) = fake.calls
    assert (run_t.host, run_t.connect_ip) == (MULTI, OPEN_HOST_2)
    assert (logs_t.host, logs_t.connect_ip) == (ALIAS, OPEN_HOST)
    rows = _audits(db, world["op_outsider"], "etcdctl.run")
    assert rows and rows[0].details["host"] == MULTI  # 감사는 원래 이름


def test_mc_connects_to_pinned_ip(world, fake_dns, client_as, monkeypatch):
    import app.routers.mc_client as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    r = client_as(world["op_outsider"]).post(
        f"/api/v1/clusters/{world['open'].id}/mc/run", json={"host": ALIAS, "args": "ls x", **SSH_CRED})
    assert r.status_code == 200
    (t,), = fake.calls
    assert (t.host, t.connect_ip) == (ALIAS, OPEN_HOST)


def test_bulk_exec_run_pins_each_target(world, fake_dns, client_as, monkeypatch):
    import app.routers.bulk_exec as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    body = {"action": "ssh", "command": "uptime",
            "targets": [{"host": ALIAS}, {"host": MULTI}, {"host": OUTSIDE_HOST}], **SSH_CRED}
    r = client_as(world["op_outsider"]).post("/api/v1/bulk-exec/run", json=body)
    assert r.status_code == 200
    got = {t.host: t.connect_ip for t in fake.calls[0]}
    assert got == {ALIAS: OPEN_HOST, MULTI: OPEN_HOST_2, OUTSIDE_HOST: None}
    assert [x["host"] for x in r.json()["results"]] == [ALIAS, MULTI, OUTSIDE_HOST]  # 결과 label 은 원문


def test_bulk_exec_fetch_file_pins(world, fake_dns, client_as, monkeypatch):
    import app.routers.bulk_exec as mod
    from app.services.ssh_runner import FetchFileResult
    seen = []

    def _fetch(target, remote_path, connect_timeout, *a, **k):
        seen.append(target)
        return FetchFileResult(result=SSHResult(host=target.host, status="ok", exit_code=0, stdout="x",
                                                stderr="", duration_ms=1, error=None))
    monkeypatch.setattr(mod, "fetch_remote_file", _fetch)
    r = client_as(world["op_outsider"]).post(
        "/api/v1/bulk-exec/fetch-file", json={"host": ALIAS, "remote_path": "/etc/hosts", **SSH_CRED})
    assert r.status_code == 200, r.text
    assert (seen[0].host, seen[0].connect_ip) == (ALIAS, OPEN_HOST)


def test_tcpdump_and_interfaces_pin(world, fake_dns, client_as, monkeypatch):
    import app.routers.topology_trace as mod
    from app.services.tcpdump_runner import CaptureResult
    seen = []

    def _capture(target, **k):
        seen.append(target)
        return CaptureResult(host=target.host, status="ok", executed="tcpdump", exit_code=0, duration_ms=1)

    def _ifaces(target, **k):
        seen.append(target)
        return ["eth0"]
    monkeypatch.setattr(mod, "tcpdump_capture", _capture)
    monkeypatch.setattr(mod, "list_remote_interfaces", _ifaces)
    c = client_as(world["op_outsider"])
    assert c.post("/api/v1/topology-trace/tcpdump",
                  json={"host": ALIAS, "interface": "eth0", **SSH_CRED}).status_code == 200
    assert c.post("/api/v1/topology-trace/tcpdump/interfaces",
                  json={"host": MULTI, **SSH_CRED}).status_code == 200
    assert [(t.host, t.connect_ip) for t in seen] == [(ALIAS, OPEN_HOST), (MULTI, OPEN_HOST_2)]


def test_node_ssh_test_pins(world, fake_dns, client_as, monkeypatch):
    import app.routers.node_ssh as mod
    seen = []

    def _test(tgt, **k):
        seen.append(tgt)
        return SSHResult(host=tgt.host, status="ok", exit_code=0, stdout="", stderr="", duration_ms=1, error=None)
    monkeypatch.setattr(mod, "test_connection", _test)
    r = client_as(world["op_outsider"]).post("/api/v1/node-ssh/test", json={"host": ALIAS, **SSH_CRED})
    assert r.status_code == 200 and r.json()["host"] == ALIAS
    assert seen[0].connect_ip == OPEN_HOST


def test_ip_literal_targets_are_not_pinned_or_resolved(world, fake_dns, client_as, monkeypatch):
    import app.routers.etcdctl as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    c = client_as(world["op_outsider"])
    for host in (OPEN_HOST, f"::ffff:{OPEN_HOST}", OUTSIDE_HOST):
        r = c.post(f"/api/v1/clusters/{world['open'].id}/etcdctl/run",
                   json={"host": host, "args": "endpoint health", **SSH_CRED})
        assert r.status_code == 200, (host, r.text)
    assert [(t.host, t.connect_ip) for (t,) in fake.calls] == [
        (OPEN_HOST, None), (f"::ffff:{OPEN_HOST}", None), (OUTSIDE_HOST, None)]
    assert fake_dns == []


# ── 해석 실패 = 거부(격리 사용 중) ───────────────────────────────────────────

@pytest.fixture
def ssh_must_not_run(monkeypatch):
    import app.routers.bulk_exec as bulk
    import app.routers.etcdctl as etcd
    import app.routers.mc_client as mc
    import app.routers.node_ssh as nssh
    import app.routers.topology_trace as tt

    def _fail(*a, **k):
        pytest.fail("SSH must not be attempted")

    async def _afail(*a, **k):
        pytest.fail("SSH must not be attempted")

    for mod in (etcd, mc, bulk):
        monkeypatch.setattr(mod, "run_bulk", _afail)
    monkeypatch.setattr(bulk, "fetch_remote_file", _fail)
    monkeypatch.setattr(tt, "tcpdump_capture", _fail)
    monkeypatch.setattr(tt, "list_remote_interfaces", _fail)
    monkeypatch.setattr(nssh, "test_connection", _fail)


def _unresolved_requests(world, host):
    cid = world["open"].id
    return [
        (f"/api/v1/clusters/{cid}/etcdctl/run", {"host": host, "args": "endpoint health", **SSH_CRED}),
        (f"/api/v1/clusters/{cid}/etcdctl/logs", {"host": host, **SSH_CRED}),
        (f"/api/v1/clusters/{cid}/mc/run", {"host": host, "args": "ls x", **SSH_CRED}),
        ("/api/v1/bulk-exec/run", {"action": "ssh", "command": "uptime",
                                   "targets": [{"host": OUTSIDE_HOST}, {"host": host}], **SSH_CRED}),
        ("/api/v1/bulk-exec/fetch-file", {"host": host, "remote_path": "/etc/hosts", **SSH_CRED}),
        ("/api/v1/topology-trace/tcpdump", {"host": host, "interface": "eth0", **SSH_CRED}),
        ("/api/v1/topology-trace/tcpdump/interfaces", {"host": host, **SSH_CRED}),
        ("/api/v1/node-ssh/test", {"host": host, **SSH_CRED}),
    ]


def test_unresolved_unknown_name_with_bindings_is_403(world, fake_dns, client_as, ssh_must_not_run):
    c = client_as(world["op_member"])  # 바인딩 테넌트 멤버여도 — 권한 문제가 아니라 host 를 확인할 수 없어서
    for path, body in _unresolved_requests(world, MISSING):
        r = c.post(path, json=body)
        assert r.status_code == 403, (path, r.status_code, r.text)
        detail = r.json()["detail"]
        assert UNRESOLVED_MARK in detail and "테넌트 격리" in detail and MISSING in detail, (path, detail)


def test_dns_timeout_is_treated_as_unresolved(world, db, monkeypatch):
    import time

    def _slow(host):
        time.sleep(0.5)
        return [OPEN_HOST]
    monkeypatch.setattr(ca, "_getaddrinfo_ips", _slow)
    monkeypatch.setattr(ca, "_RESOLVE_TIMEOUT_SEC", 0.1)
    with pytest.raises(ca.HostUnresolvedError) as exc:
        ca.require_hosts_scope(db, world["op_member"], ["slow.pin.test"])
    assert exc.value.status_code == 403


def test_unresolved_name_without_bindings_is_allowed(world, fake_dns, client_as, monkeypatch, no_isolation):
    import app.routers.etcdctl as mod
    fake = _fake_run_bulk()
    monkeypatch.setattr(mod, "run_bulk", fake)
    r = client_as(world["op_outsider"]).post(
        f"/api/v1/clusters/{world['open'].id}/etcdctl/run",
        json={"host": MISSING, "args": "endpoint health", **SSH_CRED})
    assert r.status_code == 200, r.text
    (t,), = fake.calls
    assert (t.host, t.connect_ip) == (MISSING, None)  # 예전 동작 — 고정 없이 원문으로 접속


# ── WebSocket 콘솔(node-ssh, k9s) ────────────────────────────────────────────

def _token(user):
    from app.auth.security import create_access_token
    return create_access_token(user.username, role=user.role)


def _ws_run(path: str, init: dict) -> tuple[int, list[str]]:
    from fastapi.testclient import TestClient

    from app.main import app
    texts: list[str] = []
    with TestClient(app).websocket_connect(path) as ws:
        ws.send_text(json.dumps({"type": "init", **init}))
        with pytest.raises(WebSocketDisconnect) as exc:
            for _ in range(20):
                texts.append(ws.receive_text())
    return exc.value.code, texts


@pytest.fixture
def captured_pty_connect(monkeypatch):
    """bridge_pty 의 SSH 연결 대역 — 대상만 기록하고 연결 실패로 끝낸다(세션은 열지 않는다)."""
    import app.services.ssh_pty as pty
    seen: list[SSHTarget] = []

    def _connect(target, timeout):
        seen.append(target)
        raise OSError("mock: no ssh in tests")

    monkeypatch.setattr(pty, "connect_client", _connect)
    return seen


def test_node_ssh_ws_connects_to_pinned_ip(world, fake_dns, captured_pty_connect):
    tok = _token(world["op_outsider"])
    _code, _ = _ws_run(f"/api/v1/node-ssh/session?token={tok}", {"host": ALIAS, "password": "pw"})
    assert len(captured_pty_connect) == 1
    t = captured_pty_connect[0]
    assert (t.host, t.connect_ip) == (ALIAS, OPEN_HOST)


def test_k9s_ws_connects_to_pinned_ip(world, fake_dns, captured_pty_connect):
    tok = _token(world["op_outsider"])
    _code, texts = _ws_run(f"/api/v1/k8s/{world['open'].id}/k9s?token={tok}", {"host": MULTI, "password": "pw"})
    assert len(captured_pty_connect) == 1
    t = captured_pty_connect[0]
    assert (t.host, t.connect_ip) == (MULTI, OPEN_HOST_2)
    assert any(MULTI in x for x in texts)  # 화면 label 은 원래 이름


def test_ws_unresolved_name_with_bindings_is_4413(world, fake_dns, captured_pty_connect, db):
    tok = _token(world["op_member"])
    code, texts = _ws_run(f"/api/v1/node-ssh/session?token={tok}", {"host": MISSING, "password": "pw"})
    assert code == 4413 and any(UNRESOLVED_MARK in x for x in texts)
    code, _ = _ws_run(f"/api/v1/k8s/{world['open'].id}/k9s?token={tok}", {"host": MISSING, "password": "pw"})
    assert code == 4413
    assert captured_pty_connect == []  # SSH 는 시도조차 하지 않는다
    for action in ("node.ssh.open", "k9s.ssh.open"):
        rows = _audits(db, world["op_member"], action)
        assert len(rows) == 1 and rows[0].status == "failure"
        assert rows[0].details["reason"] == "host_unresolved"


def test_ws_unresolved_name_without_bindings_is_attempted(world, fake_dns, captured_pty_connect, no_isolation):
    tok = _token(world["op_outsider"])
    _ws_run(f"/api/v1/node-ssh/session?token={tok}", {"host": MISSING, "password": "pw"})
    assert [(t.host, t.connect_ip) for t in captured_pty_connect] == [(MISSING, None)]
