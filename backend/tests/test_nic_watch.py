"""NIC 상태 감시 — 에이전트 수집(가짜 sysfs)·/proc/net/bonding 해석·판정 규칙·보고 저장(실제 DB) 테스트."""
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.node_param_agent import nic as N  # noqa: E402
from app.services.nic_watch import analyze as A  # noqa: E402
from app.services.nic_watch.settings import DEFAULTS, agent_config, normalize  # noqa: E402

PROC_BOND_OK = """Ethernet Channel Bonding Driver: v5.14.0

Bonding Mode: IEEE 802.3ad Dynamic link aggregation
Transmit Hash Policy: layer3+4 (1)
MII Status: up
MII Polling Interval (ms): 100

802.3ad info
LACP active: on
LACP rate: fast
Aggregator selection policy (ad_select): stable
System MAC address: 0c:42:a1:00:00:01
Active Aggregator Info:
\tAggregator ID: 1
\tNumber of ports: 2
\tActor Key: 21
\tPartner Key: 32801
\tPartner Mac Address: 00:1c:73:aa:bb:cc

Slave Interface: ens1f0
MII Status: up
Speed: 25000 Mbps
Duplex: full
Link Failure Count: 0
Permanent HW addr: 0c:42:a1:00:00:01
Slave queue ID: 0
Aggregator ID: 1
details actor lacp pdu:
    system priority: 65535
    system mac address: 0c:42:a1:00:00:01
    oper key: 21
details partner lacp pdu:
    system priority: 32768
    system mac address: 00:1c:73:aa:bb:cc
    oper key: 32801

Slave Interface: ens1f1
MII Status: up
Speed: 25000 Mbps
Duplex: full
Link Failure Count: 2
Aggregator ID: 2
details partner lacp pdu:
    system mac address: 00:00:00:00:00:00
    oper key: 1
"""


def test_parse_proc_bonding():
    r = N.parse_proc_bonding(PROC_BOND_OK)
    assert r["active"] == {"aggregator_id": 1, "ports": 2, "actor_key": 21, "partner_key": 32801,
                           "partner_mac": "00:1c:73:aa:bb:cc"}
    s0, s1 = r["slave_state"]["ens1f0"], r["slave_state"]["ens1f1"]
    assert s0 == {"mii_status": "up", "speed": 25000, "duplex": "full", "link_failures": 0, "aggregator_id": 1,
                  "partner_mac": "00:1c:73:aa:bb:cc", "partner_key": 32801}
    assert s1["aggregator_id"] == 2 and s1["link_failures"] == 2 and s1["partner_mac"] == "00:00:00:00:00:00"


def _mk(base: Path, name: str, files: dict, *, device=False, devtype=None, bonding=None, master=None, lowers=()):
    d = base / name
    (d / "statistics").mkdir(parents=True)
    for k, v in files.items():
        (d / k).write_text(f"{v}\n")
    for c in ("rx_packets", "rx_missed_errors", "rx_crc_errors"):
        (d / "statistics" / c).write_text("0\n")
    (d / "uevent").write_text(f"INTERFACE={name}\n" + (f"DEVTYPE={devtype}\n" if devtype else ""))
    if device:
        (d / "device").mkdir()
    if bonding:
        (d / "bonding").mkdir()
        for k, v in bonding.items():
            (d / "bonding" / k).write_text(f"{v}\n")
    if master:
        os.symlink(f"../{master}", d / "master")
    for low in lowers:
        os.symlink(f"../{low}", d / f"lower_{low}")


