"""NIC 적용(2-b) — 계획·명령·원복 스크립트·NM 본딩 옵션·재합류 판정(순수) + 가짜 노드(SSH)로 전체 흐름."""
import copy
import os
import shlex
from types import SimpleNamespace

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)

from app.services.nic_watch import snapshot as SN  # noqa: E402
from app.services.nic_watch.settings import normalize  # noqa: E402
from app.services.service_config import apply_nic as AC  # noqa: E402


def _bond(slaves=("ens1f0", "ens1f1"), agg=(1, 1), mii=("up", "up"), mode="802.3ad", hp="layer2", rate="slow", miimon=100):
    st = {s: {"mii_status": mii[i], "aggregator_id": agg[i]} for i, s in enumerate(slaves)}
    return {"name": "bond0", "kind": "bond", "operstate": "up",
            "bond": {"mode": mode, "xmit_hash_policy": hp, "lacp_rate": rate, "miimon": miimon, "slaves": list(slaves),
                     "active": {"aggregator_id": 1}, "slave_state": st}}


def _phys(name, rx=1024, rx_max=8192, comb=8, comb_max=63, lro=True, lro_fixed=False, gro=True):
    return {"name": name, "kind": "physical", "operstate": "up", "master": "bond0",
            "ring": {"rx": rx, "rx_max": rx_max, "tx": 1024, "tx_max": 8192},
            "channels": {"combined": comb, "combined_max": comb_max},
            "features": {"rx-lro": {"on": lro, "fixed": lro_fixed}, "rx-gro": {"on": gro, "fixed": False}}}


VALUES = {"ring.rx": "max", "channels.combined": "16", "offload.rx-lro": "off", "offload.rx-gro": "on",
          "bond.xmit_hash_policy": "layer3+4", "bond.lacp_rate": "fast", "bond.miimon": "100"}


def _plan(ifaces, values=VALUES):
    return AC.plan_node(ifaces, values, SN.select_targets(ifaces))


# ── 순수 ─────────────────────────────────────────────────────────────────────

def test_plan_resolves_max_skips_and_redundancy():
    p = _plan([_bond(), _phys("ens1f0"), _phys("ens1f1", rx=8192, lro=False)])
    assert p["errors"] == [] and p["redundant"]["bond0"] == (True, "")
    b = p["bonds"][0]["changes"]
    assert [(c["attr"], c["cur"], c["want"]) for c in b] == [("xmit_hash_policy", "layer2", "layer3+4"), ("lacp_rate", "slow", "fast")]
    m0, m1 = p["members"]
    assert m0["ring"] == {"rx": (1024, 8192)} and m0["channels"] == (8, 16) and m0["features"] == {"rx-lro": (True, False)}
    assert m1["ring"] == {} and m1["features"] == {}  # 이미 목표 값
    assert AC.has_runtime_changes(p)


def test_plan_errors_fixed_and_no_redundancy():
    over = _plan([_bond(), _phys("ens1f0", comb_max=8), _phys("ens1f1", comb_max=8)])
    assert any("channels.combined: 16 > 최대 8" in e for e in over["errors"])
    fixed = _plan([_bond(), _phys("ens1f0", lro_fixed=True), _phys("ens1f1", lro_fixed=True)])
    assert any("[fixed]" in s for s in fixed["members"][0]["skipped"]) and "rx-lro" not in fixed["members"][0]["features"]
    one_down = _plan([_bond(mii=("up", "down")), _phys("ens1f0"), _phys("ens1f1")])
    assert one_down["redundant"]["bond0"][0] is False
    m = one_down["members"][0]
    assert m["ring"] == {} and m["channels"] is None and any("이중화 없음" in s for s in m["skipped"])
    assert one_down["bonds"][0]["changes"]  # 본딩 sysfs(끊김 없음)는 그대로 한다
    single = _plan([_bond(slaves=("ens1f0",), agg=(1,), mii=("up",)), _phys("ens1f0")])
    assert single["redundant"]["bond0"] == (False, "하위 인터페이스 1개")
    lacp_out = AC.bond_redundant(_bond(agg=(1, 2))["bond"])
    assert lacp_out[0] is False and "ens1f1" in lacp_out[1]


