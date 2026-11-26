"""에이전트 보고 처리 + 화면 조회 모델.

보고 1건 = 노드 1개의 맵·프로그램 요약. 여기서:
1. ``cilium_bpf_agents`` 행을 갱신(upsert)하고 프로그램 비교 기준(baseline)을 처음 한 번 잡는다.
2. 맵마다 사용률을 임계치(설정)로 판정해 ``CiliumBpfMapPressure`` 알람을 열고/닫는다
   — 알람 인박스 경로(``alert_router.route_and_notify``)를 그대로 써서 알림 규칙·중복 억제가 적용된다.
3. 수동 실행(``run_id``)이면 그 노드를 완료로 표시한다(``runs.mark_done``).

에이전트가 보낸 값은 신뢰하지 않는다 — 길이·개수·타입을 잘라 저장한다(화면은 이 행만 읽는다).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.alert_event import AlertEvent
from app.models.cilium_datapath import CiliumBpfAgent
from app.models.cluster import Cluster
from app.services.cilium_datapath import catalog
from app.services.cilium_datapath.settings import agent_config, get_settings

logger = logging.getLogger(__name__)

ALERT_SOURCE = "cilium-bpf-agent"
ALERT_PRESSURE = "CiliumBpfMapPressure"

MAX_MAPS = 400
MAX_PROGRAMS = 300
MAX_ERRORS = 50


# ── 입력 정리 ────────────────────────────────────────────────────────────────

def _s(v: Any, n: int) -> str:
    return str(v if v is not None else "")[:n]


def _int(v: Any, lo: int = 0, hi: int = 2**53) -> Optional[int]:
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return i if lo <= i <= hi else None


def clean_maps(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in raw if isinstance(raw, list) else []:
        if not isinstance(m, dict) or not m.get("name"):
            continue
        name = _s(m.get("name"), 128)
        out.append({
            "name": name,
            "group": _s(m.get("group") or name, 128),
            "map_type": _s(m.get("map_type"), 32),
            "max_entries": _int(m.get("max_entries")) or 0,
            "entries": _int(m.get("entries")),
            "partial": bool(m.get("partial")),
            "members": _int(m.get("members"), 1) or 1,
            "elapsed_ms": _int(m.get("elapsed_ms")) or 0,
            "pinned": bool(m.get("pinned", True)),
            "key_size": _int(m.get("key_size")) or 0,
            "value_size": _int(m.get("value_size")) or 0,
            "error": _s(m.get("error"), 300) or None,
        })
        if len(out) >= MAX_MAPS:
            break
    return out


def clean_programs(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in raw if isinstance(raw, list) else []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        tags = [_s(t, 16) for t in (p.get("tags") or []) if t][:8]
        out.append({
            "name": _s(p.get("name"), 64),
            "prog_type": _s(p.get("prog_type"), 32),
            "count": _int(p.get("count"), 0) or 0,
            "tags": sorted(tags),
            "loaded_at": _s(p.get("loaded_at"), 40) or None,
            "run_time_ns": _int(p.get("run_time_ns")),
            "run_cnt": _int(p.get("run_cnt")),
        })
        if len(out) >= MAX_PROGRAMS:
            break
    return out


_FEATURE_BOOLS = ("cap_bpf", "cap_sys_admin", "cap_perfmon", "kernel_cap_bpf", "kernel_batch_ops",
                  "kernel_drop_reason", "btf", "bpf_stats_enabled")


def clean_features(raw: Any) -> dict[str, Any]:
    f = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {k: bool(f.get(k)) for k in _FEATURE_BOOLS}
    out["kernel"] = _s(f.get("kernel"), 64)
    out["pin_dirs_found"] = [_s(d, 200) for d in (f.get("pin_dirs_found") or [])][:20]
    return out


# ── 판정 ─────────────────────────────────────────────────────────────────────

def map_level(m: dict[str, Any], cfg: dict[str, Any]) -> tuple[Optional[float], str]:
    """(사용률 %, 판정) — 판정: critical | warning | ok | unknown(세지 못함)."""
    entries, mx = m.get("entries"), m.get("max_entries") or 0
    if entries is None or mx <= 0:
        return None, "unknown"
    pct = round(entries * 100.0 / mx, 1)
    if pct >= cfg["crit_pct"]:
        return pct, "critical"
    if pct >= cfg["warn_pct"]:
        return pct, "warning"
    return pct, "ok"


def enrich_map(m: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    pct, level = map_level(m, cfg)
    meta = catalog.describe(m["group"])
    rec = catalog.recommendation(meta["config_key"], m.get("max_entries") or 0) if level in ("warning", "critical") else None
    return {**m, "pct": pct, "level": level, "label": meta["label"], "order": meta["order"],
            "config_key": meta["config_key"], "note": meta["note"], "recommendation": rec}


# ── 알람 ─────────────────────────────────────────────────────────────────────

def _fingerprint(cluster_id: UUID, node: str, group: str) -> str:
    from app.services.observability.alert_ingest import compute_fingerprint

    return compute_fingerprint(ALERT_PRESSURE, {"cluster": str(cluster_id), "node": node, "key": group})


def _route(db: Session, cluster: Cluster, *, fingerprint: str, node: str, severity: str, summary: str,
           description: str, labels: dict[str, Any], status: str = "firing") -> None:
    from app.services.observability.alert_ingest import ParsedAlert
    from app.services.observability.alert_router import route_and_notify

    alert = ParsedAlert(
        alertname=ALERT_PRESSURE, fingerprint=fingerprint, status=status, severity=severity,
        summary=summary[:500], description=description, resource=node, cluster_hint=cluster.name,
        labels={"cluster": cluster.name, "node": node, "source": ALERT_SOURCE, **labels},
        annotations={}, raw={}, source=ALERT_SOURCE,
    )
    route_and_notify(db, alert, cluster.id)


def _open_alerts(db: Session, cluster_id: UUID, node: str) -> list[AlertEvent]:
    return (db.query(AlertEvent)
            .filter(AlertEvent.source == ALERT_SOURCE, AlertEvent.cluster_id == cluster_id,
                    AlertEvent.resource == node, AlertEvent.status == "firing",
                    AlertEvent.alertname == ALERT_PRESSURE)
            .all())


def sync_alerts(db: Session, cluster: Cluster, node: str, maps: list[dict[str, Any]],
                cfg: dict[str, Any]) -> tuple[int, int]:
    """임계치를 넘은 맵마다 알람 1건(노드·그룹 단위) — 이미 열려 있으면 그대로, 등급이 바뀌면 갱신, 내려가면 닫는다."""
    desired: dict[str, dict[str, Any]] = {}
    if cfg["alerts_enabled"]:
        for m in maps:
            if m["level"] not in ("warning", "critical"):
                continue
            fp = _fingerprint(cluster.id, node, m["group"])
            bound = "하한" if m.get("partial") else ""
            desired[fp] = {
                "severity": m["level"],
                "summary": f"{node} BPF 맵 {m['label']} 사용률 {m['pct']}%{(' (' + bound + ')') if bound else ''}",
                "description": (
                    f"노드 {node} 의 {m['name']} ({m['map_type']}) 항목 {m['entries']:,} / 최대 {m['max_entries']:,}"
                    f" — 판정 기준 주의 {cfg['warn_pct']}% · 위험 {cfg['crit_pct']}%."
                    + (f" {m['note']}" if m.get("note") else "")
                    + (f" 검토: {m['recommendation']}" if m.get("recommendation") else "")
                ),
                "labels": {"map": m["name"], "group": m["group"], "pct": str(m["pct"])},
            }
    opened = resolved = 0
    open_events = {e.fingerprint: e for e in _open_alerts(db, cluster.id, node)}
    for fp, a in desired.items():
        ev = open_events.get(fp)
        if ev is not None and ev.severity == a["severity"]:
            continue
        _route(db, cluster, fingerprint=fp, node=node, **a)
        if ev is None:
            opened += 1
    # 닫는 건 회복을 **관측했을 때만** — 그 맵 그룹을 이번 보고에서 끝까지 세었고 임계치 아래일 때.
    # 고정 경로를 못 읽었거나(그룹 누락) 세지 못했거나(unknown) 시간 예산 초과(partial, 하한)면 열린 알람을 그대로 둔다.
    # 알람을 끈 경우는 운영자 선택이라 모두 닫는다.
    recovered = {m["group"] for m in maps if m["level"] == "ok" and not m.get("partial")}
    for fp, ev in open_events.items():
        group = (ev.labels or {}).get("group")
        if fp not in desired and (not cfg["alerts_enabled"] or group in recovered):
            _route(db, cluster, fingerprint=fp, node=node, severity=ev.severity, summary=ev.summary or ALERT_PRESSURE,
                   description=ev.description or "", labels=dict(ev.labels or {}), status="resolved")
            resolved += 1
    return opened, resolved


# ── 보고 ─────────────────────────────────────────────────────────────────────

def handle_report(db: Session, cluster: Cluster, report: dict[str, Any]) -> dict[str, Any]:
    cfg = get_settings(db)
    node = _s(report.get("node"), 253).strip()
    if not node:
        raise ValueError("node 가 비어 있습니다.")
    now = datetime.utcnow()
    agent = (db.query(CiliumBpfAgent)
             .filter(CiliumBpfAgent.cluster_id == cluster.id, CiliumBpfAgent.node == node).first())
    if agent is None:
        agent = CiliumBpfAgent(cluster_id=cluster.id, node=node)
        db.add(agent)
    maps = clean_maps(report.get("maps"))
    programs = clean_programs(report.get("programs"))
    agent.host_ip = _s(report.get("host_ip"), 64) or None
    agent.agent_version = _s(report.get("agent_version"), 32) or None
    agent.last_seen_at = now
    agent.collected_at = _s(report.get("collected_at"), 40) or None
    agent.collect_ms = _int(report.get("collect_ms"))
    agent.features = clean_features(report.get("features"))
    agent.maps = maps
    agent.maps_skipped = _int(report.get("maps_skipped")) or 0
    agent.programs = programs
    agent.programs_other = _int(report.get("programs_other")) or 0
    agent.programs_error = _s(report.get("programs_error"), 500) or None
    agent.errors = [_s(e, 300) for e in (report.get("errors") or [])][:MAX_ERRORS]
    if agent.programs_baseline is None and programs:
        agent.programs_baseline = programs
        agent.baseline_at = now
    db.commit()

    enriched = [enrich_map(m, cfg) for m in maps]
    try:
        opened, resolved = sync_alerts(db, cluster, node, enriched, cfg)
        db.commit()  # route_and_notify 는 커밋을 호출자에게 맡긴다 — 주기 보고(run_id 없음)도 여기서 확정한다.
    except Exception as exc:  # noqa: BLE001 — 알람 실패가 보고 저장을 되돌리지 않게
        db.rollback()
        logger.warning("cilium bpf 알람 동기화 실패 (%s/%s): %s", cluster.name, node, exc)
        opened = resolved = 0

    run_id = report.get("run_id")
    if run_id:
        from app.services.cilium_datapath import runs

        crit = sum(1 for m in enriched if m["level"] == "critical")
        warn = sum(1 for m in enriched if m["level"] == "warning")
        runs.mark_done(db, str(run_id), cluster.id, node, {
            "maps": len(maps), "critical": crit, "warning": warn, "collect_ms": agent.collect_ms,
            "errors": len(agent.errors),
        })

    return {"ok": True, "node": node, "config": agent_config(cfg), "alerts_opened": opened, "alerts_resolved": resolved}


# ── 화면 ─────────────────────────────────────────────────────────────────────

def agent_state(agent: CiliumBpfAgent, cfg: dict[str, Any], now: Optional[datetime] = None) -> str:
    now = now or datetime.utcnow()
    if agent.last_seen_at is None:
        return "never"
    if now - agent.last_seen_at > timedelta(minutes=cfg["offline_minutes"]):
        return "offline"
    return "reporting"


def program_diff(current: list[dict[str, Any]], baseline: Optional[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """이름별 비교 — same | changed(tag 다름) | new | removed. 기준이 없으면 전부 same."""
    if baseline is None:
        return [{**p, "diff": "same"} for p in current]
    base = {p["name"]: p for p in baseline}
    out = []
    for p in current:
        b = base.get(p["name"])
        diff = "new" if b is None else ("same" if sorted(b.get("tags") or []) == sorted(p.get("tags") or []) else "changed")
        out.append({**p, "diff": diff})
    names = {p["name"] for p in current}
    for b in baseline:
        if b["name"] not in names:
            out.append({**b, "count": 0, "diff": "removed"})
    return out


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() + "Z" if dt else None


def cluster_view(db: Session, cluster: Cluster) -> dict[str, Any]:
    cfg = get_settings(db)
    now = datetime.utcnow()
    agents = (db.query(CiliumBpfAgent).filter(CiliumBpfAgent.cluster_id == cluster.id)
              .order_by(CiliumBpfAgent.node.asc()).all())
    columns: dict[str, dict[str, Any]] = {}
    out_agents = []
    counts = {"critical": 0, "warning": 0}
    for a in agents:
        maps = [enrich_map(m, cfg) for m in (a.maps or [])]
        for m in maps:
            columns.setdefault(m["group"], {"group": m["group"], "label": m["label"], "order": m["order"],
                                            "config_key": m["config_key"], "known": m["order"] < 1000})
            if m["level"] in counts:
                counts[m["level"]] += 1
        out_agents.append({
            "id": str(a.id),
            "node": a.node,
            "host_ip": a.host_ip,
            "agent_version": a.agent_version,
            "state": agent_state(a, cfg, now),
            "last_seen_at": _iso(a.last_seen_at),
            "collected_at": a.collected_at,
            "collect_ms": a.collect_ms,
            "features": a.features or {},
            "maps": maps,
            "maps_skipped": a.maps_skipped,
            "programs": program_diff(a.programs or [], a.programs_baseline),
            "programs_other": a.programs_other,
            "programs_error": a.programs_error,
            "baseline_at": _iso(a.baseline_at),
            "errors": a.errors or [],
        })
    cols = sorted(columns.values(), key=lambda c: (c["order"], c["group"]))
    return {
        "cluster_id": str(cluster.id),
        "settings": {k: cfg[k] for k in ("warn_pct", "crit_pct", "interval_sec", "sys_admin", "alerts_enabled",
                                          "map_budget_ms", "total_budget_ms", "offline_minutes")},
        "columns": [{k: c[k] for k in ("group", "label", "config_key", "known")} for c in cols],
        "agents": out_agents,
        "summary": {
            "agents": len(agents),
            "reporting": sum(1 for a in out_agents if a["state"] == "reporting"),
            **counts,
        },
    }


def set_baseline(db: Session, agent: CiliumBpfAgent) -> None:
    agent.programs_baseline = list(agent.programs or [])
    agent.baseline_at = datetime.utcnow()
    db.commit()


def remove_agent(db: Session, cluster: Cluster, agent: CiliumBpfAgent) -> None:
    """없앤 노드의 에이전트를 목록에서 지운다 — 열린 사용률 알람은 닫는다."""
    for ev in _open_alerts(db, cluster.id, agent.node):
        _route(db, cluster, fingerprint=ev.fingerprint, node=agent.node, severity=ev.severity,
               summary=ev.summary or ALERT_PRESSURE, description=ev.description or "",
               labels=dict(ev.labels or {}), status="resolved")
    db.delete(agent)
    db.commit()
