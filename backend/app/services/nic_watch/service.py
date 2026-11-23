"""NIC 상태 — 에이전트 보고 저장(``NodeNicState``)과 화면용 조회.

보고는 노드 파라미터 에이전트(1.2.0+)의 ``POST /node-params/agent/report`` 본문 ``nic`` 으로 들어온다.
NIC 저장이 실패해도 커널 파라미터 보고는 성공으로 둔다(라우터가 격리).

대형 클러스터(노드 수백 대) 대응:
- 수신: 인터페이스 상태(카운터 제외)가 그대로이고 마지막 전체 저장 뒤 5분이 안 지났으면 받은 시각만 갱신한다
  (노드마다 매분 JSONB 를 다시 쓰지 않게). 카운터는 최대 5분 늦을 수 있다 — 증가율은 5분 표본으로 계산하므로 영향 없음.
- 조회: 판정 결과를 클러스터별로 잠시(``VIEW_CACHE_SEC``) 캐시하고, 화면에는 필터·페이지를 적용한 가벼운 행만 보낸다.
  행 상세(카운터·offload 전체·본딩 하위·경고)는 펼칠 때 ``interface_detail`` 로 따로 읽는다.
"""
from __future__ import annotations

import fnmatch
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.node_nic import NodeNicState
from app.models.node_param_watch import NodeParamAgent
from app.services.nic_watch import analyze as A
from app.services.nic_watch.settings import get_settings

MIN_AGENT_VERSION = "1.2.0"
HISTORY_SPACING = timedelta(minutes=5)
HISTORY_KEEP = timedelta(minutes=75)   # 창 최대 60분 + 여유
MAX_IFACES = 64
MAX_COUNTERS = 80
VIEW_CACHE_SEC = 20.0
MAX_FINDINGS_OUT = 300
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()
_STR_FIELDS = ("name", "kind", "operstate", "duplex", "master")


def _s(v: Any, n: int = 128) -> Optional[str]:
    return None if v is None else str(v)[:n]


def _i(v: Any) -> Optional[int]:
    try:
        return None if v is None or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