def test_commands_rollback_and_bond_options():
    p = _plan([_bond(), _phys("ens1f0"), _phys("ens1f1")])
    m = p["members"][0]
    assert AC.member_commands("ethtool", m) == ["ethtool -G ens1f0 rx 8192", "ethtool -L ens1f0 combined 16",
                                                "ethtool -K ens1f0 lro off"]
    assert AC.member_commands("ethtool", m, rollback=True) == ["ethtool -G ens1f0 rx 1024", "ethtool -L ens1f0 combined 8",
                                                               "ethtool -K ens1f0 lro on"]
    script = AC.rollback_script("/usr/sbin/ethtool", p)
    assert "/usr/sbin/ethtool -G ens1f0 rx 1024 || true" in script
    assert "echo layer2 > /sys/class/net/bond0/bonding/xmit_hash_policy || true" in script
    assert script.index("ens1f0") < script.index("bonding/")  # 하위 먼저, 본딩 나중
    with pytest.raises(ValueError):
        AC.bond_command("bond0;rm -rf /", "miimon", "100")
    with pytest.raises(ValueError):
        AC.bond_command("bond0", "miimon", "100;reboot")
    assert AC.merge_bond_options("mode=802.3ad,miimon=100,lacp_rate=slow", {"lacp_rate": "fast", "xmit_hash_policy": "layer3+4"}) \
        == "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"
    cmds = AC.planned_commands({"nic_ethtool": "ethtool", "nic_rollback_timer_sec": 90}, VALUES)
    assert any("--on-active=90s" in c for c in cmds) and any("-L <하위> combined 16" in c for c in cmds)
    assert any("lro off" in c and "gro on" in c for c in cmds)


PROC = """Bonding Mode: IEEE 802.3ad Dynamic link aggregation
Active Aggregator Info:
\tAggregator ID: 1
Slave Interface: ens1f0
MII Status: {m0}
Aggregator ID: {a0}
Slave Interface: ens1f1
MII Status: up
Aggregator ID: 1
"""


def test_member_rejoined():
    assert AC.member_rejoined(PROC.format(m0="up", a0=1), "ens1f0", "802.3ad") == (True, "MII up · 활성 Aggregator")
    assert AC.member_rejoined(PROC.format(m0="down", a0=1), "ens1f0", "802.3ad")[0] is False
    ok, why = AC.member_rejoined(PROC.format(m0="up", a0=2), "ens1f0", "802.3ad")
    assert ok is False and "Aggregator 2" in why
    assert AC.member_rejoined(PROC.format(m0="up", a0=2), "ens1f0", "active-backup")[0] is True


# ── 가짜 노드로 전체 흐름 ─────────────────────────────────────────────────────