def test_collect_fake_sysfs(tmp_path):
    net, bonding = tmp_path / "net", tmp_path / "bonding"
    net.mkdir()
    bonding.mkdir()
    link = {"operstate": "up", "carrier": 1, "mtu": 9000, "speed": 25000, "duplex": "full", "carrier_changes": 3}
    _mk(net, "ens1f0", link, device=True, master="bond0")
    _mk(net, "ens1f1", link, device=True, master="bond0")
    _mk(net, "bond0", {**link, "speed": 50000}, bonding={
        "mode": "802.3ad 4", "xmit_hash_policy": "layer3+4 1", "lacp_rate": "fast 1", "miimon": 100,
        "arp_interval": 0, "updelay": 0, "downdelay": 0, "slaves": "ens1f0 ens1f1"}, lowers=("ens1f0", "ens1f1"))
    _mk(net, "bond0.100", {**link, "mtu": 1500}, devtype="vlan", lowers=("bond0",))
    _mk(net, "lxc1234", {"operstate": "up", "mtu": 1500})
    _mk(net, "lo", {"operstate": "unknown", "mtu": 65536})
    _mk(net, "eno1", {"operstate": "down", "carrier": "", "mtu": 1500, "speed": -1}, device=True)
    (bonding / "bond0").write_text(PROC_BOND_OK)

    r = N.collect(N.DEFAULT_CONFIG, sys_net=net, proc_bonding=bonding, use_ethtool=False)
    by = {i["name"]: i for i in r["interfaces"]}
    assert set(by) == {"ens1f0", "ens1f1", "bond0", "bond0.100", "eno1"}  # lxc*·lo 는 제외
    assert by["bond0"]["kind"] == "bond" and by["bond0.100"]["kind"] == "vlan" and by["ens1f0"]["kind"] == "physical"
    assert by["bond0"]["bond"]["mode"] == "802.3ad" and by["bond0"]["bond"]["slaves"] == ["ens1f0", "ens1f1"]
    assert by["bond0"]["bond"]["active"]["aggregator_id"] == 1
    assert by["ens1f0"]["master"] == "bond0" and by["bond0.100"]["vlan_id"] == 100 and by["bond0.100"]["lowers"] == ["bond0"]
    assert by["ens1f1"]["lacp"]["aggregator_id"] == 2 and by["ens1f1"]["counters"]["bond_link_failures"] == 2
    assert by["ens1f0"]["counters"]["carrier_changes"] == 3
    assert by["eno1"]["speed"] is None and by["eno1"]["carrier"] is None
    assert r["errors"] == []


def test_collect_real_host_does_not_raise():
    """실제 커널(이 테스트 환경)에서도 예외 없이 돈다 — ethtool ioctl 이 안 되는 환경이면 항목만 비운다."""
    r = N.collect({"include_kinds": list(N.DEFAULT_CONFIG["include_kinds"]) + ["virtual"], "exclude_names": []})
    assert isinstance(r["interfaces"], list)


def test_settings_normalize_and_agent_config():
    cfg = normalize({"include_kinds": ["physical", "bogus"], "exclude_names": "lo, lxc* ,bad name;", "min_speed_mbps": -5,
                     "expected_bond_mode": "nope", "offload_expect": {"rx-lro": 0, "BAD KEY": 1}})
    assert cfg["include_kinds"] == ["physical"] and cfg["exclude_names"] == ["lo", "lxc*"]
    assert cfg["min_speed_mbps"] == 0 and cfg["expected_bond_mode"] == "802.3ad" and cfg["offload_expect"] == {"rx-lro": False}
    assert set(agent_config(cfg)) == {"enabled", "include_kinds", "include_names", "exclude_names"}
    assert normalize("garbage") == normalize(None)
    assert normalize({"offload_expect": [{"name": "rx-gro", "on": True}]})["offload_expect"] == {"rx-gro": True}


# ── 판정 ─────────────────────────────────────────────────────────────────────

NOW = datetime(2026, 11, 23, 12, 0, 0)


def _phys(name, *, mtu=9000, speed=25000, master="bond0", oper="up", counters=None, ring=None, feats=None, driver="mlx5_core"):
    return {"name": name, "kind": "physical", "operstate": oper, "carrier": 1, "mtu": mtu, "speed": speed, "duplex": "full",
            "master": master, "lowers": [], "ring": ring, "driver": {"driver": driver, "firmware": "22.1"},
            "features": feats or {"rx-lro": {"on": False, "fixed": False}, "rx-gro": {"on": True, "fixed": False}},
            "counters": counters or {}}


def _bond(*, mode="802.3ad", hp="layer3+4", rate="fast", agg=(1, 1), pmac=("00:1c:73:aa:bb:cc",) * 2, miimon=100, mtu=9000):
    return {"name": "bond0", "kind": "bond", "operstate": "up", "mtu": mtu, "speed": 50000, "lowers": ["ens1f0", "ens1f1"],
            "counters": {}, "bond": {
                "mode": mode, "xmit_hash_policy": hp, "lacp_rate": rate, "miimon": miimon, "arp_interval": 0,
                "slaves": ["ens1f0", "ens1f1"],
                "active": {"aggregator_id": 1, "ports": 2, "partner_mac": pmac[0]},
                "slave_state": {"ens1f0": {"mii_status": "up", "speed": 25000, "aggregator_id": agg[0], "partner_mac": pmac[0]},
                                "ens1f1": {"mii_status": "up", "speed": 25000, "aggregator_id": agg[1], "partner_mac": pmac[1]}}}}


def _state(node, ifaces, history=None, received=NOW):
    return {"node": node, "host_ip": None, "agent_version": "1.2.0", "collected_at": NOW, "received_at": received,
            "interfaces": ifaces, "errors": [], "history": history or []}