def _clean_counters(raw: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    if isinstance(raw, dict):
        for k, v in list(raw.items())[:MAX_COUNTERS]:
            iv = _i(v)
            if iv is not None and iv >= 0:
                out[str(k)[:64]] = iv
    return out


def _clean_iface(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    name = _s(raw.get("name"), 32)
    if not name:
        return None
    it: dict[str, Any] = {k: _s(raw.get(k), 64) for k in _STR_FIELDS}
    it["name"] = name
    for k in ("carrier", "mtu", "speed", "vlan_id"):
        it[k] = _i(raw.get(k))
    it["autoneg"] = raw.get("autoneg") if isinstance(raw.get("autoneg"), bool) else None
    it["lowers"] = [str(x)[:32] for x in (raw.get("lowers") or [])[:16]] if isinstance(raw.get("lowers"), list) else []
    ring = raw.get("ring")
    it["ring"] = {k: _i(ring.get(k)) for k in ("rx", "rx_max", "tx", "tx_max")} if isinstance(ring, dict) else None
    if "channels" in raw:  # 채널 수를 보고하지 않는 출처(에이전트 1.2.x)는 키 자체가 없다 — 스냅샷이 이전 값을 유지하게
        ch = raw.get("channels")
        it["channels"] = ({k: _i(ch.get(k)) for k in ("combined", "combined_max", "rx", "rx_max", "tx", "tx_max")}
                          if isinstance(ch, dict) else None)
    drv = raw.get("driver")
    it["driver"] = {k: _s(drv.get(k), 64) for k in ("driver", "version", "firmware", "bus")} if isinstance(drv, dict) else None
    feats = raw.get("features")
    it["features"] = ({str(k)[:64]: {"on": bool((v or {}).get("on")), "fixed": bool((v or {}).get("fixed"))}
                       for k, v in list(feats.items())[:40] if isinstance(v, dict)} if isinstance(feats, dict) else None)
    it["counters"] = _clean_counters(raw.get("counters"))
    lacp = raw.get("lacp")
    it["lacp"] = _clean_slave_state(lacp) if isinstance(lacp, dict) else None
    bond = raw.get("bond")
    if isinstance(bond, dict):
        active = bond.get("active") if isinstance(bond.get("active"), dict) else {}
        ss = bond.get("slave_state") if isinstance(bond.get("slave_state"), dict) else {}
        it["bond"] = {
            "mode": _s(bond.get("mode"), 32), "xmit_hash_policy": _s(bond.get("xmit_hash_policy"), 32),
            "lacp_rate": _s(bond.get("lacp_rate"), 16),
            **{k: _i(bond.get(k)) for k in ("miimon", "arp_interval", "updelay", "downdelay")},
            "slaves": [str(x)[:32] for x in (bond.get("slaves") or [])[:16]] if isinstance(bond.get("slaves"), list) else [],
            "active": {"aggregator_id": _i(active.get("aggregator_id")), "ports": _i(active.get("ports")),
                       "actor_key": _i(active.get("actor_key")), "partner_key": _i(active.get("partner_key")),
                       "partner_mac": _s(active.get("partner_mac"), 32)},
            "slave_state": {str(k)[:32]: _clean_slave_state(v) for k, v in list(ss.items())[:16] if isinstance(v, dict)},
        }
    return it


def _clean_slave_state(v: dict[str, Any]) -> dict[str, Any]:
    return {"mii_status": _s(v.get("mii_status"), 16), "speed": _i(v.get("speed")), "duplex": _s(v.get("duplex"), 16),
            "link_failures": _i(v.get("link_failures")), "aggregator_id": _i(v.get("aggregator_id")),
            "partner_mac": _s(v.get("partner_mac"), 32), "partner_key": _i(v.get("partner_key"))}


def _parse_dt(v: Any) -> Optional[datetime]:
    return A._parse_ts(v)  # noqa: SLF001 — 같은 패키지의 시각 해석을 그대로 쓴다


def ingest(db: Session, cluster: Cluster, node: str, host_ip: Optional[str], agent_version: Optional[str],
           collected_at: Any, report: Any, now: Optional[datetime] = None, source: str = "agent") -> int:
    """NIC 보고 1건 저장 — 저장한 인터페이스 수. ``report`` 가 없거나 형식이 틀리면 0(아무것도 바꾸지 않음).

    ``source`` = agent(에이전트 보고) | ssh(서비스 구성 ▸ NIC 현재 값 수집). 전체 저장 때마다 서비스 구성
    ``nic:{node}`` 스냅샷도 맞춘다(설정 값이 같으면 저장 안 함)."""
    if not isinstance(report, dict):
        return 0
    now = now or datetime.utcnow()
    raw_ifaces = report.get("interfaces") if isinstance(report.get("interfaces"), list) else []
    ifaces = [c for c in (_clean_iface(r) for r in raw_ifaces[:MAX_IFACES] if isinstance(r, dict)) if c]
    errors = [str(e)[:300] for e in (report.get("errors") or [])[:20]] if isinstance(report.get("errors"), list) else []
    collected = _parse_dt(collected_at) or now
    if collected > now + timedelta(minutes=5):  # 노드 시계가 크게 앞서면 받은 시각을 쓴다
        collected = now
    row = db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id, NodeNicState.node == node).first()
    if row is None:
        row = NodeNicState(cluster_id=cluster.id, node=node, history=[])
        db.add(row)
    elif (source == "agent" and row.source in (None, "agent") and row.collected_at is not None
          and row.collected_at <= collected < row.collected_at + HISTORY_SPACING
          and _state_of(row.interfaces) == _state_of(ifaces)):
        # 상태가 그대로면 받은 시각·오류만 — 카운터는 다음 전체 저장(5분) 때
        row.host_ip = (host_ip or row.host_ip or None)
        row.agent_version = agent_version
        row.received_at = now
        if (row.errors or []) != errors:
            row.errors = errors
        db.commit()
        return len(ifaces)
    history = [h for h in (row.history or []) if isinstance(h, dict)]
    last_t = _parse_dt(history[-1].get("t")) if history else None
    if last_t is None or collected - last_t >= HISTORY_SPACING or collected < last_t:
        if last_t is not None and collected < last_t:
            history = []  # 시계가 뒤로 갔다 — 표본을 다시 모은다
        history.append({"t": collected.isoformat(), "c": {i["name"]: i["counters"] for i in ifaces}})
        history = [h for h in history if (t := _parse_dt(h.get("t"))) and collected - t <= HISTORY_KEEP]
    row.host_ip = (host_ip or row.host_ip or None)
    row.agent_version = agent_version
    row.source = source
    row.collected_at = collected
    row.received_at = now
    row.interfaces = ifaces
    row.errors = errors
    row.history = history
    db.commit()
    from app.services.nic_watch import snapshot as SN

    SN.store(db, cluster, node, ifaces, source, now)
    return len(ifaces)


def _state_of(ifaces: Any) -> list[Any]:
    """카운터를 뺀 인터페이스 상태 — 전체 저장이 필요한지 비교용."""
    return [{k: v for k, v in i.items() if k != "counters"} for i in (ifaces or []) if isinstance(i, dict)]


def _ver_tuple(v: Optional[str]) -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in str(v or "0").split(".")[:3])
    except ValueError:
        return (0,)


