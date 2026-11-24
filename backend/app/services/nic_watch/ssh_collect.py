"""NIC SSH 수집 — 노드에서 돌릴 조회 셸 스크립트와 그 출력 파서(순수 함수, 단위 테스트 대상).

노드에서는 **조회 명령만** 실행한다(``cat`` sysfs·``/proc/net/bonding``, ``ethtool -g/-l/-k/-i/-S``). 파싱은 백엔드가 하므로
노드에 python 이 필요 없다. 결과는 에이전트 보고(``node_param_agent/nic.collect``)와 **같은 형태**라
``nic_watch.service.ingest(..., source="ssh")`` 로 그대로 저장한다.

출력 형식(인터페이스마다):
    @@IF <name>
    key=value                 # operstate·carrier·speed·duplex·mtu·carrier_changes·device·bonding·bridge·master·lower·DEVTYPE
    stat.<counter>=<n>        # /sys/class/net/<if>/statistics
    bond.<opt>=<value>        # /sys/class/net/<bond>/bonding/*
    @@PROC … @@END            # /proc/net/bonding/<bond>
    @@ETH <opt> … @@END       # ethtool -<opt> <if> (물리 인터페이스만)
"""
from __future__ import annotations

import fnmatch
import re
from typing import Any, Optional

from app.node_param_agent.nic import DRIVER_STAT_RE, MAX_DRIVER_STATS, SYSFS_COUNTERS, parse_proc_bonding

# ethtool -k 이름 → 커널 기능 이름(에이전트 형태와 맞춘다)
ETHTOOL_K_TO_KERNEL = {
    "rx-checksumming": "rx-checksum", "scatter-gather": "tx-scatter-gather",
    "tcp-segmentation-offload": "tx-tcp-segmentation", "generic-segmentation-offload": "tx-generic-segmentation",
    "generic-receive-offload": "rx-gro", "large-receive-offload": "rx-lro", "receive-hashing": "rx-hashing",
    "rx-vlan-offload": "rx-vlan-hw-parse", "tx-vlan-offload": "tx-vlan-hw-insert",
    "tx-checksum-ip-generic": "tx-checksum-ip-generic", "tx-checksum-ipv4": "tx-checksum-ipv4",
    "tx-checksum-ipv6": "tx-checksum-ipv6", "tx-tcp6-segmentation": "tx-tcp6-segmentation",
    "rx-gro-hw": "rx-gro-hw", "tx-udp_tnl-segmentation": "tx-udp_tnl-segmentation",
    "tx-udp_tnl-csum-segmentation": "tx-udp_tnl-csum-segmentation",
}
_SAFE_GLOB = re.compile(r"^[A-Za-z0-9_.:@*?\[\]-]{1,64}$")
_SAFE_PATH = re.compile(r"^[A-Za-z0-9_./-]{1,200}$")
_STAT_GREP = "miss|no_?buf|out_of_buffer|discard|fifo|drop|crc|over|err|alloc_fail"


def build_script(exclude_names: list[str], ethtool: str = "ethtool") -> str:
    """노드에서 실행할 POSIX sh. 제외 이름은 ``case`` 패턴으로(설정 검증을 통과한 glob 만), 경로는 문자 검증."""
    globs = [g for g in exclude_names if _SAFE_GLOB.match(g)] or ["lo"]
    eth = ethtool if _SAFE_PATH.match(ethtool or "") else "ethtool"
    stats = " ".join(SYSFS_COUNTERS)
    return f"""E={eth}; command -v "$E" >/dev/null 2>&1 || E=""
[ -z "$E" ] && echo "@@WARN ethtool 없음 — ring·채널·offload 는 읽지 않는다"
for d in /sys/class/net/*; do
  n=${{d##*/}}
  case "$n" in {"|".join(globs)}) continue;; esac
  echo "@@IF $n"
  for f in operstate carrier speed duplex mtu carrier_changes; do printf '%s=%s\\n' "$f" "$(cat "$d/$f" 2>/dev/null)"; done
  [ -e "$d/device" ] && echo device=1
  [ -d "$d/bonding" ] && echo bonding=1
  [ -d "$d/bridge" ] && echo bridge=1
  m=$(readlink "$d/master" 2>/dev/null) && echo "master=${{m##*/}}"
  for l in "$d"/lower_*; do [ -e "$l" ] && echo "lower=${{l##*/lower_}}"; done
  grep -h '^DEVTYPE=' "$d/uevent" 2>/dev/null
  for s in {stats}; do v=$(cat "$d/statistics/$s" 2>/dev/null) && echo "stat.$s=$v"; done
  if [ -d "$d/bonding" ]; then
    for b in mode xmit_hash_policy lacp_rate miimon arp_interval updelay downdelay slaves; do printf 'bond.%s=%s\\n' "$b" "$(cat "$d/bonding/$b" 2>/dev/null)"; done
    echo "@@PROC"; cat "/proc/net/bonding/$n" 2>/dev/null; echo "@@END"
  fi
  if [ -n "$E" ] && [ -e "$d/device" ]; then
    for o in g l k i; do echo "@@ETH $o"; "$E" -$o "$n" 2>&1; echo "@@END"; done
    echo "@@ETH S"; "$E" -S "$n" 2>/dev/null | grep -Ei '{_STAT_GREP}' | head -{MAX_DRIVER_STATS}; echo "@@END"
  fi
done
"""