def _codes(out, node=None):
    return sorted({f["code"] for f in out["findings"] if node is None or f["node"] == node})


def test_healthy_node_has_no_findings():
    out = A.analyze([_state("w1", [_bond(), _phys("ens1f0"), _phys("ens1f1")])], normalize(None), NOW)
    assert out["findings"] == [] and out["summary"]["level"] == "ok"
    assert all(r["level"] == "ok" for r in out["interfaces"])


def test_bond_lacp_findings():
    bad = _bond(mode="802.3ad", hp="layer2", rate="slow", agg=(1, 2), miimon=0)
    out = A.analyze([_state("w1", [bad, _phys("ens1f0"), _phys("ens1f1")])], normalize(None), NOW)
    codes = _codes(out)
    assert {"bond_hash", "lacp_rate", "lacp_aggregator", "bond_no_monitor"} <= set(codes)
    agg = next(f for f in out["findings"] if f["code"] == "lacp_aggregator")
    assert agg["level"] == "critical" and "ens1f1" in agg["detail"]
    rows = {r["name"]: r for r in out["interfaces"]}
    assert rows["ens1f1"]["level"] == "critical" and rows["ens1f0"]["level"] == "ok"  # 집계 밖 하위 행에도 표시
    assert out["summary"]["level"] == "critical" and out["findings"][0]["level"] == "critical"  # 심각한 것부터

    nopartner = _bond(pmac=("00:00:00:00:00:00",) * 2)
    assert "lacp_no_partner" in _codes(A.analyze([_state("w1", [nopartner])], normalize(None), NOW))
    # 기대 값을 비우면 그 검사는 하지 않는다
    loose = normalize({"expected_hash_policy": "", "expected_lacp_rate": ""})
    assert not {"bond_hash", "lacp_rate"} & set(_codes(A.analyze([_state("w1", [bad])], loose, NOW)))


def test_bond_slave_down_and_mtu_hierarchy():
    b = _bond()
    b["bond"]["slave_state"]["ens1f1"]["mii_status"] = "down"
    vlan = {"name": "bond0.100", "kind": "vlan", "operstate": "up", "mtu": 9100, "lowers": ["bond0"], "counters": {}}
    out = A.analyze([_state("w1", [b, vlan, _phys("ens1f0"), _phys("ens1f1", mtu=1500)])], normalize(None), NOW)
    codes = _codes(out)
    assert {"bond_slave_down", "mtu_exceeds_parent", "bond_slave_mtu"} <= set(codes)


def test_rates_drops_crc_flaps_with_ring_hint():
    t0 = NOW - timedelta(minutes=20)
    hist = [{"t": t0.isoformat(), "c": {"ens1f0": {"rx_missed_errors": 100, "drv:rx_out_of_buffer": 1000,
                                                    "rx_crc_errors": 5, "carrier_changes": 4, "drv:rx_xdp_drops": 0}}}]
    cur = {"rx_missed_errors": 150, "drv:rx_out_of_buffer": 3000, "rx_crc_errors": 9, "carrier_changes": 6,
           "drv:rx_xdp_drops": 999999}
    out = A.analyze([_state("w1", [_phys("ens1f0", master=None, counters=cur, ring={"rx": 1024, "rx_max": 8192, "tx": 1024, "tx_max": 8192})],
                            history=hist)], normalize(None), NOW)
    row = out["interfaces"][0]
    assert row["rates"]["drops"] == 2000 and row["rates"]["drop_counter"] == "drv:rx_out_of_buffer"  # 큐 합산 X, xdp 제외
    assert row["rates"]["drops_per_min"] == 100.0 and row["rates"]["crc"] == 4 and row["rates"]["flaps"] == 2
    drops = next(f for f in out["findings"] if f["code"] == "rx_drops")
    assert "ethtool -G ens1f0 rx 8192" in drops["hint"]
    assert {"rx_drops", "crc_errors", "link_flap"} <= set(_codes(out))


def test_rates_counter_reset_and_young_history():
    hist = [{"t": (NOW - timedelta(minutes=30)).isoformat(), "c": {"ens1f0": {"rx_missed_errors": 10_000}}}]
    out = A.analyze([_state("w1", [_phys("ens1f0", counters={"rx_missed_errors": 3})], history=hist)], normalize(None), NOW)
    assert out["interfaces"][0]["rates"]["drops"] == 0  # 카운터가 줄었다 = 재설정
    young = [{"t": (NOW - timedelta(seconds=30)).isoformat(), "c": {"ens1f0": {"rx_missed_errors": 0}}}]
    out = A.analyze([_state("w1", [_phys("ens1f0", counters={"rx_missed_errors": 9})], history=young)], normalize(None), NOW)
    assert out["interfaces"][0]["rates"] is None and out["nodes"][0]["rate_ready"] is False


