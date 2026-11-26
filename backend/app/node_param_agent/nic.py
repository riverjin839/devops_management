"""NIC 상태 수집 — 노드 파라미터 에이전트가 보고 주기마다 함께 읽는다. **표준 라이브러리만 쓴다.**

읽는 곳(전부 읽기 전용, 루트·CAP_NET_ADMIN 불필요):
- ``/sys/class/net/<iface>/`` : operstate·carrier·speed·duplex·mtu·carrier_changes·statistics/*, 본딩은 ``bonding/*``,
  상·하위 관계는 ``master``·``lower_*`` 링크. 에이전트가 ``hostNetwork`` 라 노드의 인터페이스가 보인다.
- ``/proc/net/bonding/<bond>`` : 하위 인터페이스별 MII 상태·Aggregator ID·LACP 상대(partner) MAC·링크 실패 횟수.
- ethtool ioctl(``SIOCETHTOOL``) 의 조회(GET) 명령 : ring buffer(-g), 채널 수(-l), 드라이버(-i), offload(-k), 드라이버 통계(-S), autoneg.
  커널이 GET 명령은 권한 없이 허용하므로 ``ethtool`` 바이너리도 capability 도 필요 없다. 드라이버가 지원하지 않으면 그 항목만 비운다.

어떤 오류도 보고 전체를 막지 않는다 — 인터페이스·항목 단위로 비우고 ``errors`` 에 남긴다.
"""
from __future__ import annotations

import ctypes
import fcntl
import fnmatch
import os
import re
import socket
import struct
from pathlib import Path
from typing import Any, Optional

SIOCETHTOOL = 0x8946
ETHTOOL_GSET = 0x01
ETHTOOL_GDRVINFO = 0x03
ETHTOOL_GRINGPARAM = 0x10
ETHTOOL_GRXCSUM = 0x14
ETHTOOL_GTXCSUM = 0x16
ETHTOOL_GSG = 0x18
ETHTOOL_GSTRINGS = 0x1B
ETHTOOL_GSTATS = 0x1D
ETHTOOL_GTSO = 0x1E
ETHTOOL_GGSO = 0x23
ETHTOOL_GFLAGS = 0x25
ETHTOOL_GGRO = 0x2B
ETHTOOL_GSSET_INFO = 0x37
ETHTOOL_GFEATURES = 0x3A
ETHTOOL_GCHANNELS = 0x3C
ETH_SS_STATS = 1
ETH_SS_FEATURES = 4
ETH_FLAG_LRO = 1 << 15
ETH_GSTRING_LEN = 32

MAX_IFACES = 64
MAX_DRIVER_STATS = 40

# 보고하는 offload(커널 기능 이름). 화면 이름(ethtool -k)은 백엔드가 붙인다.
FEATURES = (
    "rx-checksum", "tx-checksum-ip-generic", "tx-checksum-ipv4", "tx-checksum-ipv6", "tx-scatter-gather",
    "tx-tcp-segmentation", "tx-tcp6-segmentation", "tx-generic-segmentation", "rx-gro", "rx-gro-hw", "rx-lro",
    "tx-udp_tnl-segmentation", "tx-udp_tnl-csum-segmentation", "rx-hashing", "rx-vlan-hw-parse", "tx-vlan-hw-insert",
)

# /sys/class/net/<iface>/statistics 에서 읽는 카운터 — 드롭·오류 판단용.
SYSFS_COUNTERS = (
    "rx_packets", "tx_packets", "rx_dropped", "tx_dropped", "rx_errors", "tx_errors", "rx_missed_errors",
    "rx_fifo_errors", "rx_over_errors", "rx_crc_errors", "rx_frame_errors", "rx_length_errors",
)

