"""리소스 수 스냅샷 수집 + 추세 계산 서비스 (일일점검 리뷰).

- collect_for_cluster: enabled MetricChecklistItem 의 resource_kind 별 정확한 count 를
  _continue 페이지네이션으로 합산해 ResourceCountSnapshot 1행 저장.
- build_trend: today/yesterday/7d/14d/28d 비교 + 어제 대비 추세 + 체크 상태.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from kubernetes import client as k8s_client, config as k8s_config
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Cluster
from app.models.resource_count import (
    MetricCheckState, MetricChecklistItem, ResourceCountSnapshot, SnapshotSource,
)
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

_PAGE = 1000           # 페이지 크기(서버 list limit)
_MAX_PAGES = 500       # 안전 상한 (≈ 50만) — 사실상 실제 카운트
_REQ_TIMEOUT = 60      # 페이지당 apiserver 요청 타임아웃(초)

# kind → (api_class_attr, list_all_method, namespaced). KIND_MAP 과 일치.
COUNT_METHODS: dict[str, tuple[str, str]] = {
    "pods": ("CoreV1Api", "list_pod_for_all_namespaces"),
    "deployments": ("AppsV1Api", "list_deployment_for_all_namespaces"),
    "daemonsets": ("AppsV1Api", "list_daemon_set_for_all_namespaces"),
    "statefulsets": ("AppsV1Api", "list_stateful_set_for_all_namespaces"),
    "replicasets": ("AppsV1Api", "list_replica_set_for_all_namespaces"),
    "replicationcontrollers": ("CoreV1Api", "list_replication_controller_for_all_namespaces"),
    "services": ("CoreV1Api", "list_service_for_all_namespaces"),
    "endpoints": ("CoreV1Api", "list_endpoints_for_all_namespaces"),
    "ingresses": ("NetworkingV1Api", "list_ingress_for_all_namespaces"),
    "configmaps": ("CoreV1Api", "list_config_map_for_all_namespaces"),
    "secrets": ("CoreV1Api", "list_secret_for_all_namespaces"),
    "persistentvolumeclaims": ("CoreV1Api", "list_persistent_volume_claim_for_all_namespaces"),
    "persistentvolumes": ("CoreV1Api", "list_persistent_volume"),
    "jobs": ("BatchV1Api", "list_job_for_all_namespaces"),
    "cronjobs": ("BatchV1Api", "list_cron_job_for_all_namespaces"),
    "nodes": ("CoreV1Api", "list_node"),
    "namespaces": ("CoreV1Api", "list_namespace"),
    "serviceaccounts": ("CoreV1Api", "list_service_account_for_all_namespaces"),
    "networkpolicies": ("NetworkingV1Api", "list_network_policy_for_all_namespaces"),
    "storageclasses": ("StorageV1Api", "list_storage_class"),
}

DEFAULT_ITEMS: list[tuple[str, str, str]] = [
    # (item_key, label, resource_kind)
    ("pods", "Pods", "pods"),
    ("deployments", "Deployments", "deployments"),
    ("daemonsets", "DaemonSets", "daemonsets"),
    ("statefulsets", "StatefulSets", "statefulsets"),
    ("replicasets", "ReplicaSets", "replicasets"),
    ("services", "Services", "services"),
    ("ingresses", "Ingresses", "ingresses"),
    ("configmaps", "ConfigMaps", "configmaps"),
    ("secrets", "Secrets", "secrets"),
    ("persistentvolumeclaims", "PVC", "persistentvolumeclaims"),
    ("jobs", "Jobs", "jobs"),
    ("cronjobs", "CronJobs", "cronjobs"),
    ("nodes", "Nodes", "nodes"),
    ("namespaces", "Namespaces", "namespaces"),
]

_OFFSETS = {"today": 0, "yesterday": 1, "d7": 7, "d14": 14, "d28": 28}

# ── 스냅샷 동작 주기 설정 (AppSetting 저장) ─────────────────────────────────────
SCHEDULE_KEY = "metric_snapshot.schedule"
DEFAULT_CRON = "0 8 * * *"  # 매일 08:00


def get_schedule(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == SCHEDULE_KEY).first()
    val = (row.value if row and isinstance(row.value, dict) else None) or {}
    return {
        "enabled": bool(val.get("enabled", True)),
        "cron": val.get("cron") or DEFAULT_CRON,
        "last_run_at": val.get("last_run_at"),
    }


def set_schedule(db: Session, enabled: bool, cron: str, last_run_at: Optional[str] = "__keep__") -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == SCHEDULE_KEY).first()
    prev = (row.value if row and isinstance(row.value, dict) else {}) or {}
    val = {"enabled": bool(enabled), "cron": cron,
           "last_run_at": prev.get("last_run_at") if last_run_at == "__keep__" else last_run_at}
    if row:
        row.value = val
    else:
        db.add(AppSetting(key=SCHEDULE_KEY, value=val))
    db.commit()
    return val


def _client(cluster: Cluster):
    kc = ensure_kubeconfig_file(cluster)
    if not kc or not os.path.exists(kc):
        raise RuntimeError("kubeconfig 가 등록되지 않은 클러스터입니다.")
    return k8s_config.new_client_from_config(config_file=kc)


def _count_kind(api_client, kind: str) -> tuple[int, bool]:
    """kind 의 정확한 개수(페이지네이션 합산). 반환 (count, truncated)."""
    spec = COUNT_METHODS.get(kind)
    if not spec:
        return 0, False
    api_attr, method_name = spec
    api = getattr(k8s_client, api_attr)(api_client)
    method = getattr(api, method_name)
    cont: Optional[str] = None
    total = 0
    for _ in range(_MAX_PAGES):
        resp = (
            method(limit=_PAGE, _continue=cont, _request_timeout=_REQ_TIMEOUT)
            if cont else
            method(limit=_PAGE, _request_timeout=_REQ_TIMEOUT)
        )
        total += len(resp.items or [])
        cont = resp.metadata._continue if resp.metadata else None
        if not cont:
            return total, False
    return total, True  # 상한 도달 → truncated


def collect_for_cluster(db: Session, cluster: Cluster, source: str = SnapshotSource.auto.value,
                        user_id: Optional[UUID] = None) -> ResourceCountSnapshot:
    """클러스터의 enabled 항목 kind 별 count 를 수집해 스냅샷 1행 저장."""
    items = get_items(db, cluster.id)
    kinds = sorted({it.resource_kind for it in items} or {k for k, _, _ in DEFAULT_ITEMS})
    api_client = _client(cluster)
    counts: dict[str, int] = {}
    truncated: dict[str, bool] = {}
    t0 = time.time()
    logger.info("[snapshot] start cluster=%s name=%s source=%s kinds=%d",
                cluster.id, cluster.name, source, len(kinds))
    for kind in kinds:
        ks = time.time()
        try:
            c, tr = _count_kind(api_client, kind)
            counts[kind] = c
            if tr:
                truncated[kind] = True
            logger.info("[snapshot] cluster=%s kind=%s count=%d truncated=%s %dms",
                        cluster.id, kind, c, tr, int((time.time() - ks) * 1000))
        except Exception as e:  # noqa: BLE001
            logger.warning("[snapshot] count %s failed for cluster %s: %s", kind, cluster.id, str(e)[:200])
    snap = ResourceCountSnapshot(
        cluster_id=cluster.id,
        snapshot_date=date.today(),
        collected_at=datetime.utcnow(),
        source=source,
        counts=counts,
        truncated=truncated,
        created_by_user_id=user_id,
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    logger.info("[snapshot] done cluster=%s name=%s total=%dms counts=%s",
                cluster.id, cluster.name, int((time.time() - t0) * 1000), counts)
    return snap


def get_items(db: Session, cluster_id: UUID) -> list[MetricChecklistItem]:
    """enabled 항목 — 클러스터별 정의가 같은 item_key 의 글로벌을 덮어씀."""
    rows = (
        db.query(MetricChecklistItem)
        .filter(
            or_(MetricChecklistItem.cluster_id == cluster_id, MetricChecklistItem.cluster_id.is_(None)),
            MetricChecklistItem.enabled.is_(True),
        )
        .all()
    )
    by_key: dict[str, MetricChecklistItem] = {}
    for r in sorted(rows, key=lambda x: 0 if x.cluster_id else 1):  # 클러스터별 우선
        by_key.setdefault(r.item_key, r)
    return sorted(by_key.values(), key=lambda x: (x.sort_order, x.item_key))


def _snapshot_on_or_before(db: Session, cluster_id: UUID, d: date) -> Optional[ResourceCountSnapshot]:
    return (
        db.query(ResourceCountSnapshot)
        .filter(ResourceCountSnapshot.cluster_id == cluster_id, ResourceCountSnapshot.snapshot_date <= d)
        .order_by(ResourceCountSnapshot.snapshot_date.desc(), ResourceCountSnapshot.collected_at.desc())
        .first()
    )


def build_trend(db: Session, cluster_id: UUID, target: Optional[date] = None) -> dict[str, Any]:
    """체크리스트 행 + 비교/추세/체크상태."""
    target = target or date.today()
    items = get_items(db, cluster_id)

    snaps: dict[str, Optional[ResourceCountSnapshot]] = {}
    for key, off in _OFFSETS.items():
        snaps[key] = _snapshot_on_or_before(db, cluster_id, target - timedelta(days=off))

    def _val(snap_key: str, kind: str) -> Optional[int]:
        s = snaps.get(snap_key)
        if not s or not isinstance(s.counts, dict):
            return None
        v = s.counts.get(kind)
        return int(v) if v is not None else None

    # 체크 상태 (target 날짜)
    states = {
        s.item_key: s
        for s in db.query(MetricCheckState).filter(
            MetricCheckState.cluster_id == cluster_id, MetricCheckState.check_date == target,
        ).all()
    }

    rows = []
    for it in items:
        kind = it.resource_kind
        today = _val("today", kind)
        yest = _val("yesterday", kind)
        delta = (today - yest) if (today is not None and yest is not None) else None
        trend = "flat"
        if delta is not None:
            trend = "up" if delta > 0 else ("down" if delta < 0 else "flat")
        st = states.get(it.item_key)
        rows.append({
            "item_key": it.item_key,
            "label": it.label,
            "resource_kind": kind,
            "today": today,
            "yesterday": yest,
            "d7": _val("d7", kind),
            "d14": _val("d14", kind),
            "d28": _val("d28", kind),
            "delta": delta,
            "trend": trend,
            "truncated": bool(isinstance(snaps["today"], ResourceCountSnapshot) and (snaps["today"].truncated or {}).get(kind)),
            "is_checked": bool(st.is_checked) if st else False,
            "checked_by": st.checked_by_username if st else None,
            "checked_at": st.checked_at.isoformat() if (st and st.checked_at) else None,
            "note": st.note if st else None,
        })

    latest = snaps["today"]
    return {
        "cluster_id": str(cluster_id),
        "date": target.isoformat(),
        "latest_collected_at": latest.collected_at.isoformat() if latest else None,
        "latest_snapshot_id": str(latest.id) if latest else None,
        "items": rows,
    }