def effective_settings(db: Session, cluster: Cluster) -> dict[str, Any]:
    """판정 기준 = 설정 값. 서비스 구성 nic 의 기본 그룹 최신 버전이 있으면 그 값(해시 정책·LACP rate·offload)이 우선이다 —
    두 곳이 어긋나 같은 노드에 반대 경고가 뜨지 않게. 노드 그룹 재정의는 드리프트(서비스 구성)가 본다."""
    cfg = get_settings(db)
    try:
        from app.services.service_config import view as V

        vals = V._default_latest_values(db, cluster.id, "nic")  # noqa: SLF001 — 같은 앱의 조회 함수
    except Exception:  # noqa: BLE001
        db.rollback()
        vals = {}
    if not vals:
        return cfg
    out = {**cfg, "offload_expect": dict(cfg["offload_expect"]), "version_driven": True}
    if vals.get("bond.xmit_hash_policy"):
        out["expected_hash_policy"] = str(vals["bond.xmit_hash_policy"])
    if vals.get("bond.lacp_rate"):
        out["expected_lacp_rate"] = str(vals["bond.lacp_rate"])
    for k, v in vals.items():
        if str(k).startswith("offload.") and str(v) in ("on", "off"):
            out["offload_expect"][str(k)[len("offload."):]] = str(v) == "on"
    return out


def _analysis(db: Session, cluster: Cluster, now: Optional[datetime] = None) -> dict[str, Any]:
    """판정 전체(모든 노드·인터페이스). ``now`` 를 주지 않으면 클러스터별로 잠시 캐시한다(설정이 바뀌면 무효)."""
    cfg = effective_settings(db, cluster)
    key = str(cluster.id)
    if now is None:
        with _cache_lock:
            hit = _cache.get(key)
        if hit and hit[0] > time.monotonic() and hit[1]["settings"] == cfg:
            return hit[1]
    at = now or datetime.utcnow()
    rows = db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).all()
    states = [{"node": r.node, "host_ip": r.host_ip, "agent_version": r.agent_version, "source": r.source or "agent",
               "collected_at": r.collected_at,
               "received_at": r.received_at, "interfaces": r.interfaces or [], "errors": r.errors or [],
               "history": r.history or []} for r in rows]
    out = A.analyze(states, cfg, at)
    reported = {r.node for r in rows}
    agents = db.query(NodeParamAgent).filter(NodeParamAgent.cluster_id == cluster.id).all()
    out["pending_agents"] = sorted(
        ({"node": a.node, "agent_version": a.agent_version,
          "reason": (f"에이전트 {a.agent_version or '?'} — NIC 상태는 {MIN_AGENT_VERSION} 이상이 보고한다(DaemonSet 재배포)"
                     if _ver_tuple(a.agent_version) < _ver_tuple(MIN_AGENT_VERSION)
                     else ("NIC 수집이 꺼져 있다(설정)" if not cfg["enabled"] else "다음 보고를 기다리는 중"))}
         for a in agents if a.node not in reported), key=lambda x: x["node"])
    out["agent_count"] = len(agents)
    out["settings"] = cfg
    if now is None:
        with _cache_lock:
            _cache[key] = (time.monotonic() + VIEW_CACHE_SEC, out)
    return out