# 드라이버 통계(ethtool -S) 중 드롭·버퍼 부족·오류로 보이는 것만 보낸다(수백 개라 전부 보내지 않는다).
DRIVER_STAT_RE = re.compile(r"(miss|no_?buf|out_of_buffer|discard|fifo|drop|crc|over|err|alloc_fail)", re.I)

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
    "include_kinds": ["physical", "bond", "vlan", "tunnel"],
    "include_names": ["cilium_host", "cilium_vxlan", "cilium_geneve"],
    "exclude_names": ["lo", "lxc*", "veth*", "docker*", "cni*", "flannel*", "kube-ipvs*", "nodelocaldns", "tunl*"],
}


# ── sysfs ────────────────────────────────────────────────────────────────────

def _read(p: Path) -> Optional[str]:
    try:
        return p.read_text(errors="replace").strip()
    except OSError:  # 링크 다운 상태의 speed 는 EINVAL — 값 없음으로 둔다
        return None


def _int(v: Optional[str]) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


def _uevent(d: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (_read(d / "uevent") or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def iface_kind(d: Path) -> str:
    """physical | bond | vlan | bridge | tunnel | virtual"""
    if (d / "bonding").is_dir():
        return "bond"
    if (d / "bridge").is_dir():
        return "bridge"
    devtype = _uevent(d).get("DEVTYPE", "")
    if devtype == "vlan":
        return "vlan"
    if devtype in ("vxlan", "geneve", "ipip", "gre", "ip6tnl"):
        return "tunnel"
    if (d / "device").exists():
        return "physical"
    return "virtual"


def select_ifaces(sys_net: Path, cfg: dict[str, Any]) -> list[tuple[str, str]]:
    """보고할 (이름, 종류). 제외 패턴이 이기고, 종류가 목록에 있거나 이름이 포함 패턴에 맞으면 넣는다."""
    kinds = set(cfg.get("include_kinds") or [])
    inc = [str(x) for x in cfg.get("include_names") or []]
    exc = [str(x) for x in cfg.get("exclude_names") or []]
    out: list[tuple[str, str]] = []
    try:
        entries = sorted(sys_net.iterdir(), key=lambda p: p.name)
    except OSError:
        return out
    for d in entries:
        name = d.name
        if any(fnmatch.fnmatchcase(name, pat) for pat in exc):
            continue
        kind = iface_kind(d)
        if kind in kinds or any(fnmatch.fnmatchcase(name, pat) for pat in inc):
            out.append((name, kind))
        if len(out) >= MAX_IFACES:
            break
    return out


def _links(d: Path, prefix: str) -> list[str]:
    try:
        return sorted(p.name[len(prefix):] for p in d.iterdir() if p.name.startswith(prefix))
    except OSError:
        return []


def _master(d: Path) -> Optional[str]:
    try:
        return os.path.basename(os.readlink(d / "master"))
    except OSError:
        return None


def read_bond_sysfs(d: Path) -> dict[str, Any]:
    b = d / "bonding"

    def first(name: str) -> Optional[str]:
        v = _read(b / name)
        return v.split()[0] if v else None

    return {
        "mode": first("mode"),
        "xmit_hash_policy": first("xmit_hash_policy"),
        "lacp_rate": first("lacp_rate"),
        "miimon": _int(_read(b / "miimon")),
        "arp_interval": _int(_read(b / "arp_interval")),
        "updelay": _int(_read(b / "updelay")),
        "downdelay": _int(_read(b / "downdelay")),
        "slaves": (_read(b / "slaves") or "").split(),
    }


def parse_proc_bonding(text: str) -> dict[str, Any]:
    """``/proc/net/bonding/<bond>`` 해석 — {active: {aggregator_id, ports, partner_mac, actor_key, partner_key},
    slave_state: {이름: {mii_status, speed, duplex, link_failures, aggregator_id, partner_mac, partner_key}}}."""
    active: dict[str, Any] = {}
    slaves: dict[str, dict[str, Any]] = {}
    cur: Optional[dict[str, Any]] = None   # None = 본딩 전체 구역
    block = ""                             # 'active' | 'actor' | 'partner' | ''
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith("slave interface:"):
            name = line.split(":", 1)[1].strip()
            cur = slaves.setdefault(name, {})
            block = ""
            continue
        if low.startswith("active aggregator info"):
            block = "active"
            continue
        if low.startswith("details actor lacp pdu"):
            block = "actor"
            continue
        if low.startswith("details partner lacp pdu"):
            block = "partner"
            continue
        if ":" not in line:
            continue
        key, val = (x.strip() for x in line.split(":", 1))
        key = key.lower()
        if cur is None:
            if block == "active":
                if key == "aggregator id":
                    active["aggregator_id"] = _int(val)
                elif key == "number of ports":
                    active["ports"] = _int(val)
                elif key == "actor key":
                    active["actor_key"] = _int(val)
                elif key == "partner key":
                    active["partner_key"] = _int(val)
                elif key == "partner mac address":
                    active["partner_mac"] = val.lower()
            continue
        if block == "partner":
            if key == "system mac address":
                cur["partner_mac"] = val.lower()
            elif key == "oper key":
                cur["partner_key"] = _int(val)
            continue
        if block == "actor":
            continue
        if key == "mii status":
            cur["mii_status"] = val.lower()
        elif key == "speed":
            cur["speed"] = _int(val.split()[0]) if val and val.split()[0].isdigit() else None
        elif key == "duplex":
            cur["duplex"] = val.lower()
        elif key == "link failure count":
            cur["link_failures"] = _int(val)
        elif key == "aggregator id":
            cur["aggregator_id"] = _int(val)
    return {"active": active, "slave_state": slaves}


# ── ethtool ioctl ────────────────────────────────────────────────────────────

class _Ethtool:
    """한 번 연 소켓으로 인터페이스마다 GET ioctl 을 보낸다. 실패하면 None(드라이버 미지원·가상 인터페이스)."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def close(self) -> None:
        self.sock.close()

    def call(self, ifname: str, buf: ctypes.Array) -> bool:
        ifr = struct.pack("16sP", ifname.encode()[:15], ctypes.addressof(buf))
        try:
            fcntl.ioctl(self.sock.fileno(), SIOCETHTOOL, ifr)
            return True
        except OSError:
            return False

    def _value(self, ifname: str, cmd: int) -> Optional[int]:
        buf = ctypes.create_string_buffer(struct.pack("=II", cmd, 0))
        return struct.unpack_from("=II", buf.raw)[1] if self.call(ifname, buf) else None

    def ring(self, ifname: str) -> Optional[dict[str, int]]:
        buf = ctypes.create_string_buffer(struct.pack("=9I", ETHTOOL_GRINGPARAM, *([0] * 8)))
        if not self.call(ifname, buf):
            return None
        _, rx_max, _, _, tx_max, rx, _, _, tx = struct.unpack_from("=9I", buf.raw)
        if not rx_max and not tx_max:
            return None
        return {"rx": rx, "rx_max": rx_max, "tx": tx, "tx_max": tx_max}

    def channels(self, ifname: str) -> Optional[dict[str, int]]:
        buf = ctypes.create_string_buffer(struct.pack("=9I", ETHTOOL_GCHANNELS, *([0] * 8)))
        if not self.call(ifname, buf):
            return None
        _, max_rx, max_tx, _max_other, max_comb, rx, tx, _other, comb = struct.unpack_from("=9I", buf.raw)
        if not (max_comb or max_rx or max_tx):
            return None
        return {"combined": comb, "combined_max": max_comb, "rx": rx, "rx_max": max_rx, "tx": tx, "tx_max": max_tx}

    def drvinfo(self, ifname: str) -> Optional[dict[str, str]]:
        fmt = "=I32s32s32s32s32s12sIIIII"
        buf = ctypes.create_string_buffer(struct.pack(fmt, ETHTOOL_GDRVINFO, *([b""] * 6), 0, 0, 0, 0, 0))
        if not self.call(ifname, buf):
            return None
        f = struct.unpack_from(fmt, buf.raw)

        def s(b: bytes) -> str:
            return b.split(b"\0", 1)[0].decode(errors="replace")

        return {"driver": s(f[1]), "version": s(f[2]), "firmware": s(f[3]), "bus": s(f[4])}

    def autoneg(self, ifname: str) -> Optional[bool]:
        fmt = "=IIIHBBBBBBIIHBBIII"
        buf = ctypes.create_string_buffer(struct.pack(fmt, ETHTOOL_GSET, *([0] * 17)))
        if not self.call(ifname, buf):
            return None
        return bool(struct.unpack_from(fmt, buf.raw)[8])

    def _sset_count(self, ifname: str, sset: int) -> int:
        buf = ctypes.create_string_buffer(struct.pack("=IIQI", ETHTOOL_GSSET_INFO, 0, 1 << sset, 0))
        if not self.call(ifname, buf):
            return 0
        _, _, mask, n = struct.unpack_from("=IIQI", buf.raw)
        return n if mask & (1 << sset) else 0

    def _strings(self, ifname: str, sset: int, n: int) -> list[str]:
        buf = ctypes.create_string_buffer(struct.pack("=III", ETHTOOL_GSTRINGS, sset, n) + b"\0" * (n * ETH_GSTRING_LEN))
        if not self.call(ifname, buf):
            return []
        raw = buf.raw[12:12 + n * ETH_GSTRING_LEN]
        return [raw[i:i + ETH_GSTRING_LEN].split(b"\0", 1)[0].decode(errors="replace") for i in range(0, len(raw), ETH_GSTRING_LEN)]

    def features(self, ifname: str) -> Optional[dict[str, dict[str, bool]]]:
        n = self._sset_count(ifname, ETH_SS_FEATURES)
        names = self._strings(ifname, ETH_SS_FEATURES, n) if n else []
        if names:
            blocks = (len(names) + 31) // 32
            buf = ctypes.create_string_buffer(struct.pack("=II", ETHTOOL_GFEATURES, blocks) + b"\0" * (blocks * 16))
            if self.call(ifname, buf):
                out: dict[str, dict[str, bool]] = {}
                for i, name in enumerate(names):
                    if name not in FEATURES:
                        continue
                    available, _req, active, never = struct.unpack_from("=4I", buf.raw, 8 + (i // 32) * 16)
                    bit = 1 << (i % 32)
                    out[name] = {"on": bool(active & bit), "fixed": not (available & bit) or bool(never & bit)}
                return out
        return self._legacy_features(ifname)

    def _legacy_features(self, ifname: str) -> Optional[dict[str, dict[str, bool]]]:
        legacy = {"rx-checksum": ETHTOOL_GRXCSUM, "tx-checksum-ip-generic": ETHTOOL_GTXCSUM, "tx-scatter-gather": ETHTOOL_GSG,
                  "tx-tcp-segmentation": ETHTOOL_GTSO, "tx-generic-segmentation": ETHTOOL_GGSO, "rx-gro": ETHTOOL_GGRO}
        out: dict[str, dict[str, bool]] = {}
        for name, cmd in legacy.items():
            v = self._value(ifname, cmd)
            if v is not None:
                out[name] = {"on": bool(v), "fixed": False}
        flags = self._value(ifname, ETHTOOL_GFLAGS)
        if flags is not None:
            out["rx-lro"] = {"on": bool(flags & ETH_FLAG_LRO), "fixed": False}
        return out or None

    def driver_stats(self, ifname: str) -> dict[str, int]:
        n = self._sset_count(ifname, ETH_SS_STATS)
        if not n or n > 4096:
            return {}
        names = self._strings(ifname, ETH_SS_STATS, n)
        if len(names) != n:
            return {}
        buf = ctypes.create_string_buffer(struct.pack("=II", ETHTOOL_GSTATS, n) + b"\0" * (n * 8))
        if not self.call(ifname, buf):
            return {}
        vals = struct.unpack_from(f"={n}Q", buf.raw, 8)
        out: dict[str, int] = {}
        for name, v in zip(names, vals):
            if DRIVER_STAT_RE.search(name):
                out[name] = int(v)
                if len(out) >= MAX_DRIVER_STATS:
                    break
        return out


# ── 수집 ─────────────────────────────────────────────────────────────────────

def collect(cfg: Optional[dict[str, Any]] = None, *, sys_net: Optional[Path] = None,
            proc_bonding: Optional[Path] = None, use_ethtool: bool = True) -> dict[str, Any]:
    """{interfaces: [...], errors: [...]} — 응답의 ``nic`` 설정(``cfg``)대로 인터페이스를 고른다."""
    cfg = {**DEFAULT_CONFIG, **(cfg or {})}
    sys_net = sys_net or Path(os.environ.get("SYS_CLASS_NET", "/sys/class/net"))
    proc_bonding = proc_bonding or Path(os.environ.get("PROC_NET_BONDING", "/proc/net/bonding"))
    errors: list[str] = []
    eth: Optional[_Ethtool] = None
    if use_ethtool:
        try:
            eth = _Ethtool()
        except OSError as exc:
            errors.append(f"ethtool 소켓 열기 실패: {exc}")
    ifaces: list[dict[str, Any]] = []
    try:
        for name, kind in select_ifaces(sys_net, cfg):
            d = sys_net / name
            try:
                it: dict[str, Any] = {
                    "name": name, "kind": kind,
                    "operstate": _read(d / "operstate"),
                    "carrier": _int(_read(d / "carrier")),
                    "mtu": _int(_read(d / "mtu")),
                    "speed": None, "duplex": None,
                    "master": _master(d),
                    "lowers": _links(d, "lower_"),
                }
                speed = _int(_read(d / "speed"))
                it["speed"] = speed if speed and speed > 0 else None
                duplex = _read(d / "duplex")
                it["duplex"] = duplex if duplex in ("full", "half") else None
                counters: dict[str, int] = {}
                for c in SYSFS_COUNTERS:
                    v = _int(_read(d / "statistics" / c))
                    if v is not None:
                        counters[c] = v
                cc = _int(_read(d / "carrier_changes"))
                if cc is not None:
                    counters["carrier_changes"] = cc
                if kind == "vlan":
                    m = re.search(r"\.(\d+)$", name)
                    it["vlan_id"] = int(m.group(1)) if m else None
                if kind == "bond":
                    bond = read_bond_sysfs(d)
                    text = _read(proc_bonding / name)
                    if text:
                        bond.update(parse_proc_bonding(text))
                    it["bond"] = bond
                if eth is not None and kind in ("physical", "bond", "vlan", "tunnel"):
                    if kind == "physical":
                        it["ring"] = eth.ring(name)
                        it["channels"] = eth.channels(name)
                        it["driver"] = eth.drvinfo(name)
                        it["autoneg"] = eth.autoneg(name)
                        counters.update({f"drv:{k}": v for k, v in eth.driver_stats(name).items()})
                    it["features"] = eth.features(name)
                it["counters"] = counters
                ifaces.append(it)
            except Exception as exc:  # noqa: BLE001 — 한 인터페이스 실패는 그 인터페이스만
                errors.append(f"{name}: {type(exc).__name__}: {exc}")
    finally:
        if eth is not None:
            eth.close()
    # 본딩 하위 인터페이스에 LACP 상태를 붙인다(화면이 인터페이스 행에서 바로 보이게).
    by_name = {i["name"]: i for i in ifaces}
    for i in ifaces:
        for sname, st in ((i.get("bond") or {}).get("slave_state") or {}).items():
            if sname in by_name:
                by_name[sname]["lacp"] = st
                if st.get("link_failures") is not None:
                    by_name[sname].setdefault("counters", {})["bond_link_failures"] = st["link_failures"]
    return {"interfaces": ifaces, "errors": errors}