def test_offload_expect_and_cross_node():
    lro_on = {"rx-lro": {"on": True, "fixed": False}, "rx-gro": {"on": True, "fixed": False}}
    states = [
        _state("w1", [_phys("ens1f0", master=None)]),
        _state("w2", [_phys("ens1f0", master=None)]),
        _state("w3", [_phys("ens1f0", master=None, mtu=1500, speed=10000, feats=lro_on)]),
    ]
    out = A.analyze(states, normalize(None), NOW)
    w3 = _codes(out, "w3")
    assert {"offload_expect", "cross_mtu", "cross_speed", "cross_offload"} <= set(w3)
    assert _codes(out, "w1") == [] and _codes(out, "w2") == []
    mtu = next(f for f in out["findings"] if f["code"] == "cross_mtu")
    assert "9000" in mtu["detail"]
    assert "cross_mtu" not in _codes(A.analyze(states, normalize({"cross_node_check": False}), NOW))


def test_stale_and_unused_port():
    out = A.analyze([_state("w1", [_phys("eno2", master=None, oper="down")], received=NOW - timedelta(minutes=30))],
                    normalize(None), NOW)
    f = {x["code"]: x for x in out["findings"]}
    assert f["stale"]["level"] == "warning" and out["nodes"][0]["stale"] is True
    assert f["link_down_unused"]["level"] == "info"
    assert out["summary"]["level"] == "warning"  # info 는 화면 수준을 올리지 않는다


# ── 보고 저장(실제 DB) ───────────────────────────────────────────────────────

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
    from app.models.cluster import Cluster
    from app.models.node_nic import NodeNicState
    from app.models.node_param_watch import NodeParamAgent

    c = Cluster(name=f"nic-{uuid.uuid4().hex[:8]}", api_endpoint="https://nic:6443")
    db.add(c)
    db.commit()
    yield c
    db.rollback()
    db.query(NodeNicState).filter(NodeNicState.cluster_id == c.id).delete(synchronize_session=False)
    db.query(NodeParamAgent).filter(NodeParamAgent.cluster_id == c.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


def test_ingest_history_and_view(db, cluster):
    from app.models.node_param_watch import NodeParamAgent
    from app.services.nic_watch import service as svc

    t0 = datetime(2026, 11, 23, 11, 0, 0)

    def report(minutes, missed):
        rep = {"interfaces": [{**_phys("ens1f0", master=None), "counters": {"rx_missed_errors": missed}},
                              {"name": "x" * 99, "kind": "physical", "counters": {"a": "bad", "b": -1}}, "garbage"],
               "errors": ["ens9: oops"]}
        t = t0 + timedelta(minutes=minutes)
        return svc.ingest(db, cluster, "w1", "10.0.0.1", "1.2.0", t.isoformat(), rep, now=t)

    assert report(0, 0) == 2
    for m in (1, 2, 3, 4):           # 5분이 안 됐으니 표본을 더하지 않는다
        report(m, 0)
    report(5, 0)
    report(20, 5000)
    from app.models.node_nic import NodeNicState

    row = db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).one()
    assert [h["t"][11:16] for h in row.history] == ["11:00", "11:05", "11:20"]
    assert row.interfaces[1]["name"] == "x" * 32 and row.interfaces[1]["counters"] == {}  # 정리됨
    db.add(NodeParamAgent(cluster_id=cluster.id, node="w-old", agent_version="1.1.0"))
    db.commit()
    view = svc.cluster_view(db, cluster, now=t0 + timedelta(minutes=20))
    assert view["interfaces"][0]["rates"]["drops"] == 5000  # 11:05 기준 15분
    assert "rx_drops" in {f["code"] for f in view["findings"]}
    assert view["pending_agents"][0]["node"] == "w-old" and "1.2.0" in view["pending_agents"][0]["reason"]
    assert svc.ingest(db, cluster, "w1", None, "1.2.0", None, "not-a-dict") == 0
    svc.remove_node(db, cluster.id, "w1")
    assert db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).count() == 0