class FakeNode:
    """SSH 로 받은 명령을 해석해 상태를 바꾸는 가짜 노드 — 수집 스크립트 출력도 상태에서 만든다."""

    def __init__(self, *, rejoin=True, lacp_refuse=False, nm=True, slave_down=False):
        self.st = {
            "bond": {"mode": "802.3ad 4", "xmit_hash_policy": "layer2 0", "lacp_rate": "slow 0", "miimon": "100",
                     "slaves": "ens1f0 ens1f1"},
            "if": {n: {"rx": 1024, "rx_max": 8192, "tx": 1024, "tx_max": 8192, "comb": 8, "comb_max": 63,
                       "lro": "on", "gro": "on", "mii": "up", "agg": 1} for n in ("ens1f0", "ens1f1")},
        }
        if slave_down:
            self.st["if"]["ens1f1"]["mii"] = "down"
        self.rejoin, self.lacp_refuse, self.nm = rejoin, lacp_refuse, nm
        self.cmds: list[str] = []
        self.nm_props: dict[str, dict[str, str]] = {"bond0": {"bond.options": "mode=802.3ad,miimon=100,lacp_rate=slow"},
                                                    "bond0-ens1f0": {}, "bond0-ens1f1": {}}
        self.rollback_script = ""
        self.timer_armed = False

    def collect(self) -> str:
        b = self.st["bond"]
        out = [f"@@IF bond0", "operstate=up", "carrier=1", "mtu=9000", "bonding=1", "lower=ens1f0", "lower=ens1f1"]
        out += [f"bond.{k}={v}" for k, v in b.items()]
        out += ["@@PROC", self.proc(), "@@END"]
        for n, s in self.st["if"].items():
            out += [f"@@IF {n}", "operstate=up", "carrier=1", "speed=25000", "duplex=full", "mtu=9000", "device=1", "master=bond0",
                    "@@ETH g", "Pre-set maximums:", f"RX:\t{s['rx_max']}", f"TX:\t{s['tx_max']}", "Current hardware settings:",
                    f"RX:\t{s['rx']}", f"TX:\t{s['tx']}", "@@END",
                    "@@ETH l", "Pre-set maximums:", f"Combined:\t{s['comb_max']}", "Current hardware settings:", f"Combined:\t{s['comb']}", "@@END",
                    "@@ETH k", f"large-receive-offload: {s['lro']}", f"generic-receive-offload: {s['gro']}", "@@END",
                    "@@ETH i", "driver: mlx5_core", "@@END"]
        return "\n".join(out) + "\n"

    def proc(self) -> str:
        lines = ["Bonding Mode: IEEE 802.3ad Dynamic link aggregation", "Active Aggregator Info:", "\tAggregator ID: 1"]
        for n, s in self.st["if"].items():
            lines += [f"Slave Interface: {n}", f"MII Status: {s['mii']}", f"Aggregator ID: {s['agg']}"]
        return "\n".join(lines)

    def ethtool(self, args: list[str]) -> None:
        op, n = args[0], args[1]
        s = self.st["if"][n]
        kv = dict(zip(args[2::2], args[3::2]))
        if op == "-G":
            for side in ("rx", "tx"):
                if side in kv:
                    s[side] = int(kv[side])
        elif op == "-L":
            s["comb"] = int(kv["combined"])
        elif op == "-K":
            for f, v in kv.items():
                s[f] = v
        # 큐 재생성 — 하위가 잠깐 빠졌다 돌아온다(rejoin=False 면 다른 Aggregator 로)
        s["agg"] = 1 if self.rejoin else 2

    def __call__(self, target, command, **kw):
        inner = shlex.split(command)[-1] if command.startswith(("sh -c", "sudo -n sh -c")) else command
        self.cmds.append(inner)
        ok = SimpleNamespace(status="ok", stdout="", stderr="", exit_code=0, error=None)
        if "@@IF" in inner:
            return SimpleNamespace(status="ok", stdout=self.collect(), stderr="", exit_code=0, error=None)
        if inner.startswith("cat /proc/net/bonding/"):
            return SimpleNamespace(status="ok", stdout=self.proc(), stderr="", exit_code=0, error=None)
        if inner.startswith("mkdir -p /run/pep"):
            self.rollback_script = inner.split("<<'PEP_NIC_EOF'\n", 1)[1].split("PEP_NIC_EOF", 1)[0]
            return ok
        if "systemd-run" in inner:
            self.timer_armed = True
            return ok
        if inner.startswith(f"systemctl stop {AC.ROLLBACK_UNIT}.timer;"):
            self.timer_armed = False
            return ok
        if inner.startswith(f"sh {AC.ROLLBACK_SCRIPT}"):
            for line in self.rollback_script.splitlines():
                line = line.replace(" || true", "")
                if line.startswith("ethtool"):
                    self.ethtool(line.split()[1:])
                    for s in self.st["if"].values():
                        s["agg"] = 1
                elif line.startswith("echo "):
                    val, path = line[5:].split(" > ")
                    self.st["bond"][path.rsplit("/", 1)[1]] = val
            self.timer_armed = False
            return ok
        if inner.startswith("echo ") and "/bonding/" in inner:
            val, path = inner[5:].split(" > ")
            attr = path.rsplit("/", 1)[1]
            if attr == "lacp_rate" and self.lacp_refuse:
                return SimpleNamespace(status="error", stdout="", stderr="Operation not permitted", exit_code=1, error=None)
            self.st["bond"][attr] = val
            return ok
        if inner.startswith("ethtool "):
            self.ethtool(inner.split()[1:])
            return ok
        if inner.startswith("command -v nmcli"):
            return SimpleNamespace(status="ok", stdout="yes\n" if self.nm else "no\n", stderr="", exit_code=0, error=None)
        if inner.startswith("nmcli -t -g GENERAL.STATE,GENERAL.CONNECTION device show"):
            dev = inner.split()[-1]
            conn = "bond0" if dev == "bond0" else f"bond0-{dev}"
            return SimpleNamespace(status="ok", stdout=f"100 (connected)\n{conn}\n", stderr="", exit_code=0, error=None)
        if inner.startswith("nmcli -g "):
            prop, conn = inner.split()[2], shlex.split(inner)[-1]
            return SimpleNamespace(status="ok", stdout=self.nm_props.get(conn, {}).get(prop, "") + "\n", stderr="", exit_code=0, error=None)
        if inner.startswith("nmcli connection modify "):
            parts = shlex.split(inner)
            conn = parts[3]
            for p, v in zip(parts[4::2], parts[5::2]):
                self.nm_props.setdefault(conn, {})[p] = v
            return ok
        return ok


