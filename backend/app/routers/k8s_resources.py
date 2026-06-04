"""읽기전용 K8s 리소스 탐색기 (OpenLens P1 MVP).

흔한 핵심 리소스를 공통 형식(name/namespace/summary/age)으로 list 하고, 단일
오브젝트를 YAML 로 보여준다. **읽기 전용** — 편집/적용 없음(P5 보류). Secret 의 data
값은 마스킹한다.

전체 Discovery/CRD 동적 조회는 후속(P1 확장). 여기서는 typed API 로 안전하게 커버.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from uuid import UUID

import yaml
from fastapi import APIRouter, Depends, HTTPException
from kubernetes import client as k8s_client, config as k8s_config
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k8s-resources"])

_LIST_LIMIT = 1000  # 대형 클러스터 보호 — 한 종류당 상한(초과 시 truncated 표시)


# ── 클라이언트 ────────────────────────────────────────────────────────────────
def _api_client(cluster: Cluster) -> k8s_client.ApiClient:
    kc_path = ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(status_code=422, detail="kubeconfig 가 등록되지 않은 클러스터입니다.")
    try:
        return k8s_config.new_client_from_config(config_file=kc_path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"kubeconfig 로드 실패: {str(e)[:200]}") from e


def _require_cluster(cluster_id: UUID, db: Session) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return c


def _age_seconds(meta) -> Optional[int]:
    ts = getattr(meta, "creation_timestamp", None)
    if not ts:
        return None
    try:
        return int((datetime.now(timezone.utc) - ts).total_seconds())
    except Exception:  # noqa: BLE001
        return None


# ── 종류별 매핑 ───────────────────────────────────────────────────────────────
# 각 항목: list_all(api), list_ns(api, ns), read(api, ns, name), summary(obj), namespaced
def _dep_summary(o) -> str:
    s = o.status
    return f"{(s.ready_replicas or 0)}/{(s.replicas or o.spec.replicas or 0)} ready"


def _svc_summary(o) -> str:
    return f"{o.spec.type} · {o.spec.cluster_ip or '-'}"


def _ing_summary(o) -> str:
    hosts = [r.host for r in (o.spec.rules or []) if getattr(r, 'host', None)]
    return ", ".join(hosts) or "-"


def _pvc_summary(o) -> str:
    cap = (o.status.capacity or {}).get("storage", "") if o.status else ""
    return f"{(o.status.phase if o.status else '-')} {cap}".strip()


def _pod_summary(o) -> str:
    cs = o.status.container_statuses or [] if o.status else []
    ready = sum(1 for c in cs if c.ready)
    restarts = sum((c.restart_count or 0) for c in cs)
    return f"{o.status.phase if o.status else '-'} · {ready}/{len(o.spec.containers or [])} · restart {restarts}"


KIND_MAP: dict[str, dict[str, Any]] = {
    "deployments": {
        "namespaced": True,
        "api": lambda c: k8s_client.AppsV1Api(c),
        "list_all": lambda a: a.list_deployment_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_deployment(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_deployment(n, ns),
        "summary": _dep_summary,
    },
    "statefulsets": {
        "namespaced": True,
        "api": lambda c: k8s_client.AppsV1Api(c),
        "list_all": lambda a: a.list_stateful_set_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_stateful_set(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_stateful_set(n, ns),
        "summary": _dep_summary,
    },
    "daemonsets": {
        "namespaced": True,
        "api": lambda c: k8s_client.AppsV1Api(c),
        "list_all": lambda a: a.list_daemon_set_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_daemon_set(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_daemon_set(n, ns),
        "summary": lambda o: f"{(o.status.number_ready or 0)}/{(o.status.desired_number_scheduled or 0)} ready",
    },
    "services": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_service_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_service(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_service(n, ns),
        "summary": _svc_summary,
    },
    "ingresses": {
        "namespaced": True,
        "api": lambda c: k8s_client.NetworkingV1Api(c),
        "list_all": lambda a: a.list_ingress_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_ingress(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_ingress(n, ns),
        "summary": _ing_summary,
    },
    "configmaps": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_config_map_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_config_map(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_config_map(n, ns),
        "summary": lambda o: f"{len(o.data or {})} keys",
    },
    "secrets": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_secret_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_secret(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_secret(n, ns),
        "summary": lambda o: f"{o.type} · {len(o.data or {})} keys",
    },
    "persistentvolumeclaims": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_persistent_volume_claim_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_persistent_volume_claim(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_persistent_volume_claim(n, ns),
        "summary": _pvc_summary,
    },
    "jobs": {
        "namespaced": True,
        "api": lambda c: k8s_client.BatchV1Api(c),
        "list_all": lambda a: a.list_job_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_job(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_job(n, ns),
        "summary": lambda o: f"succeeded {(o.status.succeeded or 0)} / failed {(o.status.failed or 0)}",
    },
    "cronjobs": {
        "namespaced": True,
        "api": lambda c: k8s_client.BatchV1Api(c),
        "list_all": lambda a: a.list_cron_job_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_cron_job(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_cron_job(n, ns),
        "summary": lambda o: f"schedule {o.spec.schedule}",
    },
    "pods": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_pod_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_pod(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_pod(n, ns),
        "summary": _pod_summary,
    },
}


class ResourceRow(BaseModel):
    name: str
    namespace: Optional[str] = None
    summary: str = ""
    age_seconds: Optional[int] = None


class ResourceListResponse(BaseModel):
    kind: str
    count: int
    truncated: bool
    items: list[ResourceRow]


@router.get("/{cluster_id}/resources/kinds")
def list_kinds():
    """탐색 가능한 리소스 종류 목록(읽기전용 MVP)."""
    return {"kinds": sorted(KIND_MAP.keys())}


@router.get("/{cluster_id}/resources/{kind}", response_model=ResourceListResponse)
def list_resources(
    cluster_id: UUID,
    kind: str,
    namespace: Optional[str] = None,
    db: Session = Depends(get_db),
):
    spec = KIND_MAP.get(kind)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"지원하지 않는 종류: {kind}")
    cluster = _require_cluster(cluster_id, db)
    api = spec["api"](_api_client(cluster))
    try:
        result = spec["list_ns"](api, namespace) if namespace else spec["list_all"](api)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        code = 504 if "timeout" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=f"{kind} 조회 실패: {msg[:200]}")

    rows: list[ResourceRow] = []
    summary_fn: Callable[[Any], str] = spec["summary"]
    for o in (result.items or []):
        try:
            summ = summary_fn(o)
        except Exception:  # noqa: BLE001
            summ = ""
        rows.append(ResourceRow(
            name=o.metadata.name,
            namespace=o.metadata.namespace,
            summary=summ,
            age_seconds=_age_seconds(o.metadata),
        ))
    truncated = (result.metadata._continue is not None) if result.metadata else False
    rows.sort(key=lambda r: (r.namespace or "", r.name))
    return ResourceListResponse(kind=kind, count=len(rows), truncated=truncated, items=rows)


@router.get("/{cluster_id}/resources/{kind}/{namespace}/{name}/yaml")
def get_resource_yaml(
    cluster_id: UUID,
    kind: str,
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
):
    """단일 오브젝트 YAML (읽기전용). Secret 의 data 값은 마스킹."""
    spec = KIND_MAP.get(kind)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"지원하지 않는 종류: {kind}")
    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)
    api = spec["api"](client)
    ns = None if namespace in ("-", "_cluster") else namespace
    try:
        obj = spec["read"](api, ns, name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"조회 실패: {str(e)[:200]}")

    data = client.sanitize_for_serialization(obj)
    # Secret data 마스킹 (보안)
    if kind == "secrets" and isinstance(data, dict) and isinstance(data.get("data"), dict):
        data["data"] = {k: "***REDACTED***" for k in data["data"].keys()}
    # managedFields 제거(노이즈)
    try:
        if isinstance(data.get("metadata"), dict):
            data["metadata"].pop("managedFields", None)
    except Exception:  # noqa: BLE001
        pass
    text = yaml.safe_dump(data, default_flow_style=False, allow_unicode=True, sort_keys=False)
    return {"kind": kind, "namespace": namespace, "name": name, "yaml": text}
