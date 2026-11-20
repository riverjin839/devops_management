"""서비스 구성 — 서비스 상태(드리프트·열린 알람·최근 변경·미적용·최근 적용).

서비스 화면 안에서 "지금 노드가 관리 값과 맞는가, 무엇이 언제 바뀌었나, 무엇을 눌러 되돌리나" 를 바로 보게 한다.

- **드리프트**: 노드 현재 값이 마지막 **기준 버전**(가져옴·적용됨)과 다른 것. 미적용 저장본은 드리프트가 아니다(따로 ``pending``).
  그룹 범위의 기준 = 기본 그룹 기준 버전 + 그 그룹의 마지막 적용 버전 재정의.
- **알람·최근 변경**(LINUX): 노드 파라미터 에이전트가 만든 알람(``AlertEvent`` source ``node-param-agent``)과
  ``OsParamChange``. 조회 실패는 fail-safe 로 빈 목록 + ``errors``.
- **수준**: critical 알람 → critical / 드리프트·warning 알람·마지막 적용 실패/일부·에이전트 무응답 → warning / 그 외 ok.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.service_config import ServiceConfigApplyRun, ServiceConfigVersion
from app.services.service_config import current as C
from app.services.service_config import view as V
from app.services.service_config.catalog_seed import SERVICE_KEYS

AGENT_SOURCE = "node-param-agent"
ALERT_OFFLINE = "NodeParamAgentOffline"
CHANGE_WINDOW = timedelta(hours=24)
_LEVEL_RANK = {"ok": 0, "warning": 1, "critical": 2}


def _baseline(versions: list[ServiceConfigVersion]) -> Optional[ServiceConfigVersion]:
    return next((v for v in versions if v.status in V.BASELINE_STATUSES), None)


def _applied(versions: list[ServiceConfigVersion]) -> Optional[ServiceConfigVersion]:
    return next((v for v in versions if v.status == "applied"), None)


def drift_rows(values: dict[str, dict[str, str]], scopes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """순수 계산 — ``values``: {key: {node: 현재 값}}, ``scopes``: [{group_id, group_name, nodes, expected: {key: 값}}]."""
    rows: list[dict[str, Any]] = []
    for sc in scopes:
        nodes = set(sc["nodes"])
        for key, exp in sorted(sc["expected"].items()):
            want = C.norm(exp)
            if want in (None, ""):
                continue
            for node, cur in sorted((values.get(key) or {}).items()):
                if node in nodes and C.norm(cur) != want:
                    rows.append({"key": key, "node": node, "current": cur, "expected": want,
                                 "group_id": sc["group_id"], "group_name": sc["group_name"],
                                 "baseline_version_no": sc["baseline_version_no"]})
    return rows


def drift(db: Session, cluster: Cluster, service: str) -> dict[str, Any]:
    items = V.load_items(db, service)
    cur = C.current_values(service, V.latest_snapshots(db, cluster.id, service), items)
    all_nodes = sorted({s["node"] for s in cur["sources"]})
    groups = V.list_groups(db, cluster.id, service) if service not in V.GROUPLESS_SERVICES else []
    membership = V.node_group_map(all_nodes, groups)
    default_versions = V.list_versions(db, cluster.id, service)
    base = _baseline(default_versions)
    scopes: list[dict[str, Any]] = []
    if base is not None:
        scopes.append({"group_id": None, "group_name": "기본", "baseline_version_no": base.version_no,
                       "nodes": [n for n in all_nodes if membership.get(n) is None],
                       "expected": dict(base.values or {})})
        for g in groups:
            gv = _applied(V.list_versions(db, cluster.id, service, g.id))
            scopes.append({"group_id": str(g.id), "group_name": g.name,
                           "baseline_version_no": gv.version_no if gv else base.version_no,
                           "nodes": [n for n in all_nodes if membership.get(n) == str(g.id)],
                           "expected": {**(base.values or {}), **((gv.values or {}) if gv else {})}})
    keys = {it.key for it in items}
    for sc in scopes:
        sc["expected"] = {k: v for k, v in sc["expected"].items() if k in keys}
    rows = drift_rows(cur["values"], scopes)
    collected = [s["collected_at"] for s in cur["sources"] if s.get("collected_at")]
    return {
        "baseline_version_no": base.version_no if base else None,
        "baseline_status": base.status if base else None,
        "nodes": sorted({r["node"] for r in rows}),
        "keys": sorted({r["key"] for r in rows}),
        "rows": rows,
        "by_group": {str(sc["group_id"] or ""): sorted({r["node"] for r in rows if r["group_id"] == sc["group_id"]})
                     for sc in scopes},
        "node_count": len(all_nodes),
        "last_collected_at": max(collected) if collected else None,
    }


def _alert_keys(ev: Any) -> list[str]:
    labels = ev.labels or {}
    if labels.get("param"):
        return [str(labels["param"])]
    return [p for p in str(labels.get("params") or "").split(",") if p]


def linux_signals(db: Session, cluster: Cluster, now: Optional[datetime] = None) -> dict[str, Any]:
    """에이전트 알람(확인 안 된 firing)과 최근 24시간 변경 — 키별 배지와 요약 목록."""
    from app.models.alert_event import AlertEvent
    from app.models.os_param_change import OsParamChange

    now = now or datetime.utcnow()
    errors: list[str] = []
    alerts: list[dict[str, Any]] = []
    key_signals: dict[str, dict[str, Any]] = {}
    offline: list[str] = []
    try:
        evs = (db.query(AlertEvent)
               .filter(AlertEvent.cluster_id == cluster.id, AlertEvent.source == AGENT_SOURCE,
                       AlertEvent.status == "firing", AlertEvent.acked.is_(False))
               .order_by(AlertEvent.starts_at.desc().nullslast()).limit(500).all())
        for ev in evs:
            keys = _alert_keys(ev)
            if ev.alertname == ALERT_OFFLINE:
                offline.append(ev.resource or "")
            alerts.append({"id": str(ev.id), "alertname": ev.alertname, "severity": ev.severity, "node": ev.resource,
                           "keys": keys, "summary": ev.summary,
                           "starts_at": ev.starts_at.isoformat() if ev.starts_at else None})
            sev = ev.severity if ev.severity in ("critical", "warning") else "warning"
            for k in keys:
                sig = key_signals.setdefault(k, {"alerts": {"critical": 0, "warning": 0}, "last_change": None})
                sig["alerts"][sev] += 1
    except Exception as exc:  # noqa: BLE001 — 알람 조회 실패가 화면을 막지 않게
        db.rollback()
        errors.append(f"알람 조회 실패: {str(exc)[:160]}")
    changes: list[dict[str, Any]] = []
    try:
        rows = (db.query(OsParamChange)
                .filter(OsParamChange.cluster_id == cluster.id, OsParamChange.detected_at >= now - CHANGE_WINDOW)
                .order_by(OsParamChange.detected_at.desc()).limit(200).all())
        for r in rows:
            ch = {"node": r.node, "key": r.param, "old_value": r.old_value, "new_value": r.new_value,
                  "change_type": r.change_type, "detected_at": r.detected_at.isoformat() if r.detected_at else None}
            changes.append(ch)
            sig = key_signals.setdefault(r.param, {"alerts": {"critical": 0, "warning": 0}, "last_change": None})
            if sig["last_change"] is None:  # 최신 순이라 처음 것이 마지막 변경
                sig["last_change"] = ch
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        errors.append(f"변경 이력 조회 실패: {str(exc)[:160]}")
    return {"alerts": alerts, "key_signals": key_signals, "recent_changes": changes,
            "offline_nodes": sorted(n for n in offline if n), "errors": errors}


def _last_run(db: Session, cluster: Cluster, service: str) -> Optional[dict[str, Any]]:
    r = (db.query(ServiceConfigApplyRun)
         .filter(ServiceConfigApplyRun.cluster_id == cluster.id, ServiceConfigApplyRun.service == service)
         .order_by(ServiceConfigApplyRun.started_at.desc()).first())
    if r is None:
        return None
    return {"id": str(r.id), "version_no": r.version_no, "status": r.status, "started_by": r.started_by,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


def judge(drift_nodes: int, alerts: list[dict[str, Any]], last_run: Optional[dict[str, Any]],
          offline_nodes: list[str]) -> tuple[str, list[str]]:
    """순수 판정 — (수준, 사유 목록)."""
    level = "ok"
    reasons: list[str] = []

    def bump(lv: str, why: str) -> None:
        nonlocal level
        if _LEVEL_RANK[lv] > _LEVEL_RANK[level]:
            level = lv
        reasons.append(why)

    crit = sum(1 for a in alerts if a["severity"] == "critical")
    warn = len(alerts) - crit
    if crit:
        bump("critical", f"critical 알람 {crit}건")
    if warn:
        bump("warning", f"warning 알람 {warn}건")
    if drift_nodes:
        bump("warning", f"기준 버전과 다른 노드 {drift_nodes}개")
    if offline_nodes:
        bump("warning", f"에이전트 무응답 노드 {len(offline_nodes)}개")
    if last_run and last_run["status"] in ("failed", "partial"):
        bump("warning", f"마지막 적용 {'실패' if last_run['status'] == 'failed' else '일부 성공'} (V{last_run['version_no']})")
    return level, reasons


def service_status(db: Session, cluster: Cluster, service: str, full: bool = True) -> dict[str, Any]:
    meta = V.service_meta(service)
    d = drift(db, cluster, service)
    sig = linux_signals(db, cluster) if service == "linux" else {
        "alerts": [], "key_signals": {}, "recent_changes": [], "offline_nodes": [], "errors": []}
    last_run = _last_run(db, cluster, service)
    pending = V._pending(V.list_versions(db, cluster.id, service))  # noqa: SLF001 — 같은 패키지
    level, reasons = judge(len(d["nodes"]), sig["alerts"], last_run, sig["offline_nodes"])
    out: dict[str, Any] = {
        "service": service, "label": meta["label"], "level": level, "reasons": reasons,
        "drift": {k: d[k] for k in ("baseline_version_no", "baseline_status", "nodes", "keys", "by_group",
                                    "node_count", "last_collected_at")},
        "pending": pending, "last_run": last_run,
        "alert_counts": {"critical": sum(1 for a in sig["alerts"] if a["severity"] == "critical"),
                         "warning": sum(1 for a in sig["alerts"] if a["severity"] != "critical")},
        "offline_nodes": sig["offline_nodes"], "errors": sig["errors"],
    }
    if full:
        out["drift"]["rows"] = d["rows"][:500]
        out["alerts"] = sig["alerts"][:100]
        # 목록으로 — 응답 키가 camelCase 로 바뀌면 `net.ipv4.ip_forward` 같은 설정 키가 망가지므로 dict 키로 두지 않는다.
        out["key_signals"] = [{"key": k, **v} for k, v in sorted(sig["key_signals"].items())]
        out["recent_changes"] = sig["recent_changes"][:50]
        runs = (db.query(ServiceConfigApplyRun)
                .filter(ServiceConfigApplyRun.cluster_id == cluster.id, ServiceConfigApplyRun.service == service)
                .order_by(ServiceConfigApplyRun.started_at.desc()).limit(5).all())
        out["recent_runs"] = [{"id": str(r.id), "version_no": r.version_no, "status": r.status,
                               "started_by": r.started_by, "target_mode": r.target_mode,
                               "target_count": len(r.targets or []),
                               "started_at": r.started_at.isoformat() if r.started_at else None} for r in runs]
    return out


def all_status(db: Session, cluster: Cluster) -> dict[str, Any]:
    """레일 점용 — 서비스마다 수준·사유만. 한 서비스 실패가 나머지를 막지 않는다."""
    out: dict[str, Any] = {}
    for svc in SERVICE_KEYS:
        try:
            s = service_status(db, cluster, svc, full=False)
            out[svc] = {"level": s["level"], "reasons": s["reasons"]}
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            out[svc] = {"level": "ok", "reasons": [], "error": str(exc)[:160]}
    return {"services": out}