def _int(v: Any) -> Optional[int]:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _two_sections(text: str) -> tuple[dict[str, str], dict[str, str]]:
    """``ethtool -g``/``-l`` — ('Pre-set maximums' 표, 'Current hardware settings' 표)."""
    mx: dict[str, str] = {}
    cur: dict[str, str] = {}
    target: Optional[dict[str, str]] = None
    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower()
        if low.startswith("pre-set maximums"):
            target = mx
        elif low.startswith("current hardware settings"):
            target = cur
        elif target is not None and ":" in line:
            k, v = line.split(":", 1)
            target[k.strip().lower()] = v.strip()
    return mx, cur


def parse_ring(text: str) -> Optional[dict[str, Optional[int]]]:
    mx, cur = _two_sections(text)
    if not mx or not cur:
        return None
    return {"rx": _int(cur.get("rx")), "rx_max": _int(mx.get("rx")), "tx": _int(cur.get("tx")), "tx_max": _int(mx.get("tx"))}


def parse_channels(text: str) -> Optional[dict[str, Optional[int]]]:
    mx, cur = _two_sections(text)
    if not mx or not cur:
        return None
    out = {"combined": _int(cur.get("combined")), "combined_max": _int(mx.get("combined")),
           "rx": _int(cur.get("rx")), "rx_max": _int(mx.get("rx")), "tx": _int(cur.get("tx")), "tx_max": _int(mx.get("tx"))}
    return out if (out["combined_max"] or out["rx_max"] or out["tx_max"]) else None


def parse_features(text: str) -> Optional[dict[str, dict[str, bool]]]:
    out: dict[str, dict[str, bool]] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if ":" not in line or line.lower().startswith("features for"):
            continue
        name, rest = line.split(":", 1)
        kernel = ETHTOOL_K_TO_KERNEL.get(name.strip())
        if not kernel:
            continue
        rest = rest.strip()
        out[kernel] = {"on": rest.startswith("on"), "fixed": "[fixed]" in rest}
    return out or None


def parse_drvinfo(text: str) -> Optional[dict[str, str]]:
    kv = {k.strip(): v.strip() for k, v in (ln.split(":", 1) for ln in text.splitlines() if ":" in ln)}
    if not kv.get("driver"):
        return None
    return {"driver": kv.get("driver", ""), "version": kv.get("version", ""),
            "firmware": kv.get("firmware-version", ""), "bus": kv.get("bus-info", "")}