def invalidate(cluster_id: Any = None) -> None:
    with _cache_lock:
        if cluster_id is None:
            _cache.clear()
        else:
            _cache.pop(str(cluster_id), None)


_DETAIL_ONLY = ("counters", "features", "findings")


def _slim(row: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in row.items() if k not in _DETAIL_ONLY}
    if isinstance(out.get("bond"), dict):
        out["bond"] = {k: v for k, v in out["bond"].items() if k != "slave_state"}
    out["finding_count"] = sum(1 for f in row.get("findings") or [] if f.get("level") in ("critical", "warning"))
    return out


def cluster_view(db: Session, cluster: Cluster, now: Optional[datetime] = None, *, q: str = "", kind: str = "",
                 only_flagged: bool = False, offset: int = 0, limit: int = 100) -> dict[str, Any]:
    """화면용 — 요약·노드·경고(앞 ``MAX_FINDINGS_OUT`` 건) + 필터·페이지를 적용한 가벼운 인터페이스 행.

    ``q`` 는 노드·인터페이스 이름 부분 일치 또는 glob(``*``·``?`` 가 있으면). ``limit`` 0 = 요약만(레일 상태 점용)."""
    full = _analysis(db, cluster, now)
    rows = full["interfaces"]
    needle = (q or "").strip().lower()
    if needle:
        if any(ch in needle for ch in "*?["):
            rows = [r for r in rows if fnmatch.fnmatchcase(r["node"].lower(), needle) or fnmatch.fnmatchcase(r["name"].lower(), needle)]
        else:
            rows = [r for r in rows if needle in r["node"].lower() or needle in r["name"].lower()]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    if only_flagged:
        rows = [r for r in rows if r.get("level") in ("critical", "warning")]
    offset = max(0, int(offset))
    limit = max(0, min(int(limit), 500))
    findings = full["findings"]
    received = [n["received_at"] for n in full["nodes"] if n.get("received_at")]
    return {
        # 노드 목록(수백 행)은 보내지 않는다 — 보고 끊김은 경고로, 마지막 보고 시각은 요약으로.
        "summary": {**full["summary"], "latest_received_at": max(received) if received else None},
        "findings": findings[:MAX_FINDINGS_OUT if limit else 5],
        "findings_total": len(findings),
        "interfaces": [_slim(r) for r in rows[offset:offset + limit]],
        "interfaces_total": len(rows),
        "offset": offset,
        "limit": limit,
        "pending_agents": full["pending_agents"],
        "agent_count": full["agent_count"],
        "settings": full["settings"],
    }


def interface_detail(db: Session, cluster: Cluster, node: str, iface: str,
                     now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    """행 하나의 전체(카운터·offload 전체·본딩 하위 상태·경고)."""
    for r in _analysis(db, cluster, now)["interfaces"]:
        if r["node"] == node and r["name"] == iface:
            return r
    return None


def remove_node(db: Session, cluster_id: Any, node: str) -> None:
    db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster_id, NodeNicState.node == node).delete()
    db.commit()
    invalidate(cluster_id)
