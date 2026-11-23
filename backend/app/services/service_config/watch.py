"""서비스 구성 — 변경 감지·알람(ETCD·CONTAINERD·CILIUM·정적 파드·KUBELET). LINUX 는 노드 파라미터 에이전트(``node_param_watch``)가 맡는다.

흐름
1. 스냅샷이 저장되면 ``after_store`` 가 같은 컴포넌트의 직전 스냅샷과 관리 대상 키를 비교해 ``ServiceConfigChange`` 로 남기고
   (같은 스냅샷은 두 번 기록하지 않음), 적용(source=apply)이 아니면 변경 알람 ``ServiceConfigChanged`` 를 1건 낸다.
2. ``sync_drift`` 가 서비스의 드리프트(기준 버전과 다른 노드 값, ``status.drift``)를 (서비스·노드·키) 지문 알람
   ``ServiceConfigDrift`` 로 열고, 맞아지면 닫는다 — 상태가 바뀔 때만 알람이 움직인다.
3. 값이 들어오는 경로: 주기 K8S API 수집(``collect_cluster`` — 정적 파드·cilium-config, Celery Beat 디스패처) ·
   노드 파라미터 에이전트 파일 보고(``ingest_agent_files`` — containerd·kubelet 설정 파일) · 수동 수집(K8S API·SSH) · 적용.

설정(AppSetting ``service_config.watch``, admin): 켜기 · 주기(분) · 변경 알람 · 드리프트 알람·심각도. 실패는 fail-safe(로그·errors).
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Iterable, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import ClusterConfigSnapshot
from app.models.cluster import Cluster
from app.models.service_config import ServiceConfigChange, ServiceConfigVersion
from app.services.service_config import current as C
from app.services.service_config import view as V
from app.services.service_config.catalog_seed import SERVICE_KEYS

logger = logging.getLogger(__name__)

SETTINGS_KEY = "service_config.watch"
SETTINGS_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "interval_min": 5,
    "change_alert": True,
    "change_severity": "warning",
    "drift_alert": True,
    "drift_severity": "warning",
}
_SEVERITIES = ("info", "warning", "critical")
ALERT_SOURCE = "service-config"
ALERT_CHANGED = "ServiceConfigChanged"
ALERT_DRIFT = "ServiceConfigDrift"
WATCHED_SERVICES = tuple(s for s in SERVICE_KEYS if s != "linux")
# 노드별로 저장되는 컴포넌트만 변경을 비교한다(버전 수집의 대표 파드 1개 — ``etcd``·``kube_apiserver`` 등은 노드가 바뀔 수 있어 제외).
_NODE_PREFIXES = ("static_pod:", "containerd_config:", "kubelet_config:", "etcd_systemd:")
_CLUSTER_COMPONENTS = ("cilium_config",)
AGENT_FILE_IDS = {"containerd": "containerd_config", "kubelet": "kubelet_config"}  # 파일 id → 적용 설정 경로 키
AGENT_FILE_MAX = 256 * 1024


# ── 설정 ─────────────────────────────────────────────────────────────────────

def _normalize(stored: Any) -> dict[str, Any]:
    out = {**SETTINGS_DEFAULTS, **(stored if isinstance(stored, dict) else {})}
    for k in ("enabled", "change_alert", "drift_alert"):
        out[k] = bool(out[k])
    try:
        out["interval_min"] = max(1, min(int(out["interval_min"]), 1440))
    except (TypeError, ValueError):
        out["interval_min"] = SETTINGS_DEFAULTS["interval_min"]
    for k in ("change_severity", "drift_severity"):
        if out[k] not in _SEVERITIES:
            out[k] = SETTINGS_DEFAULTS[k]
    return {k: out[k] for k in SETTINGS_DEFAULTS}


def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001
        db.rollback()
        return _normalize(None)
    return _normalize(row.value if row else None)


def set_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    prev = row.value if row and isinstance(row.value, dict) else {}
    merged = _normalize({**prev, **{k: v for k, v in patch.items() if v is not None}})
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return merged


# ── 변경 비교 ────────────────────────────────────────────────────────────────

def watchable(component: str) -> bool:
    return component in _CLUSTER_COMPONENTS or component.startswith(_NODE_PREFIXES)


def services_of(component: str) -> list[str]:
    return [s for s in WATCHED_SERVICES if C.wants_component(s, component)]


def diff_snapshots(service: str, items: list[Any], component: str, prev_data: Any, new_data: Any) -> list[dict[str, Any]]:
    """순수 계산 — 같은 컴포넌트의 두 스냅샷에서 관리 대상 키 값이 달라진 것(노드별)."""
    def vals(data: Any) -> dict[str, dict[str, str]]:
        snap = SimpleNamespace(component=component, data=data or {}, collected_at=None)
        return C.current_values(service, [snap], items)["values"]

    before, after = vals(prev_data), vals(new_data)
    out: list[dict[str, Any]] = []
    for it in items:
        b, a = before.get(it.key) or {}, after.get(it.key) or {}
        for node in sorted(set(b) | set(a)):
            if C.norm(b.get(node)) != C.norm(a.get(node)):
                out.append({"key": it.key, "node": node, "old": b.get(node), "new": a.get(node)})
    return out


def after_store(db: Session, cluster: Cluster, component: str, source: str, now: Optional[datetime] = None) -> list[dict[str, Any]]:
    """방금 저장된 스냅샷과 직전 스냅샷을 비교해 변경 이력·변경 알람을 남긴다(같은 스냅샷은 한 번만). 실패는 삼킨다."""
    if not watchable(component):
        return []
    try:
        snaps = (db.query(ClusterConfigSnapshot)
                 .filter(ClusterConfigSnapshot.cluster_id == cluster.id, ClusterConfigSnapshot.component == component)
                 .order_by(ClusterConfigSnapshot.collected_at.desc()).limit(2).all())
        if len(snaps) < 2:
            return []
        new, prev = snaps
        if db.query(ServiceConfigChange.id).filter(ServiceConfigChange.to_snapshot_id == new.id).first():
            return []
        now = now or datetime.utcnow()
        changes: list[dict[str, Any]] = []
        for svc in services_of(component):
            for ch in diff_snapshots(svc, V.load_items(db, svc), component, prev.data, new.data):
                ch["service"] = svc
                changes.append(ch)
                db.add(ServiceConfigChange(
                    cluster_id=cluster.id, service=svc, node=ch["node"], key=ch["key"],
                    old_value=C.norm(ch["old"]), new_value=C.norm(ch["new"]), source=source,
                    component=component, to_snapshot_id=new.id, detected_at=now,
                ))
        if changes and source != "apply":
            cfg = get_settings(db)
            if cfg["change_alert"]:
                _change_alert(db, cluster, changes, new.id, cfg["change_severity"], source, now)
        return changes
    except Exception as exc:  # noqa: BLE001 — 감지 실패가 수집·적용을 막지 않는다
        db.rollback()
        logger.warning("service-config after_store failed %s: %s", component, exc)
        return []


# ── 알람 ─────────────────────────────────────────────────────────────────────

def _fingerprint(alertname: str, labels: dict[str, str]) -> str:
    from app.services.observability.alert_ingest import compute_fingerprint

    return compute_fingerprint(alertname, labels)


def _route(db: Session, cluster: Cluster, *, alertname: str, fingerprint: str, node: str, severity: str, summary: str,
           description: str, labels: dict[str, Any], status: str = "firing", starts_at: Optional[datetime] = None) -> None:
    from app.services.observability.alert_ingest import ParsedAlert
    from app.services.observability.alert_router import route_and_notify

    route_and_notify(db, ParsedAlert(
        alertname=alertname, fingerprint=fingerprint, status=status, severity=severity, summary=summary[:500],
        description=description, resource=node, cluster_hint=cluster.name, starts_at=starts_at,
        labels={"cluster": cluster.name, "node": node, "source": ALERT_SOURCE, **labels},
        annotations={}, raw={}, source=ALERT_SOURCE,
    ), cluster.id)


_SOURCE_LABEL = {"agent": "노드 에이전트", "k8s_api": "K8S API 수집", "ssh": "SSH 수집", "apply": "PEP 적용"}


def _change_alert(db: Session, cluster: Cluster, changes: list[dict[str, Any]], snap_id: UUID, severity: str,
                  source: str, now: datetime) -> None:
    by_node: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for ch in changes:
        by_node.setdefault((ch["service"], ch["node"]), []).append(ch)
    for (svc, node), chs in by_node.items():
        label = V.service_meta(svc)["label"]
        head = ", ".join(f"{c['key']} {c['old'] or '없음'}→{c['new'] or '없음'}" for c in chs[:3])
        _route(db, cluster, alertname=ALERT_CHANGED, node=node, severity=severity, starts_at=now,
               fingerprint=_fingerprint(ALERT_CHANGED, {"cluster": str(cluster.id), "service": svc, "node": node, "snap": str(snap_id)}),
               summary=f"{label} {node}: 설정 {len(chs)}개 변경 — {head}{' …' if len(chs) > 3 else ''}",
               description=(f"{_SOURCE_LABEL.get(source, source)}에서 {label} 의 설정 값이 바뀐 것을 감지했습니다(PEP 적용이 아닌 변경).\n"
                            + "\n".join(f"- {c['key']}: {c['old'] or '없음'} → {c['new'] or '없음'}" for c in chs[:30])),
               labels={"service": svc, "params": ",".join(c["key"] for c in chs)[:500]})


def _open_drift_alerts(db: Session, cluster: Cluster, service: str) -> list[Any]:
    from app.models.alert_event import AlertEvent

    rows = (db.query(AlertEvent)
            .filter(AlertEvent.cluster_id == cluster.id, AlertEvent.source == ALERT_SOURCE,
                    AlertEvent.alertname == ALERT_DRIFT, AlertEvent.status == "firing").all())
    return [r for r in rows if (r.labels or {}).get("service") == service]


def sync_drift(db: Session, cluster: Cluster, services: Iterable[str]) -> dict[str, int]:
    """서비스별 드리프트 알람을 현재 상태에 맞춘다 — 새로 다른 값은 열고, 맞아진 것은 닫는다. 실패는 삼킨다."""
    from app.services.service_config import status as S

    out = {"opened": 0, "resolved": 0}
    cfg = get_settings(db)
    for svc in services:
        if svc not in WATCHED_SERVICES:
            continue
        try:
            rows = S.drift(db, cluster, svc)["rows"] if cfg["drift_alert"] else []
            label = V.service_meta(svc)["label"]
            desired: dict[str, dict[str, Any]] = {}
            for r in rows:
                fp = _fingerprint(ALERT_DRIFT, {"cluster": str(cluster.id), "service": svc, "node": r["node"], "key": r["key"]})
                desired[fp] = r
            open_rows = _open_drift_alerts(db, cluster, svc)
            open_fps = {e.fingerprint for e in open_rows}
            for fp, r in desired.items():
                if fp in open_fps:
                    continue
                _route(db, cluster, alertname=ALERT_DRIFT, fingerprint=fp, node=r["node"], severity=cfg["drift_severity"],
                       summary=f"{label} {r['node']}: {r['key']} {r['current']} ≠ 기준 V{r['baseline_version_no']} {r['expected']}",
                       description=(f"노드 {r['node']} 의 {label} 설정 {r['key']} 가 기준 버전(V{r['baseline_version_no']}, {r['group_name']} 그룹)과 다릅니다. "
                                    "서비스 구성 화면의 '다시 적용' 으로 되돌리거나, 의도한 변경이면 새 버전으로 저장하세요."),
                       labels={"service": svc, "param": r["key"]})
                out["opened"] += 1
            for ev in open_rows:
                if ev.fingerprint not in desired:
                    _route(db, cluster, alertname=ALERT_DRIFT, fingerprint=ev.fingerprint, node=ev.resource or "",
                           severity=ev.severity, status="resolved", summary=ev.summary or ALERT_DRIFT,
                           description=ev.description or "", labels={k: v for k, v in (ev.labels or {}).items()
                                                                       if k not in ("cluster", "node", "source")})
                    out["resolved"] += 1
            db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.warning("service-config sync_drift failed %s/%s: %s", cluster.id, svc, exc)
    return out


def store_and_watch(db: Session, cluster: Cluster, component: str, category: Optional[str], version: Optional[str],
                    data: dict[str, Any], now: datetime, source: str) -> bool:
    """스냅샷 저장(내용 같으면 생략) + 저장됐으면 변경 비교. 호출자가 commit·``sync_drift`` 를 한다."""
    from app.services.config_snapshot import store_if_changed

    stored = store_if_changed(db, cluster.id, component, category, version, data, now)
    if stored:
        db.flush()
        after_store(db, cluster, component, source, now)
    return stored


# ── 주기 수집(K8S API) ───────────────────────────────────────────────────────

def opted_in_cluster_ids(db: Session) -> list[UUID]:
    """V1 을 만든(설정 버전이 있는) 클러스터만 주기 수집한다 — 서비스 구성을 쓰지 않는 클러스터에 부하를 주지 않게."""
    return [cid for (cid,) in db.query(ServiceConfigVersion.cluster_id).distinct().all()]


def collect_cilium_config(db: Session, cluster: Cluster, source: str = "k8s_api") -> dict[str, Any]:
    from app.services.service_config import apply as A

    cfg = A.get_settings(db)
    try:
        core, _apps = A.k8s_apis(cluster)
        cm = core.read_namespaced_config_map(cfg["cilium_configmap"], cfg["cilium_namespace"], _request_timeout=15)
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status", None)
        return {"changed": False, "error": None if status == 404 else f"cilium-config 조회 실패: {str(exc)[:160]}"}
    data = dict(cm.data or {})
    version = data.get("cilium-version") or data.get("cni-version")
    changed = store_and_watch(db, cluster, "cilium_config", "cni", version, {"data": data}, datetime.utcnow(), source)
    return {"changed": changed, "error": None}


def collect_cluster(db: Session, cluster: Cluster) -> dict[str, Any]:
    """한 클러스터 주기 수집 — 정적 파드(노드별) + cilium-config → 변경 이력·알람 → 드리프트 알람 동기화."""
    from app.services.service_config import collect as CL

    out: dict[str, Any] = {"cluster": cluster.name, "errors": []}
    sp = CL.collect_static_pods(db, cluster, source="k8s_api")
    out["static_pods_changed"] = sp["changed"]
    out["errors"] += sp["errors"]
    cil = collect_cilium_config(db, cluster)
    if cil["error"]:
        out["errors"].append(cil["error"])
    db.commit()
    out["drift"] = sync_drift(db, cluster, WATCHED_SERVICES)
    return out


def due_clusters(db: Session, now: datetime, last_runs: dict[str, float]) -> list[Cluster]:
    """순수 판정에 가까운 선택 — 설정이 켜져 있고 주기가 지난 opt-in 클러스터."""
    cfg = get_settings(db)
    if not cfg["enabled"]:
        return []
    ids = set(opted_in_cluster_ids(db))
    if not ids:
        return []
    out = []
    for c in db.query(Cluster).filter(Cluster.id.in_(ids)).all():
        last = last_runs.get(str(c.id))
        if last is None or now.timestamp() - last >= cfg["interval_min"] * 60 - 5:
            out.append(c)
    return out


# ── 노드 파라미터 에이전트 파일 보고 ─────────────────────────────────────────

def agent_file_targets(db: Session) -> list[dict[str, str]]:
    """에이전트가 읽을 파일 목록 — 적용 설정의 경로를 따른다(UI-First)."""
    from app.services.service_config import apply as A

    cfg = A.get_settings(db)
    return [{"id": fid, "path": cfg[key]} for fid, key in AGENT_FILE_IDS.items()]


def ingest_agent_files(db: Session, cluster: Cluster, node: str, host_ip: Optional[str], files: Any) -> dict[str, Any]:
    """에이전트 보고의 ``files`` — {id: {sha256, content?, path?, error?}}. 내용이 온 파일만 스냅샷·변경 비교. fail-safe."""
    out: dict[str, Any] = {"stored": [], "errors": []}
    if not isinstance(files, dict) or not files:
        return out
    host = host_ip or node
    now = datetime.utcnow()
    touched: set[str] = set()
    for fid, f in files.items():
        if fid not in AGENT_FILE_IDS or not isinstance(f, dict):
            continue
        if f.get("error"):
            out["errors"].append(f"{fid}: {str(f['error'])[:200]}")
            continue
        content = f.get("content")
        if not isinstance(content, str) or len(content) > AGENT_FILE_MAX:
            continue
        sha = hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()
        path = str(f.get("path") or "")[:300] or None
        try:
            if fid == "containerd":
                flat = C.parse_containerd_toml(content)
                data = {"source": "agent", "host": host, "node": node, "source_label": f"노드 에이전트 · {path or 'config.toml'}",
                        "config_file": path, "flat": flat, "sha256": sha}
                if store_and_watch(db, cluster, f"containerd_config:{host}", "runtime", str(flat.get("version") or "") or None,
                                   data, now, "agent"):
                    out["stored"].append(fid)
                touched.add("containerd")
            elif fid == "kubelet":
                data = {"source": "agent", "host": host, "node": node, "config_file": path, "config_content": content,
                        "sha256": sha, "collected_at": now.isoformat()}
                if store_and_watch(db, cluster, f"kubelet_config:{host}", "kubelet", None, data, now, "agent"):
                    out["stored"].append(fid)
                touched.add("kubelet")
        except Exception as exc:  # noqa: BLE001 — 해석 실패는 그 파일만
            db.rollback()
            out["errors"].append(f"{fid}: 해석 실패 {str(exc)[:160]}")
    if touched:
        db.commit()
        out["drift"] = sync_drift(db, cluster, touched)
    return out


# ── 화면 신호(비 LINUX) ──────────────────────────────────────────────────────

def recent_changes(db: Session, cluster: Cluster, service: str, since: datetime, limit: int = 200) -> list[ServiceConfigChange]:
    return (db.query(ServiceConfigChange)
            .filter(ServiceConfigChange.cluster_id == cluster.id, ServiceConfigChange.service == service,
                    ServiceConfigChange.detected_at >= since)
            .order_by(ServiceConfigChange.detected_at.desc()).limit(limit).all())


def after_collect(db: Session, cluster_id: UUID, components: Iterable[str], source: str) -> None:
    """수동 수집(SSH·버전 수집) 뒤 — 저장된 컴포넌트마다 변경 비교 후 관련 서비스 드리프트 알람 동기화."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        return
    services: set[str] = set()
    for comp in components:
        if watchable(comp):
            after_store(db, cluster, comp, source)
            services.update(services_of(comp))
    db.commit()
    if services:
        sync_drift(db, cluster, services)


STATE_KEY = "service_config.watch_state"


def get_state(db: Session) -> dict[str, float]:
    """클러스터별 마지막 주기 수집 시각(epoch) — 디스패처가 주기를 판정한다."""
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == STATE_KEY).first()
    v = row.value if row and isinstance(row.value, dict) else {}
    return {k: float(t) for k, t in v.items() if isinstance(t, (int, float))}


def set_state(db: Session, state: dict[str, float]) -> None:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == STATE_KEY).first()
    if row:
        row.value = dict(state)
    else:
        db.add(AppSetting(key=STATE_KEY, value=dict(state)))
    db.commit()