def test_report_endpoint_carries_nic(db, cluster, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app
    from app.models.node_nic import NodeNicState

    monkeypatch.setattr(settings, "node_param_ingest_token", "s3cret")
    client = TestClient(app)
    hdr = {"Authorization": "Bearer s3cret"}
    body = {"cluster": str(cluster.id), "node": "w1", "agent_version": "1.2.0", "runtime": {}, "persistent": {}}
    r = client.post("/api/v1/node-params/agent/report", json=body, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["nic"] == agent_config(normalize(None)) == agent_config(DEFAULTS)
    r = client.post("/api/v1/node-params/agent/report", json={**body, "nic": {"interfaces": [_phys("ens1f0")]}}, headers=hdr)
    assert r.status_code == 200 and r.json()["nic_interfaces"] == 1
    assert db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).count() == 1

    from app.auth.deps import get_current_user, require_admin

    admin = type("U", (), {"id": uuid.uuid4(), "username": "t", "role": "admin", "is_active": True})()
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[require_admin] = lambda: admin
    try:
        v = client.get(f"/api/v1/nic-watch/clusters/{cluster.id}")
        assert v.status_code == 200, v.text
        row = v.json()["interfaces"][0]
        assert row["name"] == "ens1f0" and isinstance(row["offload"], list) and "counters" not in row  # 목록은 가벼운 행
        assert v.json()["interfaces_total"] == 1 and v.json()["settings"]["offload_expect"] == [{"name": "rx-lro", "on": False}]
        d = client.get(f"/api/v1/nic-watch/clusters/{cluster.id}/nodes/w1/interfaces/ens1f0")
        assert d.status_code == 200 and isinstance(d.json()["counters"], list) and isinstance(d.json()["findings"], list)
        assert client.get(f"/api/v1/nic-watch/clusters/{cluster.id}/nodes/w1/interfaces/nope").status_code == 404
        assert client.get(f"/api/v1/nic-watch/clusters/{cluster.id}?limit=0").json()["interfaces"] == []
        s = client.get("/api/v1/nic-watch/settings").json()
        assert "802.3ad" in s["options"]["bond_modes"]
    finally:
        app.dependency_overrides.clear()


def test_ingest_skips_full_write_when_state_unchanged(db, cluster):
    from app.models.node_nic import NodeNicState
    from app.services.nic_watch import service as svc

    t0 = datetime(2026, 11, 23, 11, 0, 0)

    def rep(minutes, *, missed=0, mtu=9000):
        t = t0 + timedelta(minutes=minutes)
        body = {"interfaces": [{**_phys("ens1f0", master=None, mtu=mtu), "counters": {"rx_missed_errors": missed}}]}
        svc.ingest(db, cluster, "w1", None, "1.2.0", t.isoformat(), body, now=t)
        db.expire_all()
        return db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).one()

    row = rep(0)
    row = rep(1, missed=7)                       # 카운터만 바뀜 → 받은 시각만
    assert row.received_at == t0 + timedelta(minutes=1) and row.collected_at == t0
    assert row.interfaces[0]["counters"]["rx_missed_errors"] == 0
    row = rep(2, missed=7, mtu=1500)             # 상태가 바뀜 → 바로 전체 저장
    assert row.collected_at == t0 + timedelta(minutes=2) and row.interfaces[0]["mtu"] == 1500
    row = rep(7, missed=9, mtu=1500)             # 5분 지남 → 전체 저장
    assert row.interfaces[0]["counters"]["rx_missed_errors"] == 9


def test_view_filter_page_and_cache(db, cluster):
    from app.services.nic_watch import service as svc

    t = datetime(2026, 11, 23, 11, 0, 0)
    for i in range(5):
        lro = {"rx-lro": {"on": i == 3, "fixed": False}}
        body = {"interfaces": [_phys("ens1f0", master=None, feats=lro), _phys("eno1", master=None, oper="down")]}
        svc.ingest(db, cluster, f"w{i}", None, "1.2.0", t.isoformat(), body, now=t)
    v = svc.cluster_view(db, cluster, now=t, limit=3)
    assert v["interfaces_total"] == 10 and len(v["interfaces"]) == 3 and v["offset"] == 0
    assert [r["name"] for r in svc.cluster_view(db, cluster, now=t, q="w3")["interfaces"]] == ["ens1f0", "eno1"]
    assert svc.cluster_view(db, cluster, now=t, q="eno*")["interfaces_total"] == 5
    flagged = svc.cluster_view(db, cluster, now=t, only_flagged=True)
    assert [(r["node"], r["name"]) for r in flagged["interfaces"]] == [("w3", "ens1f0")] and flagged["interfaces"][0]["finding_count"] >= 1
    assert svc.cluster_view(db, cluster, now=t, kind="bond")["interfaces_total"] == 0
    detail = svc.interface_detail(db, cluster, "w3", "ens1f0", now=t)
    assert {f["code"] for f in detail["findings"]} >= {"offload_expect"}

    svc.invalidate()
    first = svc.cluster_view(db, cluster)        # now 없음 → 캐시
    body = {"interfaces": [_phys("bond9", master=None)]}
    svc.ingest(db, cluster, "w9", None, "1.2.0", None, body)
    assert svc.cluster_view(db, cluster)["interfaces_total"] == first["interfaces_total"]  # 캐시 안
    svc.invalidate(cluster.id)
    assert svc.cluster_view(db, cluster)["interfaces_total"] == first["interfaces_total"] + 1