class Log:
    def __init__(self):
        self.lines = []

    def log(self, level, msg):
        self.lines.append((level, msg))

    def step(self, *a):
        pass


CFG = {"nic_ethtool": "ethtool", "nic_rollback_timer_sec": 120, "nic_member_wait_sec": 0, "nic_rejoin_timeout_sec": 10}
OPTS = {"persist": True, "member_wait_sec": 0, "rejoin_timeout_sec": 10}
CREDS = {"password": "x"}


@pytest.fixture
def fast_sleep(monkeypatch):
    monkeypatch.setattr(AC.time, "sleep", lambda s: None)


def _run(node, monkeypatch, values=VALUES):
    monkeypatch.setattr(AC.ssh_runner, "_exec_ssh", node)
    log = Log()
    return AC.nic_node("w1", "10.0.0.1", values, CFG, normalize(None), OPTS, CREDS, log), log


def test_node_apply_success_one_member_at_a_time_with_nm(monkeypatch, fast_sleep):
    node = FakeNode()
    res, log = _run(node, monkeypatch)
    assert res["status"] == "ok", (res["error"], log.lines)
    for n in ("ens1f0", "ens1f1"):
        s = node.st["if"][n]
        assert (s["rx"], s["comb"], s["lro"]) == (8192, 16, "off")
    assert node.st["bond"]["xmit_hash_policy"] == "layer3+4" and node.st["bond"]["lacp_rate"] == "fast"
    assert node.timer_armed is False  # 확인 뒤 데드맨 해제
    assert res["before"]["ring.rx"] == "1024/8192" and res["after"]["ring.rx"] == "8192/8192"  # 실행 화면 표 모양
    order = [c for c in node.cmds if c.startswith(("ethtool", "cat /proc/net/bonding"))]
    first_e1 = next(i for i, c in enumerate(order) if "ens1f1" in c and c.startswith("ethtool"))
    assert any(c.startswith("cat /proc/net/bonding") for c in order[:first_e1])  # 다음 하위 전에 재합류 확인
    assert node.nm_props["bond0-ens1f0"] == {"ethtool.ring-rx": "8192", "ethtool.channels-combined": "16",
                                             "ethtool.feature-lro": "off", "ethtool.feature-gro": "on"}
    assert node.nm_props["bond0"]["bond.options"] == "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"
    assert not any("connection up" in c or "reapply" in c for c in node.cmds)


def test_node_apply_rejoin_failure_rolls_back(monkeypatch, fast_sleep):
    node = FakeNode(rejoin=False)
    res, log = _run(node, monkeypatch)
    assert res["status"] == "failed" and "다시 들어오지 않음" in res["error"]
    s = node.st["if"]["ens1f0"]
    assert (s["rx"], s["comb"], s["lro"]) == (1024, 8, "on")  # 원복
    assert node.st["bond"]["xmit_hash_policy"] == "layer2"
    assert node.st["if"]["ens1f1"]["rx"] == 1024  # 두 번째 하위는 건드리지 않았다
    assert node.timer_armed is False and any("원복" in m for _, m in log.lines)
    assert not any(c.startswith("nmcli connection modify") for c in node.cmds)


