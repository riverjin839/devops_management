"""NIC 상태 판정 — 노드별 마지막 보고(``NodeNicState``)와 설정으로 경고를 계산한다. DB 를 만지지 않는 순수 함수.

판정 범위(1차): 본딩/LACP · 링크(속도·duplex·플래핑) · MTU(상하위·노드 간) · ring buffer + 드롭 · CRC · offload.
수준: ``critical``(장애로 바로 이어짐) > ``warning``(성능·안정성) > ``info``(참고). 정상은 수준 없음(``ok``).

증가율은 카운터 표본(``history``)에서 창(``rate_window_minutes``) 이상 지난 가장 최근 표본을 기준으로 계산한다.
카운터가 줄었으면(NIC 재설정·드라이버 재적재) 그 카운터는 0 으로 본다.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Optional

LEVEL_ORDER = {"ok": 0, "info": 1, "warning": 2, "critical": 3}

# 커널 기능 이름 → ethtool -k 이름(화면 표시)
FEATURE_LABELS: dict[str, str] = {
    "rx-checksum": "rx-checksumming",
    "tx-checksum-ip-generic": "tx-checksum-ip-generic",
    "tx-checksum-ipv4": "tx-checksum-ipv4",
    "tx-checksum-ipv6": "tx-checksum-ipv6",
    "tx-scatter-gather": "scatter-gather",
    "tx-tcp-segmentation": "tcp-segmentation-offload",
    "tx-tcp6-segmentation": "tx-tcp6-segmentation",
    "tx-generic-segmentation": "generic-segmentation-offload",
    "rx-gro": "generic-receive-offload",
    "rx-gro-hw": "rx-gro-hw",
    "rx-lro": "large-receive-offload",
    "tx-udp_tnl-segmentation": "tx-udp_tnl-segmentation",
    "tx-udp_tnl-csum-segmentation": "tx-udp_tnl-csum-segmentation",
    "rx-hashing": "receive-hashing",
    "rx-vlan-hw-parse": "rx-vlan-offload",
    "tx-vlan-hw-insert": "tx-vlan-offload",
}
# 노드 간 비교·표에 쓰는 주요 offload
KEY_FEATURES = ("rx-checksum", "tx-checksum-ip-generic", "tx-tcp-segmentation", "rx-gro", "rx-lro", "tx-udp_tnl-segmentation")

HW_DROP_SYSFS = ("rx_missed_errors", "rx_fifo_errors", "rx_over_errors")
_DRV_DROP_RE = re.compile(r"(miss|no_?buf|out_of_buffer|discard|fifo|drop)", re.I)
ZERO_MAC = "00:00:00:00:00:00"
HASH_MODES = {"balance-xor", "802.3ad", "balance-tlb", "balance-alb"}


def _parse_ts(v: Any) -> Optional[datetime]:
    if isinstance(v, datetime):
        return v.replace(tzinfo=None)
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _is_hw_drop(counter: str) -> bool:
    if counter in HW_DROP_SYSFS:
        return True
    if not counter.startswith("drv:"):
        return False
    name = counter[4:].lower()
    return "rx" in name and "tx" not in name and "xdp" not in name and bool(_DRV_DROP_RE.search(name))


def pick_baseline(history: list[dict[str, Any]], now: datetime, window_min: int) -> Optional[dict[str, Any]]:
    """창 이상 지난 가장 최근 표본. 없으면 2분 이상 지난 가장 오래된 표본(막 설치한 노드)."""
    samples = [(t, s) for s in history if isinstance(s, dict) for t in [_parse_ts(s.get("t"))] if t and t < now]
    if not samples:
        return None
    cutoff = now - timedelta(minutes=window_min)
    old = [x for x in samples if x[0] <= cutoff]
    if old:
        t, s = max(old, key=lambda x: x[0])
    else:
        t, s = min(samples, key=lambda x: x[0])
        if (now - t) < timedelta(minutes=2):
            return None
    return {"t": t, "c": s.get("c") or {}}


def iface_rates(cur: dict[str, int], base: Optional[dict[str, Any]], iface: str, now: datetime) -> Optional[dict[str, Any]]:
    if not base:
        return None
    bc = (base["c"] or {}).get(iface)
    if not isinstance(bc, dict):
        return None
    minutes = max((now - base["t"]).total_seconds() / 60.0, 1e-6)

    def delta(name: str) -> int:
        if name not in cur or name not in bc:
            return 0
        d = int(cur[name]) - int(bc[name])
        return d if d > 0 else 0

    drop_counters = [c for c in cur if _is_hw_drop(c)]
    # 큐별·합계 카운터가 함께 있으면 합치면 두 번 센다 — 가장 큰 증가분을 드롭 수로 본다.
    drops = max((delta(c) for c in drop_counters), default=0)
    top = max(drop_counters, key=delta, default=None) if drops else None
    return {
        "window_minutes": round(minutes, 1),
        "drops": drops,
        "drops_per_min": round(drops / minutes, 2),
        "drop_counter": top,
        "rx_dropped": delta("rx_dropped"),
        "crc": delta("rx_crc_errors"),
        "flaps": delta("carrier_changes"),
        "bond_link_failures": delta("bond_link_failures"),
    }


def _f(level: str, code: str, node: str, iface: Optional[str], title: str, detail: str = "", hint: str = "",
       related: Optional[list[str]] = None) -> dict[str, Any]:
    """``related`` = 같은 판정을 표에서 함께 표시할 하위 인터페이스(본딩 하위 등). 경고 목록에는 한 번만 나온다."""
    return {"level": level, "code": code, "node": node, "iface": iface, "title": title, "detail": detail, "hint": hint,
            "related": related or []}


def _bond_findings(node: str, it: dict[str, Any], cfg: dict[str, Any], by_name: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    name = it["name"]
    b = it.get("bond") or {}
    mode = b.get("mode")
    slaves = list(b.get("slaves") or [])
    state = b.get("slave_state") or {}
    active = b.get("active") or {}
    if not slaves:
        out.append(_f("critical", "bond_no_slave", node, name, "하위 인터페이스 없음", "본딩에 묶인 인터페이스가 하나도 없다."))
        return out
    exp_mode = cfg.get("expected_bond_mode")
    if exp_mode and mode and mode != exp_mode:
        out.append(_f("warning", "bond_mode", node, name, f"본딩 모드 {mode}", f"기대 값 {exp_mode}.",
                      "설정 ▸ 기대 본딩 모드를 비우면 검사하지 않는다."))
    hp = b.get("xmit_hash_policy")
    exp_hp = cfg.get("expected_hash_policy")
    if mode in HASH_MODES and exp_hp and hp and hp != exp_hp:
        out.append(_f("warning", "bond_hash", node, name, f"해시 정책 {hp}", f"기대 값 {exp_hp}.",
                      "layer2 는 MAC 기준이라 같은 게이트웨이로 가는 Pod 트래픽이 링크 하나에 몰린다."))
    if (b.get("miimon") or 0) == 0 and (b.get("arp_interval") or 0) == 0:
        out.append(_f("warning", "bond_no_monitor", node, name, "링크 감시 꺼짐", "miimon·arp_interval 이 모두 0 이다.",
                      "miimon=100 처럼 켜야 하위 링크 장애를 감지해 빼낸다."))
    for s in slaves:
        st = state.get(s) or {}
        mii = st.get("mii_status") or ((by_name.get(s) or {}).get("operstate"))
        if mii and mii not in ("up",):
            out.append(_f("critical", "bond_slave_down", node, name, f"하위 인터페이스 {s} 다운",
                          f"{len(slaves)}개 중 하나가 내려가 이중화가 깨진 상태다.", "케이블·스위치 포트·광모듈을 확인한다.", [s]))
    speeds = {s: (state.get(s) or {}).get("speed") or (by_name.get(s) or {}).get("speed") for s in slaves}
    known = {v for v in speeds.values() if v}
    if len(known) > 1:
        out.append(_f("warning", "bond_speed_mismatch", node, name, "하위 인터페이스 속도 다름",
                      ", ".join(f"{s} {v or '-'}Mb/s" for s, v in speeds.items())))
    mtus = {s: (by_name.get(s) or {}).get("mtu") for s in slaves if s in by_name}
    bad_mtu = [s for s, m in mtus.items() if m and it.get("mtu") and m != it["mtu"]]
    if bad_mtu:
        out.append(_f("warning", "bond_slave_mtu", node, name, "하위 인터페이스 MTU 다름",
                      f"본딩 {it.get('mtu')} · " + ", ".join(f"{s} {mtus[s]}" for s in bad_mtu)))
    if mode == "802.3ad":
        exp_rate = cfg.get("expected_lacp_rate")
        rate = b.get("lacp_rate")
        if exp_rate and rate and rate != exp_rate:
            out.append(_f("warning", "lacp_rate", node, name, f"LACP rate {rate}", f"기대 값 {exp_rate}.",
                          "slow 는 30초마다 LACPDU 를 보내 스위치 쪽 장애 감지가 최대 90초 늦다."))
        agg = active.get("aggregator_id")
        outside = [s for s in slaves if agg is not None and (state.get(s) or {}).get("aggregator_id") not in (None, agg)]
        if outside:
            out.append(_f("critical", "lacp_aggregator", node, name, "LACP 집계 실패",
                          f"활성 Aggregator {agg} 에 속하지 않은 하위 인터페이스: {', '.join(outside)} — 실제로는 일부 링크만 쓰고 있다.",
                          "스위치 포트가 같은 LAG(port-channel) 에 묶였는지, LACP 가 active 인지 확인한다.", outside))
        pmac = (active.get("partner_mac") or "").lower()
        slave_pmacs = {s: ((state.get(s) or {}).get("partner_mac") or "").lower() for s in slaves}
        if pmac == ZERO_MAC or (slave_pmacs and all(v == ZERO_MAC for v in slave_pmacs.values() if v)
                                and any(slave_pmacs.values())):
            out.append(_f("critical", "lacp_no_partner", node, name, "스위치와 LACP 협상 안 됨",
                          "상대(partner) MAC 이 00:00:00:00:00:00 이다.", "스위치 포트의 LACP 설정(mode active/passive)을 확인한다."))
        else:
            distinct = {v for v in slave_pmacs.values() if v and v != ZERO_MAC}
            if len(distinct) > 1:
                out.append(_f("warning", "lacp_partner_mismatch", node, name, "하위 인터페이스마다 상대 스위치가 다름",
                              ", ".join(f"{s} {v}" for s, v in slave_pmacs.items()),
                              "MLAG(vPC) 이면 정상일 수 있다 — 스위치 두 대가 같은 시스템 MAC 을 쓰는지 확인한다."))
    return out


def _iface_findings(node: str, it: dict[str, Any], cfg: dict[str, Any], by_name: dict[str, dict[str, Any]],
                    rates: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    name, kind = it["name"], it.get("kind")
    oper = it.get("operstate")
    is_slave = bool(it.get("master")) and (by_name.get(it.get("master") or "") or {}).get("kind") == "bond"
    if oper == "down":
        if kind in ("bond", "vlan"):
            out.append(_f("critical", "link_down", node, name, "인터페이스 다운"))
        elif kind == "physical" and not is_slave:
            out.append(_f("info", "link_down_unused", node, name, "링크 없음",
                          "사용하지 않는 포트면 설정 ▸ 제외할 이름에 넣는다."))
    if kind == "physical" and oper == "up":
        if it.get("duplex") == "half":
            out.append(_f("critical", "half_duplex", node, name, "half duplex", "스위치 포트와 협상이 잘못됐다."))
        ms = int(cfg.get("min_speed_mbps") or 0)
        sp = it.get("speed")
        if ms and sp and sp < ms:
            out.append(_f("warning", "slow_link", node, name, f"링크 속도 {sp}Mb/s", f"기대 최소 {ms}Mb/s — 협상이 낮게 됐다.",
                          "케이블·광모듈 규격과 스위치 포트 속도 설정을 확인한다."))
    # 상위 → 하위 MTU (VLAN 은 부모보다 클 수 없다)
    if kind == "vlan":
        for low in it.get("lowers") or []:
            lm = (by_name.get(low) or {}).get("mtu")
            if lm and it.get("mtu") and it["mtu"] > lm:
                out.append(_f("critical", "mtu_exceeds_parent", node, name, "MTU 가 부모보다 큼",
                              f"{name} {it['mtu']} > {low} {lm} — 큰 패킷이 버려진다."))
    if rates:
        win = rates["window_minutes"]
        if rates["flaps"] >= max(1, int(cfg.get("flap_warn_count") or 0)) and int(cfg.get("flap_warn_count") or 0) > 0:
            out.append(_f("warning", "link_flap", node, name, f"링크 끊김 {rates['flaps']}회",
                          f"최근 {win:g}분 동안 carrier 가 바뀌었다.", "케이블·광모듈·스위치 포트 오류 로그를 확인한다."))
        if rates["bond_link_failures"] > 0:
            out.append(_f("warning", "bond_link_failure", node, name, f"본딩 링크 실패 {rates['bond_link_failures']}회",
                          f"최근 {win:g}분 동안 본딩이 이 하위 인터페이스를 뺐다 넣었다."))
        crc_min = int(cfg.get("crc_warn_count") or 0)
        if crc_min and rates["crc"] >= crc_min:
            out.append(_f("warning", "crc_errors", node, name, f"CRC 오류 {rates['crc']}건 증가",
                          f"최근 {win:g}분.", "케이블·광모듈(SFP) 불량 신호다."))
        thr = float(cfg.get("drop_warn_per_min") or 0)
        if thr and rates["drops_per_min"] >= thr:
            ring = it.get("ring") or {}
            hint = "드라이버·큐(채널) 수·IRQ 분산을 확인한다."
            if ring.get("rx") and ring.get("rx_max") and ring["rx"] < ring["rx_max"]:
                hint = (f"RX ring {ring['rx']} / 최대 {ring['rx_max']} — ring 을 늘리면 버스트 드롭이 줄 수 있다"
                        f"(ethtool -G {name} rx {ring['rx_max']}, 영구 적용은 udev·NetworkManager 설정).")
            out.append(_f("warning", "rx_drops", node, name, f"수신 드롭 분당 {rates['drops_per_min']:g}건",
                          f"최근 {win:g}분 {rates['drops']}건 ({rates['drop_counter']}).", hint))
    # offload 기대 값
    feats = it.get("features") or {}
    for feat, want in (cfg.get("offload_expect") or {}).items():
        cur = feats.get(feat)
        if not cur or cur.get("on") == bool(want):
            continue
        if kind not in ("physical", "bond"):
            continue
        label = FEATURE_LABELS.get(feat, feat)
        out.append(_f("warning", "offload_expect", node, name, f"{label} {'on' if cur.get('on') else 'off'}",
                      f"기대 값 {'on' if want else 'off'}" + (" — 드라이버가 고정한 값이라 바꿀 수 없다." if cur.get("fixed") else "."),
                      "LRO 는 패킷을 합쳐 받아 포워딩(Pod·서비스 트래픽) 때 문제가 된다." if feat == "rx-lro" else ""))
    return out


def _majority(values: dict[str, Any]) -> tuple[Any, list[str]]:
    """값이 갈리면 (다수 값, 다른 값을 가진 노드). 동률이면 다른 쪽을 전부 나열하지 않도록 첫 다수 값 기준."""
    cnt = Counter(v for v in values.values() if v is not None)
    if len(cnt) <= 1:
        return (next(iter(cnt)) if cnt else None), []
    major = cnt.most_common(1)[0][0]
    return major, sorted(n for n, v in values.items() if v is not None and v != major)


def _cross_node(nodes: dict[str, dict[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    names: dict[str, list[str]] = defaultdict(list)
    for node, ifaces in nodes.items():
        for n in ifaces:
            names[n].append(node)
    for iname, present in sorted(names.items()):
        if len(present) < 2:
            continue
        rows = {n: nodes[n][iname] for n in present}

        def check(code: str, title: str, getter, level: str = "warning", hint: str = "") -> None:  # noqa: ANN001
            major, odd = _majority({n: getter(r) for n, r in rows.items()})
            for n in odd:
                out.append(_f(level, code, n, iname, title, f"{getter(rows[n])} — 다른 노드 다수는 {major}.", hint))

        check("cross_mtu", "MTU 가 다른 노드와 다름", lambda r: r.get("mtu"),
              hint="노드 간 MTU 가 다르면 overlay·큰 패킷에서 간헐적인 끊김이 생긴다.")
        check("cross_speed", "링크 속도가 다른 노드와 다름",
              lambda r: r.get("speed") if r.get("kind") == "physical" and r.get("operstate") == "up" else None)
        check("cross_bond_mode", "본딩 모드가 다른 노드와 다름", lambda r: (r.get("bond") or {}).get("mode"))
        check("cross_bond_hash", "해시 정책이 다른 노드와 다름", lambda r: (r.get("bond") or {}).get("xmit_hash_policy"))
        check("cross_lacp_rate", "LACP rate 가 다른 노드와 다름", lambda r: (r.get("bond") or {}).get("lacp_rate")
              if (r.get("bond") or {}).get("mode") == "802.3ad" else None)
        drivers = {(r.get("driver") or {}).get("driver") for r in rows.values()}
        if len(drivers - {None, ""}) == 1:
            for feat in KEY_FEATURES:
                check("cross_offload", f"{FEATURE_LABELS[feat]} 가 다른 노드와 다름",
                      lambda r, f=feat: (("on" if (r.get("features") or {}).get(f, {}).get("on") else "off")
                                         if f in (r.get("features") or {}) else None))
            check("cross_firmware", "펌웨어 버전이 다른 노드와 다름", lambda r: (r.get("driver") or {}).get("firmware") or None,
                  level="info")
    return out


def _worst(levels: list[str]) -> str:
    return max(levels, key=lambda x: LEVEL_ORDER.get(x, 0), default="ok")


def _row(it: dict[str, Any], rates: Optional[dict[str, Any]]) -> dict[str, Any]:
    feats = it.get("features") or {}
    b = it.get("bond") or {}
    return {
        "name": it.get("name"), "kind": it.get("kind"), "operstate": it.get("operstate"), "carrier": it.get("carrier"),
        "speed": it.get("speed"), "duplex": it.get("duplex"), "autoneg": it.get("autoneg"), "mtu": it.get("mtu"),
        "master": it.get("master"), "lowers": it.get("lowers") or [], "vlan_id": it.get("vlan_id"),
        "driver": it.get("driver"), "ring": it.get("ring"),
        "bond": ({"mode": b.get("mode"), "xmit_hash_policy": b.get("xmit_hash_policy"), "lacp_rate": b.get("lacp_rate"),
                  "miimon": b.get("miimon"), "updelay": b.get("updelay"), "downdelay": b.get("downdelay"),
                  "slaves": b.get("slaves") or [], "active": b.get("active") or {},
                  "slave_state": [{"name": k, **v} for k, v in sorted((b.get("slave_state") or {}).items())]}
                 if it.get("kind") == "bond" else None),
        "lacp": it.get("lacp"),
        # 응답 키는 화면 쪽에서 camelCase 로 바뀌므로 이름이 키인 맵(카운터·offload)은 목록으로 보낸다.
        "offload": [{"name": f, "label": FEATURE_LABELS[f], "on": feats[f].get("on")} for f in KEY_FEATURES if f in feats],
        "features": [{"name": k, "label": FEATURE_LABELS.get(k, k), "on": v.get("on"), "fixed": v.get("fixed")}
                     for k, v in sorted(feats.items())],
        "counters": [{"name": k, "value": v} for k, v in sorted((it.get("counters") or {}).items())],
        "rates": rates,
    }


def analyze(states: list[dict[str, Any]], cfg: dict[str, Any], now: datetime) -> dict[str, Any]:
    """states: [{node, host_ip, agent_version, collected_at, received_at, interfaces, errors, history}]"""
    findings: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    nodes_out: list[dict[str, Any]] = []
    by_node: dict[str, dict[str, dict[str, Any]]] = {}
    stale_after = timedelta(minutes=int(cfg.get("stale_minutes") or 10))
    window = int(cfg.get("rate_window_minutes") or 15)
    for st in sorted(states, key=lambda s: s["node"]):
        node = st["node"]
        ifaces = [i for i in (st.get("interfaces") or []) if isinstance(i, dict) and i.get("name")]
        by_name = {i["name"]: i for i in ifaces}
        by_node[node] = by_name
        collected = _parse_ts(st.get("collected_at")) or _parse_ts(st.get("received_at")) or now
        received = _parse_ts(st.get("received_at"))
        # SSH 수집은 사람이 누를 때만 갱신되므로 '보고 끊김' 대상이 아니다
        stale = bool(st.get("source", "agent") == "agent" and received and now - received > stale_after)
        base = pick_baseline(st.get("history") or [], collected, window)
        nf: list[dict[str, Any]] = []
        if stale:
            mins = int((now - received).total_seconds() // 60) if received else 0
            nf.append(_f("warning", "stale", node, None, f"보고 끊김 {mins}분", "에이전트가 보고하지 않아 마지막 값을 보여준다.",
                         "OS 파라미터 감시 화면에서 에이전트 상태를 확인한다."))
        for e in (st.get("errors") or [])[:5]:
            nf.append(_f("info", "agent_error", node, None, "수집 오류", str(e)[:300]))
        for it in ifaces:
            rates = iface_rates(it.get("counters") or {}, base, it["name"], collected)
            f = _iface_findings(node, it, cfg, by_name, rates)
            if it.get("kind") == "bond":
                f += _bond_findings(node, it, cfg, by_name)
            nf += f
            rows.append({"node": node, **_row(it, rates), "findings": f})
        findings += nf
        node_rows = {r["name"]: r for r in rows if r["node"] == node}
        for f in nf:
            for rel in f.get("related") or []:
                if rel in node_rows and rel != f["iface"]:
                    node_rows[rel]["findings"].append(f)
        nodes_out.append({"node": node, "host_ip": st.get("host_ip"), "agent_version": st.get("agent_version"),
                          "source": st.get("source", "agent"),
                          "collected_at": collected.isoformat() if st.get("collected_at") else None,
                          "received_at": received.isoformat() if received else None,
                          "stale": stale, "interface_count": len(ifaces), "rate_ready": base is not None})
    if cfg.get("cross_node_check"):
        cross = _cross_node(by_node)
        findings += cross
        idx = {(r["node"], r["name"]): r for r in rows}
        for f in cross:
            r = idx.get((f["node"], f["iface"]))
            if r is not None:
                r["findings"].append(f)
    for r in rows:
        r["level"] = _worst([f["level"] for f in r["findings"]])
    node_level: dict[str, list[str]] = defaultdict(list)
    for f in findings:
        node_level[f["node"]].append(f["level"])
    for n in nodes_out:
        n["level"] = _worst(node_level.get(n["node"], []))
    findings.sort(key=lambda f: (-LEVEL_ORDER[f["level"]], f["node"], f["iface"] or "", f["code"]))
    counts = Counter(f["level"] for f in findings)
    return {
        "nodes": nodes_out,
        "interfaces": rows,
        "findings": findings,
        "summary": {"critical": counts.get("critical", 0), "warning": counts.get("warning", 0), "info": counts.get("info", 0),
                    "nodes": len(nodes_out), "stale": sum(1 for n in nodes_out if n["stale"]),
                    "level": _worst([f["level"] for f in findings if f["level"] != "info"])},
    }