def parse_stats(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for raw in text.splitlines():
        if ":" not in raw:
            continue
        k, v = raw.split(":", 1)
        name, val = k.strip(), _int(v)
        if name and val is not None and DRIVER_STAT_RE.search(name):
            out[name] = val
    return out


def _kind(attrs: dict[str, Any]) -> str:
    if attrs.get("bonding"):
        return "bond"
    if attrs.get("bridge"):
        return "bridge"
    dt = attrs.get("DEVTYPE", "")
    if dt == "vlan":
        return "vlan"
    if dt in ("vxlan", "geneve", "ipip", "gre", "ip6tnl"):
        return "tunnel"
    return "physical" if attrs.get("device") else "virtual"


def parse_output(text: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """스크립트 출력 → {interfaces, errors} (에이전트 보고와 같은 형태). ``cfg`` 는 NIC 설정(수집 대상 선택)."""
    errors: list[str] = []
    blocks: list[tuple[str, list[str]]] = []
    for raw in text.splitlines():
        if raw.startswith("@@WARN "):
            errors.append(raw[7:].strip())
        elif raw.startswith("@@IF "):
            blocks.append((raw[5:].strip(), []))
        elif blocks:
            blocks[-1][1].append(raw)
    kinds = set(cfg.get("include_kinds") or [])
    inc = cfg.get("include_names") or []
    exc = cfg.get("exclude_names") or []
    ifaces: list[dict[str, Any]] = []
    for name, lines in blocks:
        attrs: dict[str, Any] = {"lowers": []}
        stats: dict[str, int] = {}
        bond: dict[str, Any] = {}
        sub: dict[str, list[str]] = {}
        cur: Optional[str] = None
        for ln in lines:
            if ln.startswith("@@PROC"):
                cur = "proc"
                sub[cur] = []
                continue
            if ln.startswith("@@ETH "):
                cur = ln[6:].strip()
                sub[cur] = []
                continue
            if ln.startswith("@@END"):
                cur = None
                continue
            if cur is not None:
                sub[cur].append(ln)
                continue
            if "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            if k == "lower":
                attrs["lowers"].append(v.strip())
            elif k.startswith("stat."):
                iv = _int(v)
                if iv is not None:
                    stats[k[5:]] = iv
            elif k.startswith("bond."):
                bond[k[5:]] = v.strip()
            else:
                attrs[k] = v.strip()
        kind = _kind(attrs)
        if any(fnmatch.fnmatchcase(name, p) for p in exc):
            continue
        if not (kind in kinds or any(fnmatch.fnmatchcase(name, p) for p in inc)):
            continue
        speed = _int(attrs.get("speed"))
        it: dict[str, Any] = {
            "name": name, "kind": kind, "operstate": attrs.get("operstate") or None,
            "carrier": _int(attrs.get("carrier")), "mtu": _int(attrs.get("mtu")),
            "speed": speed if speed and speed > 0 else None,
            "duplex": attrs.get("duplex") if attrs.get("duplex") in ("full", "half") else None,
            "master": attrs.get("master") or None, "lowers": sorted(attrs["lowers"]),
        }
        counters = dict(stats)
        cc = _int(attrs.get("carrier_changes"))
        if cc is not None:
            counters["carrier_changes"] = cc
        if kind == "vlan":
            m = re.search(r"\.(\d+)$", name)
            it["vlan_id"] = int(m.group(1)) if m else None
        if kind == "bond":
            def first(key: str) -> Optional[str]:
                v = bond.get(key) or ""
                return v.split()[0] if v.split() else None
            b: dict[str, Any] = {
                "mode": first("mode"), "xmit_hash_policy": first("xmit_hash_policy"), "lacp_rate": first("lacp_rate"),
                "miimon": _int(bond.get("miimon")), "arp_interval": _int(bond.get("arp_interval")),
                "updelay": _int(bond.get("updelay")), "downdelay": _int(bond.get("downdelay")),
                "slaves": (bond.get("slaves") or "").split(),
            }
            if sub.get("proc"):
                b.update(parse_proc_bonding("\n".join(sub["proc"])))
            it["bond"] = b
        if kind == "physical" and "g" in sub:
            it["ring"] = parse_ring("\n".join(sub["g"]))
            it["channels"] = parse_channels("\n".join(sub.get("l") or []))
            it["driver"] = parse_drvinfo("\n".join(sub.get("i") or []))
            it["features"] = parse_features("\n".join(sub.get("k") or []))
            counters.update({f"drv:{k}": v for k, v in parse_stats("\n".join(sub.get("S") or [])).items()})
        it["counters"] = counters
        ifaces.append(it)
    by = {i["name"]: i for i in ifaces}
    for i in ifaces:
        for sname, st in ((i.get("bond") or {}).get("slave_state") or {}).items():
            if sname in by:
                by[sname]["lacp"] = st
                if st.get("link_failures") is not None:
                    by[sname].setdefault("counters", {})["bond_link_failures"] = st["link_failures"]
    return {"interfaces": ifaces, "errors": errors}
