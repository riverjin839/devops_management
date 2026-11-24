"""NIC 상태 — 에이전트 보고 저장(``NodeNicState``)과 화면용 조회.

보고는 노드 파라미터 에이전트(1.2.0+)의 ``POST /node-params/agent/report`` 본문 ``nic`` 으로 들어온다.
NIC 저장이 실패해도 커널 파라미터 보고는 성공으로 둔다(라우터가 격리).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.node_nic import NodeNicState
from app.models.node_param_watch import NodeParamAgent
from app.services.nic_watch import analyze as A
from app.services.nic_watch.settings import get_cluster_settings

MIN_AGENT_VERSION = "1.2.0"
HISTORY_SPACING = timedelta(minutes=5)
HISTORY_KEEP = timedelta(minutes=75)   # 창 최대 60분 + 여유
MAX_IFACES = 64
MAX_COUNTERS = 80
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
           collected_at: Any, report: Any, now: Optional[datetime] = None) -> int:
    """NIC 보고 1건 저장 — 저장한 인터페이스 수. ``report`` 가 없거나 형식이 틀리면 0(아무것도 바꾸지 않음)."""
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
    history = [h for h in (row.history or []) if isinstance(h, dict)]
    last_t = _parse_dt(history[-1].get("t")) if history else None
    if last_t is None or collected - last_t >= HISTORY_SPACING or collected < last_t:
        if last_t is not None and collected < last_t:
            history = []  # 시계가 뒤로 갔다 — 표본을 다시 모은다
        history.append({"t": collected.isoformat(), "c": {i["name"]: i["counters"] for i in ifaces}})
        history = [h for h in history if (t := _parse_dt(h.get("t"))) and collected - t <= HISTORY_KEEP]
    row.host_ip = (host_ip or row.host_ip or None)
    row.agent_version = agent_version
    row.collected_at = collected
    row.received_at = now
    row.interfaces = ifaces
    row.errors = errors
    row.history = history
    db.commit()
    return len(ifaces)


def _ver_tuple(v: Optional[str]) -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in str(v or "0").split(".")[:3])
    except ValueError:
        return (0,)


def cluster_view(db: Session, cluster: Cluster, now: Optional[datetime] = None) -> dict[str, Any]:
    """화면용 — 노드·인터페이스·경고·요약 + NIC 를 아직 보고하지 않는 에이전트(구버전·수집 꺼짐)."""
    now = now or datetime.utcnow()
    cs = get_cluster_settings(db, cluster.id)  # 공통 기준 + 이 클러스터 재정의
    cfg = cs["effective"]
    rows = db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster.id).all()
    states = [{"node": r.node, "host_ip": r.host_ip, "agent_version": r.agent_version, "collected_at": r.collected_at,
               "received_at": r.received_at, "interfaces": r.interfaces or [], "errors": r.errors or [],
               "history": r.history or []} for r in rows]
    out = A.analyze(states, cfg, now)
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
    out["overridden"] = cs["overridden"]  # 이 클러스터가 공통과 다르게 정한 항목
    return out


def remove_node(db: Session, cluster_id: Any, node: str) -> None:
    db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster_id, NodeNicState.node == node).delete()
    db.commit()