# ── 2-a: 서비스 구성 nic — max 비교·평탄화·SSH 수집·스냅샷 ─────────────────────

def test_same_value_max_and_iface_parts():
    from app.services.service_config import current as C
    from app.services.service_config.status import drift_rows

    assert C.same_value("max", "8192/8192") and C.same_value("1024", "1024/8192")
    assert not C.same_value("max", "1024/8192") and not C.same_value("2048", "1024/8192")
    assert C.same_value("max", "ens1f0=8192/8192 ens1f1=4096/4096")
    assert not C.same_value("on", "ens1f0=on ens1f1=off")
    assert C.to_version_value("1024/8192") == "1024" and C.to_version_value("a=off b=on c=on") == "on"
    # 노드마다 최대값이 달라도 모두 max 면 같은 것으로
    s = C.summarize({"w1": "8192/8192", "w2": "4096/4096"})
    assert C.item_status("max", s) == "same" and C.item_status("4096", s) == "mixed"
    assert C.item_status("max", C.summarize({"w1": "1024/8192"})) == "differs"
    rows = drift_rows({"ring.rx": {"w1": "8192/8192", "w2": "1024/8192"}},
                      [{"group_id": None, "group_name": "기본", "baseline_version_no": 1, "nodes": ["w1", "w2"],
                        "expected": {"ring.rx": "max"}}])
    assert [r["node"] for r in rows] == ["w2"]


def test_flatten_targets_mixed_and_carry_over():
    from app.services.nic_watch import snapshot as SN

    b = _bond(hp="layer2", rate="slow")
    p0 = {**_phys("ens1f0", ring={"rx": 1024, "rx_max": 8192, "tx": 1024, "tx_max": 8192}),
          "channels": {"combined": 8, "combined_max": 63}}
    p1 = {**_phys("ens1f1", ring={"rx": 4096, "rx_max": 8192, "tx": 1024, "tx_max": 8192}),
          "channels": {"combined": 8, "combined_max": 63}}
    mgmt = _phys("eno1", master=None, ring={"rx": 256, "rx_max": 512, "tx": 256, "tx_max": 512})
    out = SN.flatten([b, p0, p1, mgmt])
    f = out["flat"]
    assert out["targets"] == ["bond0", "ens1f0", "ens1f1"]  # 관리용 eno1 은 본딩 밖이라 빠진다
    assert f["ring.rx"] == "ens1f0=1024/8192 ens1f1=4096/8192" and f["ring.tx"] == "1024/8192"
    assert f["channels.combined"] == "8/63" and f["offload.rx-lro"] == "off"
    assert f["bond.xmit_hash_policy"] == "layer2" and f["bond.lacp_rate"] == "slow" and f["bond.miimon"] == "100"
    # 채널을 보고하지 않는 출처(에이전트 1.2.x) — 이전 값을 유지
    old_agent = SN.flatten([b, _phys("ens1f0"), _phys("ens1f1")])
    assert "channels.combined" not in old_agent["measured"]
    assert SN.carry_over(f, old_agent["flat"], old_agent["measured"])["channels.combined"] == "8/63"
    # 본딩이 없으면 링크가 올라온 물리 인터페이스
    assert SN.flatten([mgmt, _phys("eno2", master=None, oper="down")])["targets"] == ["eno1"]
    assert SN.flatten([b, p0, mgmt], mode="glob", globs=["eno*"])["targets"] == ["eno1"]


