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
from fastapi import APIRouter, Depends, HTTPException, Request
from kubernetes import client as k8s_client, config as k8s_config
from kubernetes.client.rest import ApiException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
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


def _node_summary(o) -> str:
    ready = "?"
    for c in (o.status.conditions or []) if o.status else []:
        if c.type == "Ready":
            ready = "Ready" if c.status == "True" else "NotReady"
            break
    ver = getattr(o.status.node_info, "kubelet_version", "") if (o.status and o.status.node_info) else ""
    sched = " · SchedulingDisabled" if (o.spec and o.spec.unschedulable) else ""
    return f"{ready} · {ver}{sched}".strip()


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
        "delete": lambda a, ns, n: a.delete_namespaced_deployment(n, ns),
        "patch": lambda a, ns, n, body: a.patch_namespaced_deployment(n, ns, body),
        "scale": lambda a, ns, n, body: a.patch_namespaced_deployment_scale(n, ns, body),
        "summary": _dep_summary,
    },
    "statefulsets": {
        "namespaced": True,
        "api": lambda c: k8s_client.AppsV1Api(c),
        "list_all": lambda a: a.list_stateful_set_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_stateful_set(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_stateful_set(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_stateful_set(n, ns),
        "patch": lambda a, ns, n, body: a.patch_namespaced_stateful_set(n, ns, body),
        "scale": lambda a, ns, n, body: a.patch_namespaced_stateful_set_scale(n, ns, body),
        "summary": _dep_summary,
    },
    "daemonsets": {
        "namespaced": True,
        "api": lambda c: k8s_client.AppsV1Api(c),
        "list_all": lambda a: a.list_daemon_set_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_daemon_set(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_daemon_set(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_daemon_set(n, ns),
        "patch": lambda a, ns, n, body: a.patch_namespaced_daemon_set(n, ns, body),
        "summary": lambda o: f"{(o.status.number_ready or 0)}/{(o.status.desired_number_scheduled or 0)} ready",
    },
    "services": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_service_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_service(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_service(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_service(n, ns),
        "summary": _svc_summary,
    },
    "ingresses": {
        "namespaced": True,
        "api": lambda c: k8s_client.NetworkingV1Api(c),
        "list_all": lambda a: a.list_ingress_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_ingress(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_ingress(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_ingress(n, ns),
        "summary": _ing_summary,
    },
    "configmaps": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_config_map_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_config_map(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_config_map(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_config_map(n, ns),
        "summary": lambda o: f"{len(o.data or {})} keys",
    },
    "secrets": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_secret_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_secret(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_secret(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_secret(n, ns),
        "summary": lambda o: f"{o.type} · {len(o.data or {})} keys",
    },
    "persistentvolumeclaims": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_persistent_volume_claim_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_persistent_volume_claim(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_persistent_volume_claim(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_persistent_volume_claim(n, ns),
        "summary": _pvc_summary,
    },
    "jobs": {
        "namespaced": True,
        "api": lambda c: k8s_client.BatchV1Api(c),
        "list_all": lambda a: a.list_job_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_job(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_job(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_job(n, ns, propagation_policy="Background"),
        "summary": lambda o: f"succeeded {(o.status.succeeded or 0)} / failed {(o.status.failed or 0)}",
    },
    "cronjobs": {
        "namespaced": True,
        "api": lambda c: k8s_client.BatchV1Api(c),
        "list_all": lambda a: a.list_cron_job_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_cron_job(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_cron_job(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_cron_job(n, ns),
        "summary": lambda o: f"schedule {o.spec.schedule}",
    },
    "pods": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_pod_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_pod(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_pod(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_pod(n, ns),
        "summary": _pod_summary,
    },
    # ── 클러스터 스코프 ──────────────────────────────────────────────────────
    "nodes": {
        "namespaced": False,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_node(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_node(n),
        "summary": _node_summary,
    },
    "namespaces": {
        "namespaced": False,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_namespace(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespace(n),
        "summary": lambda o: (o.status.phase if o.status else "-") or "-",
    },
    # ── Access Control (RBAC) — 읽기 전용 ────────────────────────────────────
    "serviceaccounts": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_service_account_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_service_account(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_service_account(n, ns),
        "summary": lambda o: f"{len(o.secrets or [])} secrets",
    },
    "roles": {
        "namespaced": True,
        "api": lambda c: k8s_client.RbacAuthorizationV1Api(c),
        "list_all": lambda a: a.list_role_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_role(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_role(n, ns),
        "summary": lambda o: f"{len(o.rules or [])} rules",
    },
    "rolebindings": {
        "namespaced": True,
        "api": lambda c: k8s_client.RbacAuthorizationV1Api(c),
        "list_all": lambda a: a.list_role_binding_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_role_binding(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_role_binding(n, ns),
        "summary": lambda o: f"→ {o.role_ref.kind}/{o.role_ref.name} · {len(o.subjects or [])} subj",
    },
    "clusterroles": {
        "namespaced": False,
        "api": lambda c: k8s_client.RbacAuthorizationV1Api(c),
        "list_all": lambda a: a.list_cluster_role(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_cluster_role(n),
        "summary": lambda o: f"{len(o.rules or [])} rules",
    },
    "clusterrolebindings": {
        "namespaced": False,
        "api": lambda c: k8s_client.RbacAuthorizationV1Api(c),
        "list_all": lambda a: a.list_cluster_role_binding(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_cluster_role_binding(n),
        "summary": lambda o: f"→ {o.role_ref.kind}/{o.role_ref.name} · {len(o.subjects or [])} subj",
    },
    # ── OpenLens 파리티 추가 종류 ────────────────────────────────────────────
    # Workloads
    "replicasets": {
        "namespaced": True,
        "api": lambda c: k8s_client.AppsV1Api(c),
        "list_all": lambda a: a.list_replica_set_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_replica_set(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_replica_set(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_replica_set(n, ns),
        "scale": lambda a, ns, n, body: a.patch_namespaced_replica_set_scale(n, ns, body),
        "summary": _dep_summary,
    },
    "replicationcontrollers": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_replication_controller_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_replication_controller(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_replication_controller(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_replication_controller(n, ns),
        "scale": lambda a, ns, n, body: a.patch_namespaced_replication_controller_scale(n, ns, body),
        "summary": _dep_summary,
    },
    # Config
    "resourcequotas": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_resource_quota_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_resource_quota(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_resource_quota(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_resource_quota(n, ns),
        "summary": lambda o: f"{len((o.spec.hard or {})) if o.spec else 0} hard limits",
    },
    "limitranges": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_limit_range_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_limit_range(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_limit_range(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_limit_range(n, ns),
        "summary": lambda o: f"{len((o.spec.limits or [])) if o.spec else 0} limits",
    },
    "horizontalpodautoscalers": {
        "namespaced": True,
        "api": lambda c: k8s_client.AutoscalingV1Api(c),
        "list_all": lambda a: a.list_horizontal_pod_autoscaler_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_horizontal_pod_autoscaler(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_horizontal_pod_autoscaler(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_horizontal_pod_autoscaler(n, ns),
        "summary": lambda o: f"{(o.status.current_replicas if o.status else 0)} → min {o.spec.min_replicas}/max {o.spec.max_replicas}",
    },
    "poddisruptionbudgets": {
        "namespaced": True,
        "api": lambda c: k8s_client.PolicyV1Api(c),
        "list_all": lambda a: a.list_pod_disruption_budget_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_pod_disruption_budget(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_pod_disruption_budget(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_pod_disruption_budget(n, ns),
        "summary": lambda o: f"min {getattr(o.spec, 'min_available', None)} / maxUnavail {getattr(o.spec, 'max_unavailable', None)}",
    },
    "priorityclasses": {
        "namespaced": False,
        "api": lambda c: k8s_client.SchedulingV1Api(c),
        "list_all": lambda a: a.list_priority_class(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_priority_class(n),
        "delete": lambda a, ns, n: a.delete_priority_class(n),
        "summary": lambda o: f"value {o.value}{' · global-default' if o.global_default else ''}",
    },
    # Network
    "endpoints": {
        "namespaced": True,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_endpoints_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_endpoints(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_endpoints(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_endpoints(n, ns),
        "summary": lambda o: f"{sum(len(s.addresses or []) for s in (o.subsets or []))} addresses",
    },
    "networkpolicies": {
        "namespaced": True,
        "api": lambda c: k8s_client.NetworkingV1Api(c),
        "list_all": lambda a: a.list_network_policy_for_all_namespaces(limit=_LIST_LIMIT),
        "list_ns": lambda a, ns: a.list_namespaced_network_policy(ns, limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_namespaced_network_policy(n, ns),
        "delete": lambda a, ns, n: a.delete_namespaced_network_policy(n, ns),
        "summary": lambda o: f"types {', '.join(o.spec.policy_types or []) if o.spec else '-'}",
    },
    "ingressclasses": {
        "namespaced": False,
        "api": lambda c: k8s_client.NetworkingV1Api(c),
        "list_all": lambda a: a.list_ingress_class(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_ingress_class(n),
        "delete": lambda a, ns, n: a.delete_ingress_class(n),
        "summary": lambda o: f"controller {o.spec.controller if o.spec else '-'}",
    },
    # Storage
    "persistentvolumes": {
        "namespaced": False,
        "api": lambda c: k8s_client.CoreV1Api(c),
        "list_all": lambda a: a.list_persistent_volume(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_persistent_volume(n),
        "delete": lambda a, ns, n: a.delete_persistent_volume(n),
        "summary": lambda o: f"{(o.status.phase if o.status else '-')} · {(o.spec.capacity or {}).get('storage','') if o.spec else ''} · {o.spec.storage_class_name if o.spec else ''}".strip(),
    },
    "storageclasses": {
        "namespaced": False,
        "api": lambda c: k8s_client.StorageV1Api(c),
        "list_all": lambda a: a.list_storage_class(limit=_LIST_LIMIT),
        "read": lambda a, ns, n: a.read_storage_class(n),
        "delete": lambda a, ns, n: a.delete_storage_class(n),
        "summary": lambda o: f"{o.provisioner}{' · default' if (o.metadata.annotations or {}).get('storageclass.kubernetes.io/is-default-class') == 'true' else ''}",
    },
}

# 쓰기 동작 권한 매트릭스 (UI 노출용 메타). 실제 가드는 엔드포인트 require_operator + kubeconfig RBAC.
SCALABLE_KINDS = {"deployments", "statefulsets", "replicasets", "replicationcontrollers"}
RESTARTABLE_KINDS = {"deployments", "statefulsets", "daemonsets"}


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
        if namespace and "list_ns" in spec:
            result = spec["list_ns"](api, namespace)
        else:
            result = spec["list_all"](api)
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
    sections = _build_detail_sections(kind, data)
    return {"kind": kind, "namespace": namespace, "name": name, "yaml": text, "sections": sections}


# ── 구조화 상세(sections) — Lens 식 "요약" 탭용 ─────────────────────────────────
# 프론트에 YAML 파서가 없으므로 백엔드가 읽기 쉬운 섹션을 만들어 내려준다.
# 섹션 형식: {"title", "type": "kv"|"list"|"text", "items"|"text"}
def _kv(items: list[tuple[str, Any]]) -> dict[str, Any]:
    return {"type": "kv", "items": [{"k": str(k), "v": "" if v is None else str(v)} for k, v in items if v not in (None, "")]}


def _build_detail_sections(kind: str, data: dict) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    sections: list[dict[str, Any]] = []
    meta = data.get("metadata", {}) or {}
    spec = data.get("spec", {}) or {}
    status = data.get("status", {}) or {}

    # 공통 메타데이터
    meta_kv = _kv([
        ("name", meta.get("name")),
        ("namespace", meta.get("namespace")),
        ("created", meta.get("creationTimestamp")),
        ("uid", meta.get("uid")),
    ])
    if meta_kv["items"]:
        sections.append({"title": "Metadata", **meta_kv})
    if isinstance(meta.get("labels"), dict) and meta["labels"]:
        sections.append({"title": "Labels", **_kv(list(meta["labels"].items()))})
    if isinstance(meta.get("annotations"), dict) and meta["annotations"]:
        # 너무 긴 annotation(last-applied 등)은 잘라서 노이즈 감소
        ann = {k: (v[:300] + "…" if isinstance(v, str) and len(v) > 300 else v) for k, v in meta["annotations"].items()}
        sections.append({"title": "Annotations", **_kv(list(ann.items()))})

    if kind == "configmaps":
        d = data.get("data") or {}
        if d:
            sections.append({"title": f"Data ({len(d)} keys)", "type": "kv",
                             "items": [{"k": k, "v": v if isinstance(v, str) else str(v)} for k, v in d.items()]})
        bd = data.get("binaryData") or {}
        if bd:
            sections.append({"title": f"BinaryData ({len(bd)} keys)", **_kv([(k, "<binary>") for k in bd])})
    elif kind == "secrets":
        d = data.get("data") or {}
        sections.append({"title": f"Data ({len(d)} keys)", "type": "kv",
                         "items": [{"k": k, "v": "***REDACTED***"} for k in d.keys()]})
        sections.insert(0, {"title": "Type", "type": "text", "text": str(data.get("type", "-"))})
    elif kind == "pods":
        sections.append({"title": "Status", **_kv([
            ("phase", status.get("phase")), ("podIP", status.get("podIP")),
            ("hostIP", status.get("hostIP")), ("node", spec.get("nodeName")),
            ("qosClass", status.get("qosClass")),
        ])})
        conts = spec.get("containers") or []
        cstat = {c.get("name"): c for c in (status.get("containerStatuses") or [])}
        rows = []
        for c in conts:
            st = cstat.get(c.get("name"), {})
            state = next(iter((st.get("state") or {}).keys()), "-")
            rows.append({"k": c.get("name", "?"), "v": f"{c.get('image','')} · {state} · restarts {st.get('restartCount', 0)} · ready {st.get('ready', False)}"})
        if rows:
            sections.append({"title": f"Containers ({len(rows)})", "type": "kv", "items": rows})
    elif kind == "services":
        ports = spec.get("ports") or []
        sections.append({"title": "Spec", **_kv([
            ("type", spec.get("type")), ("clusterIP", spec.get("clusterIP")),
            ("sessionAffinity", spec.get("sessionAffinity")),
        ])})
        if ports:
            sections.append({"title": "Ports", "type": "list",
                             "items": [f"{p.get('name','') } {p.get('port')}→{p.get('targetPort')}/{p.get('protocol','TCP')}".strip() for p in ports]})
        if isinstance(spec.get("selector"), dict) and spec["selector"]:
            sections.append({"title": "Selector", **_kv(list(spec["selector"].items()))})
    elif kind == "persistentvolumes":
        sections.append({"title": "Spec", **_kv([
            ("capacity", (spec.get("capacity") or {}).get("storage")),
            ("storageClass", spec.get("storageClassName")),
            ("accessModes", ", ".join(spec.get("accessModes") or [])),
            ("reclaimPolicy", spec.get("persistentVolumeReclaimPolicy")),
            ("phase", status.get("phase")),
            ("claim", f"{(spec.get('claimRef') or {}).get('namespace','')}/{(spec.get('claimRef') or {}).get('name','')}" if spec.get("claimRef") else None),
        ])})
    elif kind in ("deployments", "statefulsets", "daemonsets", "replicasets", "replicationcontrollers"):
        sections.append({"title": "Status", **_kv([
            ("replicas", spec.get("replicas")),
            ("ready", status.get("readyReplicas") or status.get("numberReady")),
            ("updated", status.get("updatedReplicas") or status.get("updatedNumberScheduled")),
            ("available", status.get("availableReplicas") or status.get("numberAvailable")),
            ("strategy", (spec.get("strategy") or spec.get("updateStrategy") or {}).get("type")),
        ])})
        tmpl = ((spec.get("template") or {}).get("spec") or {})
        imgs = [c.get("image") for c in (tmpl.get("containers") or []) if c.get("image")]
        if imgs:
            sections.append({"title": "Images", "type": "list", "items": imgs})
    elif kind == "nodes":
        ni = status.get("nodeInfo", {}) or {}
        sections.append({"title": "Info", **_kv([
            ("kubeletVersion", ni.get("kubeletVersion")), ("os", ni.get("osImage")),
            ("kernel", ni.get("kernelVersion")), ("runtime", ni.get("containerRuntimeVersion")),
            ("unschedulable", spec.get("unschedulable")),
        ])})
        cap = status.get("capacity", {}) or {}
        if cap:
            sections.append({"title": "Capacity", **_kv([("cpu", cap.get("cpu")), ("memory", cap.get("memory")), ("pods", cap.get("pods"))])})
        conds = [f"{c.get('type')}={c.get('status')}" for c in (status.get("conditions") or [])]
        if conds:
            sections.append({"title": "Conditions", "type": "list", "items": conds})

    return sections


# ── 쓰기 동작 (require_operator + 감사 로그) ─────────────────────────────────────
# 권한: viewer = 읽기 전용 → 아래 엔드포인트는 모두 403. admin/operator = 허용.
# 단, 실제 클러스터 동작은 kubeconfig 자체 RBAC 가 최종 권한 — apiserver 403 은 구분 메시지로 노출.

REDACTED_SENTINEL = "***REDACTED***"


def _raise_k8s_write(e: Exception, action: str) -> None:
    """apiserver 예외를 사용자 친화적 HTTP 에러로 변환. kubeconfig RBAC 403 을 구분."""
    if isinstance(e, ApiException):
        reason = ""
        try:
            import json
            body = json.loads(e.body) if e.body else {}
            reason = body.get("message", "") or ""
        except Exception:  # noqa: BLE001
            reason = (e.reason or "")
        if e.status == 403:
            raise HTTPException(
                status_code=403,
                detail=f"kubeconfig 권한 부족 — 클러스터 RBAC 를 확인하세요 ({action}). {reason[:160]}",
            )
        if e.status == 404:
            raise HTTPException(status_code=404, detail=f"대상을 찾을 수 없습니다 ({action}).")
        if e.status == 409:
            raise HTTPException(status_code=409, detail=f"충돌(conflict) — 최신 상태로 다시 시도하세요 ({action}). {reason[:160]}")
        if e.status == 422:
            raise HTTPException(status_code=422, detail=f"유효성 오류 ({action}): {reason[:200]}")
        raise HTTPException(status_code=502, detail=f"{action} 실패: {reason[:200] or str(e)[:200]}")
    raise HTTPException(status_code=502, detail=f"{action} 실패: {str(e)[:200]}")


def _spec_or_404(kind: str) -> dict[str, Any]:
    spec = KIND_MAP.get(kind)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"지원하지 않는 종류: {kind}")
    return spec


class ScaleRequest(BaseModel):
    replicas: int


class ApplyRequest(BaseModel):
    yaml: str


class CordonRequest(BaseModel):
    unschedulable: bool = True


@router.post("/{cluster_id}/resources/{kind}/{namespace}/{name}/scale")
def scale_resource(
    cluster_id: UUID,
    kind: str,
    namespace: str,
    name: str,
    payload: ScaleRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Deployment / StatefulSet 의 replicas 를 조정한다."""
    spec = _spec_or_404(kind)
    if kind not in SCALABLE_KINDS or "scale" not in spec:
        raise HTTPException(status_code=400, detail=f"{kind} 은 scale 을 지원하지 않습니다.")
    if payload.replicas < 0:
        raise HTTPException(status_code=422, detail="replicas 는 0 이상이어야 합니다.")
    cluster = _require_cluster(cluster_id, db)
    api = spec["api"](_api_client(cluster))
    body = {"spec": {"replicas": payload.replicas}}
    try:
        spec["scale"](api, namespace, name, body)
    except Exception as e:  # noqa: BLE001
        audit_logger.record(db, action="k8s.scale", actor=actor, status="failure",
                            target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                            details={"cluster_id": str(cluster_id), "replicas": payload.replicas, "error": str(e)[:200]},
                            request=request)
        _raise_k8s_write(e, "scale")
    audit_logger.record(db, action="k8s.scale", actor=actor, status="success",
                        target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                        details={"cluster_id": str(cluster_id), "cluster": cluster.name, "replicas": payload.replicas},
                        request=request)
    return {"ok": True, "kind": kind, "namespace": namespace, "name": name, "replicas": payload.replicas}


@router.post("/{cluster_id}/resources/{kind}/{namespace}/{name}/restart")
def restart_resource(
    cluster_id: UUID,
    kind: str,
    namespace: str,
    name: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Deployment / StatefulSet / DaemonSet 의 rollout restart (kubectl rollout restart 와 동일)."""
    spec = _spec_or_404(kind)
    if kind not in RESTARTABLE_KINDS or "patch" not in spec:
        raise HTTPException(status_code=400, detail=f"{kind} 은 restart 를 지원하지 않습니다.")
    cluster = _require_cluster(cluster_id, db)
    api = spec["api"](_api_client(cluster))
    now = datetime.now(timezone.utc).isoformat()
    body = {"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": now}}}}}
    try:
        spec["patch"](api, namespace, name, body)
    except Exception as e:  # noqa: BLE001
        audit_logger.record(db, action="k8s.restart", actor=actor, status="failure",
                            target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                            details={"cluster_id": str(cluster_id), "error": str(e)[:200]}, request=request)
        _raise_k8s_write(e, "restart")
    audit_logger.record(db, action="k8s.restart", actor=actor, status="success",
                        target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                        details={"cluster_id": str(cluster_id), "cluster": cluster.name}, request=request)
    return {"ok": True, "kind": kind, "namespace": namespace, "name": name, "restartedAt": now}


@router.delete("/{cluster_id}/resources/{kind}/{namespace}/{name}")
def delete_resource(
    cluster_id: UUID,
    kind: str,
    namespace: str,
    name: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """단일 리소스를 삭제한다."""
    spec = _spec_or_404(kind)
    if "delete" not in spec:
        raise HTTPException(status_code=400, detail=f"{kind} 은 삭제를 지원하지 않습니다.")
    cluster = _require_cluster(cluster_id, db)
    api = spec["api"](_api_client(cluster))
    ns = None if namespace in ("-", "_cluster") else namespace
    try:
        spec["delete"](api, ns, name)
    except Exception as e:  # noqa: BLE001
        audit_logger.record(db, action="k8s.delete", actor=actor, status="failure",
                            target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                            details={"cluster_id": str(cluster_id), "error": str(e)[:200]}, request=request)
        _raise_k8s_write(e, "delete")
    audit_logger.record(db, action="k8s.delete", actor=actor, status="success",
                        target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                        details={"cluster_id": str(cluster_id), "cluster": cluster.name}, request=request)
    return {"ok": True, "kind": kind, "namespace": namespace, "name": name}


@router.put("/{cluster_id}/resources/{kind}/{namespace}/{name}/yaml")
def apply_resource_yaml(
    cluster_id: UUID,
    kind: str,
    namespace: str,
    name: str,
    payload: ApplyRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """편집된 YAML 을 적용한다 (read → replace, resourceVersion 보존).

    Secret 의 경우 마스킹 sentinel 이 남아있으면 거부 — 실데이터 덮어쓰기 방지.
    """
    spec = _spec_or_404(kind)
    if "read" not in spec:
        raise HTTPException(status_code=400, detail=f"{kind} 은 적용을 지원하지 않습니다.")
    try:
        new_obj = yaml.safe_load(payload.yaml)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"YAML 파싱 실패: {str(e)[:200]}")
    if not isinstance(new_obj, dict) or not new_obj.get("kind"):
        raise HTTPException(status_code=422, detail="유효한 K8s 오브젝트 YAML 이 아닙니다.")

    # Secret 마스킹 sentinel 가드 — 마스킹된 값을 그대로 적용하지 못하게 함.
    if kind == "secrets":
        data_block = new_obj.get("data") or {}
        if any(v == REDACTED_SENTINEL for v in data_block.values()):
            raise HTTPException(
                status_code=422,
                detail="마스킹된 Secret 값(***REDACTED***)은 적용할 수 없습니다. 실제 값으로 교체하거나 해당 키를 제거하세요.",
            )

    cluster = _require_cluster(cluster_id, db)
    api = spec["api"](_api_client(cluster))
    ns = None if namespace in ("-", "_cluster") else namespace

    # read → resourceVersion 주입 → replace (optimistic concurrency)
    try:
        current = spec["read"](api, ns, name)
        rv = current.metadata.resource_version
        meta = new_obj.setdefault("metadata", {})
        meta["resourceVersion"] = rv
        # 일부 read-only 필드 제거 (충돌 방지)
        meta.pop("managedFields", None)
        new_obj.pop("status", None)
        replace_fn = getattr(api, _replace_method_name(api, kind), None)
        if replace_fn is None:
            raise HTTPException(status_code=400, detail=f"{kind} 은 적용(replace)을 지원하지 않습니다.")
        if ns is None:
            replace_fn(name, new_obj)
        else:
            replace_fn(name, ns, new_obj)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        audit_logger.record(db, action="k8s.apply", actor=actor, status="failure",
                            target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                            details={"cluster_id": str(cluster_id), "error": str(e)[:200]}, request=request)
        _raise_k8s_write(e, "apply")
    audit_logger.record(db, action="k8s.apply", actor=actor, status="success",
                        target_type="k8s", target_id=f"{kind}/{namespace}/{name}",
                        details={"cluster_id": str(cluster_id), "cluster": cluster.name}, request=request)
    return {"ok": True, "kind": kind, "namespace": namespace, "name": name}


# replace 메서드명 매핑 (kind → SDK replace_* 메서드).
_REPLACE_METHODS = {
    "deployments": "replace_namespaced_deployment",
    "statefulsets": "replace_namespaced_stateful_set",
    "daemonsets": "replace_namespaced_daemon_set",
    "services": "replace_namespaced_service",
    "ingresses": "replace_namespaced_ingress",
    "configmaps": "replace_namespaced_config_map",
    "secrets": "replace_namespaced_secret",
    "persistentvolumeclaims": "replace_namespaced_persistent_volume_claim",
    "jobs": "replace_namespaced_job",
    "cronjobs": "replace_namespaced_cron_job",
    "pods": "replace_namespaced_pod",
    "replicasets": "replace_namespaced_replica_set",
    "replicationcontrollers": "replace_namespaced_replication_controller",
    "resourcequotas": "replace_namespaced_resource_quota",
    "limitranges": "replace_namespaced_limit_range",
    "horizontalpodautoscalers": "replace_namespaced_horizontal_pod_autoscaler",
    "poddisruptionbudgets": "replace_namespaced_pod_disruption_budget",
    "networkpolicies": "replace_namespaced_network_policy",
    "persistentvolumes": "replace_persistent_volume",
    "storageclasses": "replace_storage_class",
}


def _replace_method_name(api: Any, kind: str) -> Optional[str]:
    name = _REPLACE_METHODS.get(kind)
    if name and hasattr(api, name):
        return name
    return None


# ── 노드 cordon / drain ──────────────────────────────────────────────────────
@router.post("/{cluster_id}/nodes/{name}/cordon")
def cordon_node(
    cluster_id: UUID,
    name: str,
    payload: CordonRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """노드를 cordon(스케줄 차단) / uncordon 한다."""
    cluster = _require_cluster(cluster_id, db)
    v1 = k8s_client.CoreV1Api(_api_client(cluster))
    body = {"spec": {"unschedulable": payload.unschedulable}}
    try:
        v1.patch_node(name, body)
    except Exception as e:  # noqa: BLE001
        audit_logger.record(db, action="k8s.cordon", actor=actor, status="failure",
                            target_type="k8s.node", target_id=name,
                            details={"cluster_id": str(cluster_id), "unschedulable": payload.unschedulable, "error": str(e)[:200]},
                            request=request)
        _raise_k8s_write(e, "cordon")
    audit_logger.record(db, action="k8s.cordon", actor=actor, status="success",
                        target_type="k8s.node", target_id=name,
                        details={"cluster_id": str(cluster_id), "cluster": cluster.name, "unschedulable": payload.unschedulable},
                        request=request)
    return {"ok": True, "node": name, "unschedulable": payload.unschedulable}


@router.post("/{cluster_id}/nodes/{name}/drain")
def drain_node(
    cluster_id: UUID,
    name: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """노드를 cordon 후, DaemonSet/mirror 파드를 제외하고 파드를 eviction 한다 (best-effort, PDB 존중)."""
    cluster = _require_cluster(cluster_id, db)
    v1 = k8s_client.CoreV1Api(_api_client(cluster))
    # 1) cordon
    try:
        v1.patch_node(name, {"spec": {"unschedulable": True}})
    except Exception as e:  # noqa: BLE001
        _raise_k8s_write(e, "drain(cordon)")
    # 2) 노드의 파드 나열
    try:
        pods = v1.list_pod_for_all_namespaces(field_selector=f"spec.nodeName={name}")
    except Exception as e:  # noqa: BLE001
        _raise_k8s_write(e, "drain(list pods)")

    evicted: list[str] = []
    skipped: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    for p in (pods.items or []):
        ns = p.metadata.namespace
        pod_name = p.metadata.name
        owners = p.metadata.owner_references or []
        # DaemonSet 소유 파드는 건너뜀
        if any(o.kind == "DaemonSet" for o in owners):
            skipped.append({"pod": f"{ns}/{pod_name}", "reason": "DaemonSet"})
            continue
        # mirror 파드(static)는 건너뜀
        if (p.metadata.annotations or {}).get("kubernetes.io/config.mirror"):
            skipped.append({"pod": f"{ns}/{pod_name}", "reason": "mirror"})
            continue
        eviction = k8s_client.V1Eviction(
            metadata=k8s_client.V1ObjectMeta(name=pod_name, namespace=ns),
        )
        try:
            v1.create_namespaced_pod_eviction(name=pod_name, namespace=ns, body=eviction)
            evicted.append(f"{ns}/{pod_name}")
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if isinstance(e, ApiException) and e.status == 429:
                msg = "PDB 로 인해 차단됨(429)"
            errors.append({"pod": f"{ns}/{pod_name}", "error": msg[:160]})

    status_val = "success" if not errors else "partial"
    audit_logger.record(db, action="k8s.drain", actor=actor, status=status_val,
                        target_type="k8s.node", target_id=name,
                        details={"cluster_id": str(cluster_id), "cluster": cluster.name,
                                 "evicted": len(evicted), "skipped": len(skipped), "errors": len(errors)},
                        request=request)
    return {
        "ok": not errors,
        "node": name,
        "evicted": evicted,
        "skipped": skipped,
        "errors": errors,
    }


# ── Custom Resources (CRD) — 동적 탐색, 읽기 전용 ────────────────────────────
@router.get("/{cluster_id}/crds")
def list_crds(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터에 설치된 CRD 목록(group/version/plural/kind/scope)."""
    cluster = _require_cluster(cluster_id, db)
    ext = k8s_client.ApiextensionsV1Api(_api_client(cluster))
    try:
        result = ext.list_custom_resource_definition(limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"CRD 조회 실패: {str(e)[:200]}")
    items = []
    for crd in (result.items or []):
        spec = crd.spec
        served = [v.name for v in (spec.versions or []) if getattr(v, "served", False)]
        items.append({
            "name": crd.metadata.name,
            "group": spec.group,
            "kind": spec.names.kind,
            "plural": spec.names.plural,
            "scope": spec.scope,  # Namespaced | Cluster
            "versions": served,
            "version": served[0] if served else (spec.versions[0].name if spec.versions else ""),
            "age_seconds": _age_seconds(crd.metadata),
        })
    items.sort(key=lambda x: (x["group"] or "", x["kind"]))
    return {"count": len(items), "items": items}


@router.get("/{cluster_id}/crds/{group}/{version}/{plural}")
def list_custom_objects(
    cluster_id: UUID,
    group: str,
    version: str,
    plural: str,
    namespace: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """특정 CRD 의 커스텀 오브젝트 목록."""
    cluster = _require_cluster(cluster_id, db)
    co = k8s_client.CustomObjectsApi(_api_client(cluster))
    try:
        if namespace:
            res = co.list_namespaced_custom_object(group, version, namespace, plural, limit=_LIST_LIMIT)
        else:
            res = co.list_cluster_custom_object(group, version, plural, limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"커스텀 오브젝트 조회 실패: {str(e)[:200]}")
    rows: list[ResourceRow] = []
    for o in (res.get("items") or []):
        meta = o.get("metadata", {})
        status = o.get("status", {})
        phase = status.get("phase") or status.get("state") or ""
        rows.append(ResourceRow(
            name=meta.get("name", ""),
            namespace=meta.get("namespace"),
            summary=str(phase),
            age_seconds=None,
        ))
    rows.sort(key=lambda r: (r.namespace or "", r.name))
    truncated = bool(res.get("metadata", {}).get("continue"))
    return ResourceListResponse(kind=plural, count=len(rows), truncated=truncated, items=rows)


@router.get("/{cluster_id}/crds/{group}/{version}/{plural}/{namespace}/{name}/yaml")
def get_custom_object_yaml(
    cluster_id: UUID,
    group: str,
    version: str,
    plural: str,
    namespace: str,
    name: str,
    db: Session = Depends(get_db),
):
    """단일 커스텀 오브젝트 YAML (읽기 전용)."""
    cluster = _require_cluster(cluster_id, db)
    co = k8s_client.CustomObjectsApi(_api_client(cluster))
    ns = None if namespace in ("-", "_cluster") else namespace
    try:
        if ns:
            obj = co.get_namespaced_custom_object(group, version, ns, plural, name)
        else:
            obj = co.get_cluster_custom_object(group, version, plural, name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"조회 실패: {str(e)[:200]}")
    if isinstance(obj, dict):
        try:
            obj.get("metadata", {}).pop("managedFields", None)
        except Exception:  # noqa: BLE001
            pass
    text = yaml.safe_dump(obj, default_flow_style=False, allow_unicode=True, sort_keys=False)
    return {"kind": plural, "namespace": namespace, "name": name, "yaml": text}


# ── 쓰기 가능 종류 메타데이터 (UI 노출용) ───────────────────────────────────────
@router.get("/{cluster_id}/resources-capabilities")
def resource_capabilities(cluster_id: UUID):
    """각 종류별 지원 동작 — 프론트 액션 버튼 노출 판단용."""
    caps: dict[str, dict[str, bool]] = {}
    for k, spec in KIND_MAP.items():
        caps[k] = {
            "scalable": k in SCALABLE_KINDS,
            "restartable": k in RESTARTABLE_KINDS,
            "deletable": "delete" in spec,
            "editable": "read" in spec and k in _REPLACE_METHODS,
            "namespaced": bool(spec.get("namespaced", True)),
        }
    return {"capabilities": caps}


# ── Nodes (rich) — Lens 식 컬럼 (Roles/Version/Taints/CPU/Memory/Conditions) ────
_MASTER_ROLE_KEYS = ("node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master")


class NodeRichRow(BaseModel):
    name: str
    roles: list[str]
    version: Optional[str] = None
    taints: int = 0
    conditions: list[str] = []
    cpu_capacity: Optional[str] = None
    mem_capacity: Optional[str] = None
    cpu_usage: Optional[str] = None
    mem_usage: Optional[str] = None
    unschedulable: bool = False
    age_seconds: Optional[int] = None


@router.get("/{cluster_id}/nodes")
def list_nodes_rich(cluster_id: UUID, db: Session = Depends(get_db)):
    """노드 목록 — Lens 대등 컬럼. usage 는 metrics-server 가용 시 best-effort."""
    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)
    v1 = k8s_client.CoreV1Api(client)
    try:
        nodes = v1.list_node(limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"노드 조회 실패: {str(e)[:200]}")

    # usage (metrics-server) — 없으면 생략
    usage: dict[str, dict] = {}
    try:
        co = k8s_client.CustomObjectsApi(client)
        m = co.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
        for it in (m.get("items") or []):
            usage[it.get("metadata", {}).get("name", "")] = it.get("usage", {}) or {}
    except Exception:  # noqa: BLE001
        usage = {}

    rows: list[NodeRichRow] = []
    for n in (nodes.items or []):
        labels = n.metadata.labels or {}
        roles: list[str] = []
        if any(k in labels for k in _MASTER_ROLE_KEYS):
            roles.append("control-plane")
        for k in labels:
            if k.startswith("node-role.kubernetes.io/") and k not in _MASTER_ROLE_KEYS:
                r = k.split("/", 1)[1]
                if r and r not in roles:
                    roles.append(r)
        if not roles:
            roles.append("worker")

        conds: list[str] = []
        for c in (n.status.conditions or []) if n.status else []:
            if c.type == "Ready":
                conds.insert(0, "Ready" if c.status == "True" else "NotReady")
            elif c.status == "True" and c.type.endswith("Pressure"):
                conds.append(c.type)

        cap = (n.status.capacity or {}) if n.status else {}
        u = usage.get(n.metadata.name, {})
        ni = n.status.node_info if (n.status and n.status.node_info) else None
        rows.append(NodeRichRow(
            name=n.metadata.name,
            roles=sorted(set(roles)),
            version=getattr(ni, "kubelet_version", None),
            taints=len(n.spec.taints or []) if n.spec else 0,
            conditions=conds or ["?"],
            cpu_capacity=cap.get("cpu"),
            mem_capacity=cap.get("memory"),
            cpu_usage=u.get("cpu"),
            mem_usage=u.get("memory"),
            unschedulable=bool(n.spec.unschedulable) if n.spec else False,
            age_seconds=_age_seconds(n.metadata),
        ))
    rows.sort(key=lambda r: r.name)
    return {"count": len(rows), "items": rows, "metrics_available": bool(usage)}


# ── Pods (rich) — Lens 식 컬럼 (Containers 색칸/Controlled By/Node/QoS/Status) ──
class PodContainerCell(BaseModel):
    name: str
    color: str  # green | amber | red | gray
    state: str
    reason: Optional[str] = None


class PodRichRow(BaseModel):
    name: str
    namespace: Optional[str] = None
    containers: list[PodContainerCell] = []
    ready: str = ""          # "2/3"
    restarts: int = 0
    controlled_by: Optional[str] = None
    node: Optional[str] = None
    qos: Optional[str] = None
    phase: str = "-"
    status_color: str = "gray"  # green | amber | red | gray
    age_seconds: Optional[int] = None


def _container_cell(cs) -> PodContainerCell:
    """컨테이너 상태 → 색칸 (Lens 스타일)."""
    name = cs.name
    state = cs.state
    ready = bool(cs.ready)
    if state and state.running:
        return PodContainerCell(name=name, color=("green" if ready else "amber"), state="running")
    if state and state.waiting:
        reason = state.waiting.reason or "Waiting"
        bad = any(x in reason for x in ("CrashLoop", "Error", "ImagePull", "InvalidImageName", "CreateContainer"))
        return PodContainerCell(name=name, color=("red" if bad else "amber"), state="waiting", reason=reason)
    if state and state.terminated:
        t = state.terminated
        ok = (t.exit_code == 0)
        return PodContainerCell(name=name, color=("gray" if ok else "red"), state="terminated", reason=t.reason)
    return PodContainerCell(name=name, color="gray", state="unknown")


def _pod_status_color(phase: str, cells: list[PodContainerCell]) -> str:
    if any(c.color == "red" for c in cells):
        return "red"
    if phase == "Running" and all(c.color in ("green", "gray") for c in cells):
        return "green"
    if phase in ("Succeeded",):
        return "green"
    if phase in ("Pending",) or any(c.color == "amber" for c in cells):
        return "amber"
    if phase in ("Failed", "Unknown"):
        return "red"
    return "gray"


@router.get("/{cluster_id}/pods")
def list_pods_rich(cluster_id: UUID, namespace: Optional[str] = None, db: Session = Depends(get_db)):
    """파드 목록 — Lens 대등 컬럼 (컨테이너 색칸/재시작/소유자/노드/QoS/상태)."""
    cluster = _require_cluster(cluster_id, db)
    v1 = k8s_client.CoreV1Api(_api_client(cluster))
    try:
        res = v1.list_namespaced_pod(namespace, limit=_LIST_LIMIT) if namespace else v1.list_pod_for_all_namespaces(limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        code = 504 if "timeout" in str(e).lower() else 502
        raise HTTPException(status_code=code, detail=f"파드 조회 실패: {str(e)[:200]}")

    rows: list[PodRichRow] = []
    for p in (res.items or []):
        st = p.status
        cstats = (st.container_statuses or []) if st else []
        cells = [_container_cell(cs) for cs in cstats]
        # 컨테이너 상태가 아직 없으면 spec 기준 회색칸
        if not cells and p.spec and p.spec.containers:
            cells = [PodContainerCell(name=c.name, color="gray", state="pending") for c in p.spec.containers]
        ready_n = sum(1 for cs in cstats if cs.ready)
        total = len(p.spec.containers or []) if p.spec else len(cells)
        restarts = sum((cs.restart_count or 0) for cs in cstats)
        owners = p.metadata.owner_references or []
        controlled = f"{owners[0].kind}/{owners[0].name}" if owners else None
        phase = (st.phase if st else "-") or "-"
        # 종료/대기 사유를 phase 에 보강 (예: CrashLoopBackOff)
        bad_reason = next((c.reason for c in cells if c.color == "red" and c.reason), None)
        rows.append(PodRichRow(
            name=p.metadata.name,
            namespace=p.metadata.namespace,
            containers=cells,
            ready=f"{ready_n}/{total}",
            restarts=restarts,
            controlled_by=controlled,
            node=p.spec.node_name if p.spec else None,
            qos=(st.qos_class if st else None),
            phase=(bad_reason or phase),
            status_color=_pod_status_color(phase, cells),
            age_seconds=_age_seconds(p.metadata),
        ))
    rows.sort(key=lambda r: (r.namespace or "", r.name))
    truncated = (res.metadata._continue is not None) if res.metadata else False
    return {"count": len(rows), "truncated": truncated, "items": rows}


# ── 종류 가용성 — 클러스터에 실제 존재(≥1)/지원하는 종류만 UI 노출용 ───────────
@router.get("/{cluster_id}/kind-availability")
def kind_availability(cluster_id: UUID, db: Session = Depends(get_db)):
    """각 KIND 별 available(API 지원) / present(≥1개 존재) 를 병렬 프로브.

    프론트는 present=False(또는 available=False) 종류를 nav 에서 숨겨 클러스터에
    실제 있는 것만 보여준다. 프로브 실패 시(전체 에러) 프론트는 전체 노출로 폴백.
    """
    from concurrent.futures import ThreadPoolExecutor

    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)

    def _probe(kind: str) -> tuple[str, dict]:
        spec = KIND_MAP[kind]
        try:
            api = spec["api"](client)
            res = spec["list_all"](api)
            items = res.items or []
            more = bool(res.metadata._continue) if getattr(res, "metadata", None) else False
            return kind, {"available": True, "present": (len(items) > 0) or more, "count": len(items), "truncated": more}
        except ApiException as e:
            # 404/NotFound = 해당 API 미지원 → unavailable
            avail = e.status not in (404,)
            return kind, {"available": avail, "present": False, "count": 0, "truncated": False}
        except Exception:  # noqa: BLE001
            return kind, {"available": True, "present": False, "count": 0, "truncated": False}

    out: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for kind, info in ex.map(_probe, list(KIND_MAP.keys())):
            out[kind] = info
    return {"kinds": out}