def test_node_apply_no_redundancy_and_lacp_refused(monkeypatch, fast_sleep):
    node = FakeNode(slave_down=True, lacp_refuse=True)
    res, log = _run(node, monkeypatch)
    assert res["status"] == "ok", res["error"]
    assert node.st["if"]["ens1f0"]["rx"] == 1024  # 이중화 없음 → 큐 재생성 변경 건너뜀
    assert node.st["bond"]["xmit_hash_policy"] == "layer3+4"  # 끊김 없는 키는 적용
    assert any("lacp_rate" in n and "재기동" in n for n in res["notes"])
    assert node.nm_props["bond0"]["bond.options"].endswith("lacp_rate=fast,xmit_hash_policy=layer3+4")  # 영구 기록은 한다


def test_node_apply_plan_error_and_no_nm(monkeypatch, fast_sleep):
    node = FakeNode()
    res, _ = _run(node, monkeypatch, {**VALUES, "channels.combined": "99"})
    assert res["status"] == "failed" and "99 > 최대 63" in res["error"]
    assert not any(c.startswith("ethtool") for c in node.cmds) and node.timer_armed is False
    node2 = FakeNode(nm=False)
    res2, _ = _run(node2, monkeypatch)
    assert res2["status"] == "ok" and any("NetworkManager 없음" in n for n in res2["notes"])


# ── 계획·실행 경로(실제 DB, 가짜 SSH) ─────────────────────────────────────────

@pytest.fixture
def db():
    from app.database import Base, SessionLocal, engine
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    yield s
    s.close()


def test_plan_and_execute_marks_applied(db, monkeypatch, fast_sleep):
    import asyncio
    import uuid
    from datetime import datetime

    from app.models import ClusterConfigSnapshot
    from app.models.cluster import Cluster
    from app.models.node_nic import NodeNicState
    from app.models.service_config import ServiceConfigApplyRun, ServiceConfigChange, ServiceConfigVersion
    from app.services.nic_watch import service as nic_svc
    from app.services.nic_watch import ssh_collect as NS
    from app.services.service_config import apply as A
    from app.services.service_config.catalog_seed import seed_catalog, seed_rules

    seed_catalog(db)
    seed_rules(db)
    c = Cluster(name=f"nicap-{uuid.uuid4().hex[:8]}", api_endpoint="https://x:6443")
    db.add(c)
    db.commit()
    node = FakeNode()
    try:
        ifaces = NS.parse_output(node.collect(), normalize(None))["interfaces"]
        nic_svc.ingest(db, c, "w1", "10.0.0.1", None, datetime.utcnow().isoformat(), {"interfaces": ifaces}, source="ssh")
        db.add(ServiceConfigVersion(cluster_id=c.id, service="nic", group_id=None, version_no=1, status="saved",
                                    values=dict(VALUES), created_by="t"))
        db.commit()
        plan = A.plan_apply(db, c, "nic", None, None)
        assert plan["supported"] and plan["targets"] == [{"node": "w1", "host": "10.0.0.1"}]
        assert any("systemd-run" in cmd for cmd in plan["commands"])
        monkeypatch.setattr(AC.ssh_runner, "_exec_ssh", node)
        run = A.start_run(db, c, "nic", plan, {"batch_size": 1, "pause_sec": 0, "stop_on_failure": True, "persist": True,
                                               "member_wait_sec": 0, "rejoin_timeout_sec": 10}, "tester")
        out = asyncio.run(A.execute(db, c, run.id, plan, run.options, CREDS, lambda e: None))
        assert out["status"] == "succeeded", out
        ver = db.query(ServiceConfigVersion).filter(ServiceConfigVersion.cluster_id == c.id).one()
        assert ver.status == "applied"
        snap = (db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == c.id,
                                                       ClusterConfigSnapshot.component == "nic:w1")
                .order_by(ClusterConfigSnapshot.collected_at.desc()).first())
        assert snap.data["flat"]["ring.rx"] == "8192/8192" and snap.data["source"] == "apply"
        chs = db.query(ServiceConfigChange).filter(ServiceConfigChange.cluster_id == c.id).all()
        assert chs and all(ch.source == "apply" for ch in chs)  # PEP 적용 — 변경 알람 대상 아님
    finally:
        db.rollback()
        from app.models.alert_event import AlertEvent

        for M in (ServiceConfigChange, ServiceConfigApplyRun, ServiceConfigVersion, ClusterConfigSnapshot, NodeNicState, AlertEvent):
            db.query(M).filter(M.cluster_id == c.id).delete(synchronize_session=False)
        db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
        db.commit()