SSH_OUT = """@@IF bond0
operstate=up
carrier=1
speed=50000
duplex=full
mtu=9000
carrier_changes=1
bonding=1
lower=ens1f0
lower=ens1f1
stat.rx_packets=100
bond.mode=802.3ad 4
bond.xmit_hash_policy=layer3+4 1
bond.lacp_rate=fast 1
bond.miimon=100
bond.arp_interval=0
bond.updelay=0
bond.downdelay=0
bond.slaves=ens1f0 ens1f1
@@PROC
""" + PROC_BOND_OK + """@@END
@@IF ens1f0
operstate=up
carrier=1
speed=25000
duplex=full
mtu=9000
carrier_changes=4
device=1
master=bond0
stat.rx_missed_errors=7
stat.rx_crc_errors=0
@@ETH g
Ring parameters for ens1f0:
Pre-set maximums:
RX:\t\t\t8192
RX Mini:\t\tn/a
TX:\t\t\t8192
Current hardware settings:
RX:\t\t\t1024
RX Mini:\t\tn/a
TX:\t\t\t1024
@@END
@@ETH l
Channel parameters for ens1f0:
Pre-set maximums:
RX:\t\tn/a
TX:\t\tn/a
Other:\t\t1
Combined:\t63
Current hardware settings:
RX:\t\tn/a
TX:\t\tn/a
Other:\t\t1
Combined:\t16
@@END
@@ETH k
Features for ens1f0:
rx-checksumming: on
tx-checksumming: on
\ttx-checksum-ipv4: off [fixed]
\ttx-checksum-ip-generic: on
generic-receive-offload: on
large-receive-offload: off [fixed]
tx-udp_tnl-segmentation: on
tcp-segmentation-offload: on
@@END
@@ETH i
driver: mlx5_core
version: 5.14.0
firmware-version: 22.39.1002 (MT_0000000359)
bus-info: 0000:3b:00.0
@@END
@@ETH S
     rx_out_of_buffer: 1200
     rx_discards_phy: 3
@@END
@@IF lxc1234
operstate=up
mtu=1500
@@IF eno1
operstate=down
carrier=
speed=-1
duplex=unknown
mtu=1500
device=1
"""


def test_ssh_parse_output_matches_agent_shape():
    from app.services.nic_watch import ssh_collect as NS

    r = NS.parse_output(SSH_OUT, normalize(None))
    by = {i["name"]: i for i in r["interfaces"]}
    assert set(by) == {"bond0", "ens1f0", "eno1"}  # lxc 는 제외 이름
    e = by["ens1f0"]
    assert e["ring"] == {"rx": 1024, "rx_max": 8192, "tx": 1024, "tx_max": 8192}
    assert e["channels"]["combined"] == 16 and e["channels"]["combined_max"] == 63
    assert e["features"]["rx-lro"] == {"on": False, "fixed": True} and e["features"]["tx-checksum-ip-generic"]["on"] is True
    assert e["driver"]["driver"] == "mlx5_core" and e["driver"]["firmware"].startswith("22.39")
    assert e["counters"]["drv:rx_out_of_buffer"] == 1200 and e["counters"]["carrier_changes"] == 4
    assert e["lacp"]["aggregator_id"] == 1 and by["bond0"]["bond"]["mode"] == "802.3ad"
    assert by["bond0"]["bond"]["active"]["aggregator_id"] == 1 and by["eno1"]["speed"] is None
    script = NS.build_script(["lo", "lxc*", "bad name;rm"], ethtool="/usr/sbin/ethtool")
    assert 'case "$n" in lo|lxc*)' in script and "rm" not in script and "E=/usr/sbin/ethtool" in script


def test_snapshot_change_and_ssh_not_stale(db, cluster):
    from app.models import ClusterConfigSnapshot
    from app.models.service_config import ServiceConfigChange
    from app.services.nic_watch import service as svc

    t0 = datetime(2026, 11, 23, 11, 0, 0)
    ring = {"rx": 1024, "rx_max": 8192, "tx": 1024, "tx_max": 8192}
    try:
        svc.ingest(db, cluster, "w1", "10.0.0.1", None, t0.isoformat(),
                   {"interfaces": [_bond(), _phys("ens1f0", ring=ring), _phys("ens1f1", ring=ring)]}, now=t0, source="ssh")
        svc.ingest(db, cluster, "w1", "10.0.0.1", None, t0.isoformat(),
                   {"interfaces": [_bond(), _phys("ens1f0", ring=ring), _phys("ens1f1", ring=ring)]}, now=t0, source="ssh")
        snaps = db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id,
                                                       ClusterConfigSnapshot.component == "nic:w1").all()
        assert len(snaps) == 1 and snaps[0].data["flat"]["ring.rx"] == "1024/8192"
        big = {**ring, "rx": 8192}
        t1 = t0 + timedelta(minutes=10)
        svc.ingest(db, cluster, "w1", "10.0.0.1", None, t1.isoformat(),
                   {"interfaces": [_bond(), _phys("ens1f0", ring=big), _phys("ens1f1", ring=big)]}, now=t1, source="ssh")
        ch = db.query(ServiceConfigChange).filter(ServiceConfigChange.cluster_id == cluster.id).all()
        assert [(c.service, c.key, c.old_value, c.new_value, c.source) for c in ch] == [
            ("nic", "ring.rx", "1024/8192", "8192/8192", "ssh")]
        # 서비스 구성 화면 — 현재 값이 nic 서비스로 보인다
        from app.services.service_config import view as V

        v = V.build_view(db, cluster, "nic")
        rows = {r["key"]: r for s in v["sections"] for r in s["items"]}
        assert rows["ring.rx"]["current"]["value"] == "8192/8192" and v["sources"][0]["source"] == "NIC · SSH 수집"
        V.import_v1(db, cluster, "nic", "tester")
        vals = V.list_versions(db, cluster.id, "nic")[0].values
        assert vals["ring.rx"] == "8192" and vals["bond.lacp_rate"] == "fast"  # '현재/최대' → 현재
        # SSH 로 읽은 노드는 시간이 지나도 '보고 끊김' 이 아니다
        view = svc.cluster_view(db, cluster, now=t1 + timedelta(hours=5))
        assert "stale" not in {f["code"] for f in view["findings"]}
    finally:
        db.rollback()
        db.query(ServiceConfigChange).filter(ServiceConfigChange.cluster_id == cluster.id).delete(synchronize_session=False)
        from app.models.alert_event import AlertEvent
        from app.models.service_config import ServiceConfigVersion

        db.query(AlertEvent).filter(AlertEvent.cluster_id == cluster.id).delete(synchronize_session=False)
        db.query(ServiceConfigVersion).filter(ServiceConfigVersion.cluster_id == cluster.id).delete(synchronize_session=False)
        db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id).delete(synchronize_session=False)
        db.commit()


