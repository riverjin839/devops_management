"""노드 OS 파라미터 감시 — 에이전트 보고 처리·현재 상태 조회·무응답 워치독.

흐름(보고 1건):
1. 에이전트 행(``node_param_agents``) 갱신 — 마지막 보고 시각, 오류 요약.
2. 값이 바뀌었으면 스냅샷(``cluster_config_snapshots`` component ``node_params:{node}``)을 새로 쌓고,
   직전 스냅샷과의 런타임 값 차이를 ``os_param_changes`` 에 기록 → ``NodeParamChanged`` 알람.
3. 규칙 판정 — 기준값 위반(``NodeParamBaselineViolation``)·영구 설정 불일치(``NodeParamNotPersisted``)를
   **상태 전이 때만** 알람 인박스로 보낸다(열린 알람이 있으면 그대로 두고, 해소되면 resolved 로 닫는다).
   매 보고(기본 60초)마다 같은 알람을 다시 보내 알림이 반복되는 일을 막는다.
4. 응답으로 다음 보고 주기와 감시 파라미터 목록을 돌려준다 — 에이전트 설정의 원천은 PEP 화면이다(UI-First).

알람은 기존 인박스 경로(``alert_router.route_and_notify``)를 그대로 써서 알림 규칙·중복 억제·채널 재전파·
AI 분석을 재사용한다(source=``node-param-agent``).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import ClusterConfigSnapshot, OsParamChange
from app.models.alert_event import AlertEvent
from app.models.cluster import Cluster
from app.models.node_param_watch import NodeParamAgent, NodeParamWatchRule
from app.services.config_snapshot import hash_payload
from app.services.node_param_watch import rules as R
from app.services.node_param_watch.settings import get_settings

_log = logging.getLogger(__name__)

ALERT_SOURCE = "node-param-agent"
ALERT_CHANGED = "NodeParamChanged"
ALERT_VIOLATION = "NodeParamBaselineViolation"
ALERT_NOT_PERSISTED = "NodeParamNotPersisted"
ALERT_AGENT_OFFLINE = "NodeParamAgentOffline"
STATE_ALERTS = (ALERT_VIOLATION, ALERT_NOT_PERSISTED)

COMPONENT_PREFIX = "node_params:"
MAX_PARAMS_PER_REPORT = 2000
_ERROR_MAX = 2000

# 처음 설치하면 비어 있지 않도록 넣는 공통 규칙(운영자가 화면에서 고치거나 지운다 — 지운 규칙은 되살리지 않는다).
DEFAULT_RULES: list[dict[str, Any]] = [
    {"param": "net.ipv4.ip_forward", "operator": "eq", "expected": "1", "severity": "critical",
     "description": "파드 간 라우팅에 필요 — 0 이면 노드를 지나는 파드 트래픽이 끊긴다."},
    {"param": "net.core.somaxconn", "operator": "any", "severity": "warning",
     "description": "listen 백로그 상한 — 고부하 인그레스·DB 노드에서 조정하는 값."},
    {"param": "net.ipv4.ip_local_port_range", "operator": "any", "severity": "warning",
     "description": "아웃바운드 연결용 임시 포트 범위."},
    {"param": "net.netfilter.nf_conntrack_max", "operator": "any", "severity": "warning",
     "description": "conntrack 테이블 상한 — 가득 차면 새 연결이 버려진다."},
    {"param": "vm.swappiness", "operator": "any", "severity": "warning",
     "description": "스왑 사용 성향 — 쿠버네티스 노드는 보통 낮게 유지한다."},
    {"param": "vm.max_map_count", "operator": "any", "severity": "warning",
     "description": "프로세스당 메모리 맵 수 — Elasticsearch/OpenSearch 노드는 262144 이상 필요."},
    {"param": "vm.overcommit_memory", "operator": "any", "severity": "warning",
     "description": "메모리 오버커밋 정책."},
    {"param": "fs.file-max", "operator": "any", "severity": "warning",
     "description": "시스템 전체 열린 파일 수 상한."},
    {"param": "fs.inotify.max_user_watches", "operator": "any", "severity": "info",
     "description": "inotify 감시 수 상한 — 부족하면 로그 수집기·kubelet 이 파일 변경을 놓친다."},
    {"param": "fs.inotify.max_user_instances", "operator": "any", "severity": "info",
     "description": "inotify 인스턴스 수 상한."},
    {"param": "kernel.pid_max", "operator": "any", "severity": "warning",
     "description": "PID 상한 — 파드가 많은 노드에서 부족하면 프로세스를 못 만든다."},
    {"param": "kernel.panic", "operator": "any", "severity": "info",
     "description": "커널 패닉 뒤 자동 재부팅까지 기다리는 초."},
]


# ── 공용 ─────────────────────────────────────────────────────────────────────

def resolve_cluster(db: Session, hint: Optional[str]) -> Optional[Cluster]:
    """클러스터 UUID 또는 이름으로 찾는다."""
    if not hint or not str(hint).strip():
        return None
    text = str(hint).strip()
    try:
        row = db.query(Cluster).filter(Cluster.id == UUID(text)).first()
        if row:
            return row
    except (ValueError, AttributeError):
        pass
    return db.query(Cluster).filter(Cluster.name == text).first()


def load_rules(db: Session, cluster_id: UUID) -> list[NodeParamWatchRule]:
    return (
        db.query(NodeParamWatchRule)
        .filter(NodeParamWatchRule.enabled.is_(True))
        .filter((NodeParamWatchRule.cluster_id.is_(None)) | (NodeParamWatchRule.cluster_id == cluster_id))
        .order_by(NodeParamWatchRule.param.asc(), NodeParamWatchRule.created_at.asc())
        .all()
    )


def _fingerprint(alertname: str, cluster_id: UUID, node: str, extra: str = "") -> str:
    from app.services.observability.alert_ingest import compute_fingerprint

    labels = {"cluster": str(cluster_id), "node": node}
    if extra:
        labels["key"] = extra
    return compute_fingerprint(alertname, labels)


def _route(db: Session, cluster: Cluster, *, alertname: str, fingerprint: str, node: str,
           severity: str, summary: str, description: str, labels: dict[str, Any],
           status: str = "firing", starts_at: Optional[datetime] = None) -> dict[str, Any]:
    from app.services.observability.alert_ingest import ParsedAlert
    from app.services.observability.alert_router import route_and_notify

    alert = ParsedAlert(
        alertname=alertname,
        fingerprint=fingerprint,
        status=status,
        severity=severity,
        summary=summary[:500],
        description=description,
        resource=node,
        cluster_hint=cluster.name,
        starts_at=starts_at,
        labels={"cluster": cluster.name, "node": node, "source": ALERT_SOURCE, **labels},
        annotations={},
        raw={},
        source=ALERT_SOURCE,
    )
    return route_and_notify(db, alert, cluster.id)


def _resolve_open(db: Session, cluster: Cluster, event: AlertEvent) -> None:
    _route(
        db, cluster, alertname=event.alertname, fingerprint=event.fingerprint, node=event.resource or "",
        severity=event.severity, summary=event.summary or event.alertname,
        description=event.description or "", labels=dict(event.labels or {}), status="resolved",
    )


def _open_alerts(db: Session, cluster_id: UUID, node: str, alertnames: tuple[str, ...]) -> list[AlertEvent]:
    return (
        db.query(AlertEvent)
        .filter(
            AlertEvent.source == ALERT_SOURCE,
            AlertEvent.cluster_id == cluster_id,
            AlertEvent.resource == node,
            AlertEvent.status == "firing",
            AlertEvent.alertname.in_(alertnames),
        )
        .all()
    )


def _clean_runtime(raw: Any) -> dict[str, Optional[str]]:
    out: dict[str, Optional[str]] = {}
    if not isinstance(raw, dict):
        return out
    for k, v in list(raw.items())[:MAX_PARAMS_PER_REPORT]:
        key = str(k).strip()
        if R.valid_param_name(key):
            out[key] = R.normalize_value(v)
    return out


def _clean_persistent(raw: Any) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    for k, v in list(raw.items())[:MAX_PARAMS_PER_REPORT]:
        key = str(k).strip()
        if not R.valid_param_name(key) or not isinstance(v, dict):
            continue
        out[key] = {"value": R.normalize_value(v.get("value")), "source": str(v.get("source") or "")[:300]}
    return out


# ── 보고 처리 ────────────────────────────────────────────────────────────────

def handle_report(db: Session, cluster: Cluster, report: dict[str, Any]) -> dict[str, Any]:
    """에이전트 보고 1건 처리. 호출자가 아니라 이 함수가 commit 한다."""
    now = datetime.utcnow()
    node = str(report.get("node") or "").strip()[:253]
    if not node:
        raise ValueError("node 가 비어 있습니다.")
    host_ip = (str(report.get("host_ip") or "").strip() or None)
    runtime = _clean_runtime(report.get("runtime"))
    persistent = _clean_persistent(report.get("persistent"))
    errors = [str(e) for e in (report.get("errors") or []) if e][:50]

    cfg = get_settings(db)
    rules = load_rules(db, cluster.id)
    by_param = R.rules_for_node(rules, cluster.id, node)

    # 1) 에이전트 행
    agent = (
        db.query(NodeParamAgent)
        .filter(NodeParamAgent.cluster_id == cluster.id, NodeParamAgent.node == node)
        .first()
    )
    if agent is None:
        agent = NodeParamAgent(cluster_id=cluster.id, node=node)
        db.add(agent)
    agent.host_ip = host_ip
    agent.agent_version = (str(report.get("agent_version") or "")[:32] or None)
    agent.last_seen_at = now
    agent.param_count = len(runtime)
    agent.last_error = ("\n".join(errors)[:_ERROR_MAX]) if errors else None

    # 2) 스냅샷 + 변경 이력 — 아직 감시 목록을 받기 전(첫 보고)의 빈 보고는 스냅샷을 남기지 않는다.
    changes: list[dict[str, Any]] = []
    changed_alert: Optional[dict[str, Any]] = None
    if runtime:
        component = f"{COMPONENT_PREFIX}{node}"
        data = {
            "node": node,
            "host_ip": host_ip,
            "source": "agent",
            "runtime": runtime,
            "persistent": {k: v["value"] for k, v in persistent.items()},
            "persistent_sources": {k: v["source"] for k, v in persistent.items()},
        }
        digest = hash_payload(component, None, data)
        prev = (
            db.query(ClusterConfigSnapshot)
            .filter(ClusterConfigSnapshot.cluster_id == cluster.id, ClusterConfigSnapshot.component == component)
            .order_by(ClusterConfigSnapshot.collected_at.desc())
            .first()
        )
        if prev is None or prev.content_hash != digest:
            snap = ClusterConfigSnapshot(
                cluster_id=cluster.id, component=component, category="os", version=None,
                data=data, content_hash=digest, collected_at=now,
            )
            db.add(snap)
            db.flush()
            if prev is not None:
                changes = R.diff_runtime((prev.data or {}).get("runtime") or {}, runtime)
                for ch in changes:
                    db.add(OsParamChange(
                        cluster_id=cluster.id, node=node, param=ch["param"],
                        old_value=ch["old_value"], new_value=ch["new_value"], change_type=ch["change_type"],
                        from_snapshot_id=prev.id, to_snapshot_id=snap.id,
                        extra={"source": "agent", "host_ip": host_ip,
                               "last_unchanged_at": prev.collected_at.isoformat() if prev.collected_at else None},
                        detected_at=now,
                    ))
                if changes:
                    agent.last_change_at = now
                    sev = R.change_severity(by_param, changes)
                    if sev is not None:
                        changed_alert = _route(
                            db, cluster, alertname=ALERT_CHANGED,
                            fingerprint=_fingerprint(ALERT_CHANGED, cluster.id, node, str(snap.id)),
                            node=node, severity=sev, starts_at=now,
                            summary=_change_summary(node, changes),
                            description=_change_description(changes, prev.collected_at, now),
                            labels={"params": ",".join(c["param"] for c in changes)[:500]},
                        )

    # 3) 규칙 판정 — 상태 전이 때만 알람
    statuses = R.evaluate_node(by_param, runtime, persistent) if runtime else []
    desired: dict[str, dict[str, Any]] = {}
    for st in statuses:
        if st.runtime is None and st.operator == "any":
            continue
        if not st.ok:
            fp = _fingerprint(ALERT_VIOLATION, cluster.id, node, st.param)
            desired[fp] = {
                "alertname": ALERT_VIOLATION, "severity": st.severity,
                "summary": f"{node}: {st.param} 기준값 위반 — {st.reason}",
                "description": f"노드 {node} 의 {st.param} 가 감시 규칙과 맞지 않습니다. {st.reason}",
                "labels": {"param": st.param},
            }
        if not st.persisted_ok:
            fp = _fingerprint(ALERT_NOT_PERSISTED, cluster.id, node, st.param)
            desired[fp] = {
                "alertname": ALERT_NOT_PERSISTED, "severity": "warning",
                "summary": f"{node}: {st.param} 런타임 {st.runtime} ≠ 영구 설정 {st.persistent} (재부팅 시 값이 바뀜)",
                "description": (
                    f"노드 {node} 의 {st.param} 현재 값({st.runtime})이 영구 설정"
                    f"({st.persistent_source or 'sysctl 설정 파일'}: {st.persistent})과 다릅니다. "
                    "재부팅하면 영구 설정 값으로 돌아갑니다."
                ),
                "labels": {"param": st.param},
            }
    opened, resolved = 0, 0
    if runtime:
        open_events = _open_alerts(db, cluster.id, node, STATE_ALERTS)
        open_fps = {e.fingerprint for e in open_events}
        for fp, a in desired.items():
            if fp in open_fps:
                continue
            _route(db, cluster, fingerprint=fp, node=node, alertname=a["alertname"], severity=a["severity"],
                   summary=a["summary"], description=a["description"], labels=a["labels"])
            opened += 1
        for ev in open_events:
            if ev.fingerprint not in desired:
                _resolve_open(db, cluster, ev)
                resolved += 1
    # 보고가 왔으므로 무응답 알람은 닫는다.
    for ev in _open_alerts(db, cluster.id, node, (ALERT_AGENT_OFFLINE,)):
        _resolve_open(db, cluster, ev)

    agent.violation_count = sum(1 for s in statuses if not s.ok)
    agent.mismatch_count = sum(1 for s in statuses if not s.persisted_ok)
    db.commit()

    return {
        "ok": True,
        "node": node,
        "interval_sec": cfg["interval_sec"],
        "params": sorted(by_param),
        "changes": len(changes),
        "change_alert": bool(changed_alert),
        "violations": agent.violation_count,
        "mismatches": agent.mismatch_count,
        "alerts_opened": opened,
        "alerts_resolved": resolved,
    }


def _change_summary(node: str, changes: list[dict[str, Any]]) -> str:
    head = ", ".join(f"{c['param']} {c['old_value']}→{c['new_value']}" for c in changes[:3])
    more = f" 외 {len(changes) - 3}건" if len(changes) > 3 else ""
    return f"{node}: OS 파라미터 변경 — {head}{more}"


def _change_description(changes: list[dict[str, Any]], prev_at: Optional[datetime], now: datetime) -> str:
    window = f"{prev_at:%Y-%m-%d %H:%M:%S} ~ {now:%Y-%m-%d %H:%M:%S} (UTC) 사이에 바뀌었습니다." if prev_at else ""
    lines = [f"- {c['param']}: {c['old_value']} → {c['new_value']} ({c['change_type']})" for c in changes[:50]]
    return "\n".join([window, *lines]).strip()


# ── 조회 ─────────────────────────────────────────────────────────────────────

def node_states(db: Session, cluster: Cluster) -> dict[str, Any]:
    """화면용 — 노드별 에이전트 상태 + 최신 스냅샷 기준 파라미터 판정."""
    cfg = get_settings(db)
    now = datetime.utcnow()
    offline_after = timedelta(minutes=cfg["offline_minutes"]) if cfg["offline_minutes"] else None
    stale_after = timedelta(seconds=cfg["interval_sec"] * 3)
    rules = load_rules(db, cluster.id)
    agents = (
        db.query(NodeParamAgent)
        .filter(NodeParamAgent.cluster_id == cluster.id)
        .order_by(NodeParamAgent.node.asc())
        .all()
    )
    nodes_out: list[dict[str, Any]] = []
    for ag in agents:
        snap = (
            db.query(ClusterConfigSnapshot)
            .filter(ClusterConfigSnapshot.cluster_id == cluster.id,
                    ClusterConfigSnapshot.component == f"{COMPONENT_PREFIX}{ag.node}")
            .order_by(ClusterConfigSnapshot.collected_at.desc())
            .first()
        )
        data = (snap.data or {}) if snap else {}
        persistent = {
            k: {"value": v, "source": (data.get("persistent_sources") or {}).get(k)}
            for k, v in (data.get("persistent") or {}).items()
        }
        by_param = R.rules_for_node(rules, cluster.id, ag.node)
        statuses = R.evaluate_node(by_param, data.get("runtime") or {}, persistent) if snap else []
        age = (now - ag.last_seen_at).total_seconds() if ag.last_seen_at else None
        if ag.last_seen_at is None:
            state = "unknown"
        elif offline_after is not None and now - ag.last_seen_at > offline_after:
            state = "offline"
        elif now - ag.last_seen_at > stale_after:
            state = "late"
        else:
            state = "reporting"
        nodes_out.append({
            "agent_id": str(ag.id),
            "node": ag.node,
            "host_ip": ag.host_ip,
            "agent_version": ag.agent_version,
            "state": state,
            "last_seen_at": ag.last_seen_at.isoformat() if ag.last_seen_at else None,
            "last_seen_age_sec": int(age) if age is not None else None,
            "last_change_at": ag.last_change_at.isoformat() if ag.last_change_at else None,
            "last_error": ag.last_error,
            "snapshot_at": snap.collected_at.isoformat() if snap and snap.collected_at else None,
            "violation_count": sum(1 for s in statuses if not s.ok),
            "mismatch_count": sum(1 for s in statuses if not s.persisted_ok),
            "params": [s.as_dict() for s in statuses],
        })
    return {
        "cluster_id": str(cluster.id),
        "interval_sec": cfg["interval_sec"],
        "offline_minutes": cfg["offline_minutes"],
        "rule_count": len(rules),
        "nodes": nodes_out,
    }


# ── 워치독 ───────────────────────────────────────────────────────────────────

def run_watchdog(db: Session, now: Optional[datetime] = None) -> dict[str, Any]:
    """마지막 보고가 ``offline_minutes`` 를 넘긴 에이전트에 무응답 알람(이미 열려 있으면 그대로)."""
    cfg = get_settings(db)
    if not cfg["offline_minutes"]:
        return {"checked": 0, "opened": 0, "reason": "disabled"}
    now = now or datetime.utcnow()
    cutoff = now - timedelta(minutes=cfg["offline_minutes"])
    stale = (
        db.query(NodeParamAgent)
        .filter(NodeParamAgent.last_seen_at.isnot(None), NodeParamAgent.last_seen_at < cutoff)
        .all()
    )
    opened = 0
    clusters: dict[UUID, Optional[Cluster]] = {}
    for ag in stale:
        if ag.cluster_id not in clusters:
            clusters[ag.cluster_id] = db.query(Cluster).filter(Cluster.id == ag.cluster_id).first()
        cluster = clusters[ag.cluster_id]
        if cluster is None:
            continue
        if _open_alerts(db, cluster.id, ag.node, (ALERT_AGENT_OFFLINE,)):
            continue
        minutes = int((now - ag.last_seen_at).total_seconds() // 60)
        try:
            _route(
                db, cluster, alertname=ALERT_AGENT_OFFLINE,
                fingerprint=_fingerprint(ALERT_AGENT_OFFLINE, cluster.id, ag.node),
                node=ag.node, severity="warning",
                summary=f"{ag.node}: OS 파라미터 에이전트 무응답 {minutes}분",
                description=(
                    f"노드 {ag.node} 의 에이전트가 {ag.last_seen_at:%Y-%m-%d %H:%M:%S} (UTC) 이후 보고하지 않습니다. "
                    "이 동안의 파라미터 변경은 감지되지 않습니다. DaemonSet 파드 상태·노드 상태를 확인하세요. "
                    "노드를 없앴다면 화면에서 에이전트를 목록에서 지우세요."
                ),
                labels={},
            )
            opened += 1
        except Exception as exc:  # noqa: BLE001 — 한 노드 실패가 나머지를 막지 않는다
            db.rollback()
            _log.warning("node-param watchdog: %s/%s 알람 실패 (%s)", cluster.name, ag.node, exc)
    db.commit()
    return {"checked": len(stale), "opened": opened}


def remove_agent(db: Session, cluster: Cluster, agent: NodeParamAgent) -> None:
    """노드를 없앴을 때 — 에이전트 행을 지우고 그 노드의 열린 알람을 닫는다(이력은 남긴다)."""
    for ev in _open_alerts(db, cluster.id, agent.node, (*STATE_ALERTS, ALERT_AGENT_OFFLINE)):
        _resolve_open(db, cluster, ev)
    db.delete(agent)
    db.commit()


def seed_default_rules(db: Session) -> int:
    """규칙 테이블이 비어 있을 때만 공통 기본 규칙을 넣는다(운영자가 지운 규칙을 되살리지 않는다)."""
    if db.query(NodeParamWatchRule.id).first() is not None:
        return 0
    for spec in DEFAULT_RULES:
        db.add(NodeParamWatchRule(
            cluster_id=None, param=spec["param"], operator=spec["operator"], expected=spec.get("expected"),
            severity=spec["severity"], alert_on_change=True, check_persistent=True,
            description=spec.get("description"), enabled=True, created_by="system",
        ))
    db.commit()
    return len(DEFAULT_RULES)
