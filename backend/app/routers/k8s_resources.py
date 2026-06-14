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
}

# 쓰기 동작 권한 매트릭스 (UI 노출용 메타). 실제 가드는 엔드포인트 require_operator + kubeconfig RBAC.
SCALABLE_KINDS = {"deployments", "statefulsets"}
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
    return {"kind": kind, "namespace": namespace, "name": name, "yaml": text}


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