def test_version_values_drive_status_expectations(db, cluster):
    from app.models.service_config import ServiceConfigVersion
    from app.services.nic_watch import service as svc

    t = datetime(2026, 11, 23, 11, 0, 0)
    svc.ingest(db, cluster, "w1", None, "1.3.0", t.isoformat(), {"interfaces": [_bond(hp="layer2"), _phys("ens1f0")]}, now=t)
    assert "bond_hash" in {f["code"] for f in svc.cluster_view(db, cluster, now=t)["findings"]}
    db.add(ServiceConfigVersion(cluster_id=cluster.id, service="nic", group_id=None, version_no=1, status="saved",
                                values={"bond.xmit_hash_policy": "layer2", "offload.rx-lro": "on"}, created_by="t"))
    db.commit()
    try:
        eff = svc.effective_settings(db, cluster)
        assert eff["expected_hash_policy"] == "layer2" and eff["offload_expect"]["rx-lro"] is True
        codes = {f["code"] for f in svc.cluster_view(db, cluster, now=t)["findings"]}
        assert "bond_hash" not in codes and "offload_expect" in codes  # LRO off 인데 버전은 on
    finally:
        db.query(ServiceConfigVersion).filter(ServiceConfigVersion.cluster_id == cluster.id).delete(synchronize_session=False)
        db.commit()


def test_collect_nic_endpoint_with_fake_ssh(db, cluster, monkeypatch):
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user, require_operator
    from app.main import app
    from app.models import ClusterConfigSnapshot
    from app.models.node_nic import NodeNicState
    from app.routers import versions as VR

    calls = []

    def fake_exec(target, cmd, **kw):
        calls.append((target.host, cmd))
        if target.host == "10.0.0.9":
            return SimpleNamespace(status="auth_failed", stdout="", stderr="denied", exit_code=None, error="인증 실패")
        return SimpleNamespace(status="ok", stdout=SSH_OUT, stderr="", exit_code=0, error=None)

    monkeypatch.setattr(VR, "_exec_ssh", fake_exec)
    op = type("U", (), {"id": uuid.uuid4(), "username": "op", "role": "operator", "is_active": True})()
    app.dependency_overrides[get_current_user] = lambda: op
    app.dependency_overrides[require_operator] = lambda: op
    try:
        client = TestClient(app)
        body = {"hosts": ["10.0.0.1", "10.0.0.9"], "host_names": {"10.0.0.1": "worker-1"},
                "password": "x", "parallelism": 2}
        r = client.post(f"/api/v1/clusters/{cluster.id}/collect-nic", json=body)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["changed"] == 1 and len(out["errors"]) == 1 and "sh -c" in calls[0][1]
        row = db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).one()
        assert row.node == "worker-1" and row.source == "ssh"
        assert db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id,
                                                      ClusterConfigSnapshot.component == "nic:worker-1").count() == 1
        assert client.post(f"/api/v1/clusters/{cluster.id}/collect-nic", json={"hosts": ["h"]}).status_code == 422
    finally:
        app.dependency_overrides.clear()
        db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster.id).delete(synchronize_session=False)
        db.commit()
