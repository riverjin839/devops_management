"""K8s 자원 관리 — 노드 allocatable 대비 request/사용량(slack) 가시화.

운영 목적: 노드 CPU/MEM 은 여유가 있는데 파드 request 가 과대 설정(slack)되어
스케줄러가 "꽉 찼다"고 판단 → 노드 낭비. 이를 **노드 / 네임스페이스 / 워크로드 /
파드** 단위로 드릴다운하며 request 과대·미설정 범인을 찾는다.

모두 **읽기 전용 라이브 조회** — DB 모델/마이그레이션 없음. K8s API LIST +
metrics-server(`metrics.k8s.io/v1beta1`) 를 매 요청마다 수집한다. metrics-server 가
없으면 usage 는 null 이고 `metrics_available=False` 로 graceful degrade.

수량 파싱은 SDK 내장 `kubernetes.utils.parse_quantity` 재사용(커스텀 파서 금지).
CPU 는 millicores(int), MEM 은 bytes(int) 로 정규화해 계산하고, 표시는 `*_display`.
공용 헬퍼(`_api_client`/`_require_cluster`/`_age_seconds`/`_LIST_LIMIT`)는
`k8s_resources` 에서 재사용한다.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from kubernetes import client as k8s_client
from kubernetes.utils import parse_quantity
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.k8s_resources import (
    _LIST_LIMIT,
    _api_client,
    _require_cluster,
)
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k8s-allocation"])

# 비종료 파드(자원을 점유)만 집계 대상.
_ACTIVE_PHASES = {"Running", "Pending"}
_MASTER_ROLE_KEYS = (
    "node-role.kubernetes.io/master",
    "node-role.kubernetes.io/control-plane",
)


# ── 수량 파싱/표시 ──────────────────────────────────────────────────────────────
def _cpu_m(v) -> int:
    """CPU 수량 문자열 → millicores(int). 빈 값/파싱 실패 시 0."""
    if not v:
        return 0
    try:
        return int(Decimal(parse_quantity(v)) * 1000)
    except Exception:  # noqa: BLE001
        return 0


def _mem_b(v) -> int:
    """메모리 수량 문자열 → bytes(int). 빈 값/파싱 실패 시 0."""
    if not v:
        return 0
    try:
        return int(Decimal(parse_quantity(v)))
    except Exception:  # noqa: BLE001
        return 0


def _fmt_cpu(m: int) -> str:
    """millicores → 사람이 읽는 문자열 ('1.5' / '500m')."""
    if m <= 0:
        return "0"
    if m >= 1000:
        return f"{m / 1000:.2f}".rstrip("0").rstrip(".")
    return f"{m}m"


def _fmt_mem(b: int) -> str:
    """bytes → 사람이 읽는 문자열 (Ki/Mi/Gi/Ti)."""
    if b <= 0:
        return "0"
    units = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"]
    f = float(b)
    i = 0
    while f >= 1024 and i < len(units) - 1:
        f /= 1024
        i += 1
    return f"{f:.1f}".rstrip("0").rstrip(".") + units[i]


# ── 컨테이너 자원 합산 ───────────────────────────────────────────────────────────
def _sum_resources(containers) -> tuple[int, int, int, int]:
    """컨테이너 목록 → (req_cpu_m, req_mem_b, lim_cpu_m, lim_mem_b)."""
    rc = rm = lc = lm = 0
    for c in containers or []:
        res = getattr(c, "resources", None)
        if not res:
            continue
        req = res.requests or {}
        lim = res.limits or {}
        rc += _cpu_m(req.get("cpu"))
        rm += _mem_b(req.get("memory"))
        lc += _cpu_m(lim.get("cpu"))
        lm += _mem_b(lim.get("memory"))
    return rc, rm, lc, lm


def _node_roles(labels: dict) -> list[str]:
    roles: list[str] = []
    if any(k in labels for k in _MASTER_ROLE_KEYS):
        roles.append("control-plane")
    for k in labels:
        if k.startswith("node-role.kubernetes.io/") and k not in _MASTER_ROLE_KEYS:
            r = k.split("/", 1)[1]
            if r and r not in roles:
                roles.append(r)
    return sorted(set(roles)) or ["worker"]


# ── metrics-server 수집 ──────────────────────────────────────────────────────────
def _node_usage(client) -> dict[str, tuple[int, int]]:
    """노드 usage 맵 {node: (cpu_m, mem_b)}. metrics-server 없으면 빈 dict."""
    out: dict[str, tuple[int, int]] = {}
    try:
        co = k8s_client.CustomObjectsApi(client)
        m = co.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
        for it in (m.get("items") or []):
            name = (it.get("metadata") or {}).get("name", "")
            u = it.get("usage") or {}
            out[name] = (_cpu_m(u.get("cpu")), _mem_b(u.get("memory")))
    except Exception:  # noqa: BLE001
        pass
    return out


def _pod_usage(client, namespace: Optional[str] = None) -> dict[tuple[str, str], dict]:
    """파드 usage 맵 {(ns,pod): {'cpu','mem','containers':{c:(cpu,mem)}}}.

    namespace 지정 시 해당 NS 만(드릴다운), 없으면 전체 클러스터.
    metrics-server 없으면 빈 dict.
    """
    out: dict[tuple[str, str], dict] = {}
    try:
        co = k8s_client.CustomObjectsApi(client)
        if namespace:
            m = co.list_namespaced_custom_object(
                "metrics.k8s.io", "v1beta1", namespace, "pods"
            )
        else:
            m = co.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods")
        for it in (m.get("items") or []):
            meta = it.get("metadata") or {}
            ns = meta.get("namespace", "")
            name = meta.get("name", "")
            cpu = mem = 0
            cmap: dict[str, tuple[int, int]] = {}
            for c in (it.get("containers") or []):
                u = c.get("usage") or {}
                ccpu, cmem = _cpu_m(u.get("cpu")), _mem_b(u.get("memory"))
                cpu += ccpu
                mem += cmem
                cmap[c.get("name", "")] = (ccpu, cmem)
            out[(ns, name)] = {"cpu": cpu, "mem": mem, "containers": cmap}
    except Exception:  # noqa: BLE001
        pass
    return out


# ── ownerRef 최상위 워크로드 귀속 ─────────────────────────────────────────────────
def _direct_owner(meta) -> tuple[Optional[str], Optional[str]]:
    refs = getattr(meta, "owner_references", None) or []
    for o in refs:
        if getattr(o, "controller", False):
            return o.kind, o.name
    if refs:
        return refs[0].kind, refs[0].name
    return None, None


def _build_rs_owner_map(apps_api, namespace: Optional[str]) -> dict[tuple[str, str], tuple[str, str]]:
    """ReplicaSet → 상위(Deployment) 귀속 맵 {(ns,rs): (kind,name)}."""
    out: dict[tuple[str, str], tuple[str, str]] = {}
    try:
        if namespace:
            rss = apps_api.list_namespaced_replica_set(namespace, limit=_LIST_LIMIT)
        else:
            rss = apps_api.list_replica_set_for_all_namespaces(limit=_LIST_LIMIT)
        for rs in (rss.items or []):
            ns = rs.metadata.namespace
            ok, on = _direct_owner(rs.metadata)
            out[(ns, rs.metadata.name)] = (ok or "ReplicaSet", on or rs.metadata.name)
    except Exception:  # noqa: BLE001
        pass
    return out


def _top_owner(pod, rs_map: dict) -> tuple[str, str]:
    """파드 → 최상위 워크로드 (kind, name). 컨트롤러 없으면 ('Pod', podname)."""
    ns = pod.metadata.namespace
    kind, name = _direct_owner(pod.metadata)
    if kind is None:
        return "Pod", pod.metadata.name
    if kind == "ReplicaSet":
        return rs_map.get((ns, name), ("ReplicaSet", name))
    return kind, name


# ── 응답 모델 ────────────────────────────────────────────────────────────────────
class NodeAllocRow(BaseModel):
    name: str
    roles: list[str] = []
    unschedulable: bool = False
    pod_count: int = 0
    cpu_alloc_m: int = 0
    mem_alloc_b: int = 0
    cpu_capacity_m: int = 0
    mem_capacity_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_slack_m: int = 0          # alloc - requests
    mem_slack_b: int = 0
    cpu_alloc_display: str = "0"
    mem_alloc_display: str = "0"
    cpu_usage_display: Optional[str] = None
    mem_usage_display: Optional[str] = None
    cpu_req_display: str = "0"
    mem_req_display: str = "0"
    cpu_lim_display: str = "0"
    mem_lim_display: str = "0"


class AllocSummary(BaseModel):
    node_count: int = 0
    pod_count: int = 0
    cpu_alloc_m: int = 0
    mem_alloc_b: int = 0
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    no_request_pods: int = 0   # BestEffort/Burstable 중 request 0 인 파드 수


class NamespaceAllocRow(BaseModel):
    namespace: str
    pod_count: int = 0
    workload_count: int = 0
    no_request_pods: int = 0
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    cpu_req_display: str = "0"
    mem_req_display: str = "0"
    cpu_usage_display: Optional[str] = None
    mem_usage_display: Optional[str] = None


class WorkloadAllocRow(BaseModel):
    namespace: str
    kind: str
    name: str
    pod_count: int = 0
    no_request_pods: int = 0
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None


class ContainerAllocCell(BaseModel):
    name: str
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    has_requests: bool = False


class PodAllocRow(BaseModel):
    name: str
    namespace: str
    node: Optional[str] = None
    qos: Optional[str] = None
    phase: str = "-"
    containers: list[ContainerAllocCell] = []
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None


# ── 엔드포인트 ───────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/allocation/nodes")
def allocation_nodes(cluster_id: UUID, db: Session = Depends(get_db)):
    """노드별 allocatable/capacity vs usage vs request/limit + slack. (요구 1·2)"""
    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)
    v1 = k8s_client.CoreV1Api(client)
    try:
        nodes = v1.list_node(limit=_LIST_LIMIT)
        pods = v1.list_pod_for_all_namespaces(limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"노드/파드 조회 실패: {str(e)[:200]}")

    usage = _node_usage(client)

    # 노드별 파드 request/limit 합산 (비종료 파드만).
    per_node: dict[str, dict] = {}
    for p in (pods.items or []):
        if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
            continue
        node = p.spec.node_name if p.spec else None
        if not node:
            continue
        rc, rm, lc, lm = _sum_resources(p.spec.containers if p.spec else [])
        slot = per_node.setdefault(node, {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0})
        slot["rc"] += rc
        slot["rm"] += rm
        slot["lc"] += lc
        slot["lm"] += lm
        slot["pods"] += 1

    rows: list[NodeAllocRow] = []
    for n in (nodes.items or []):
        name = n.metadata.name
        labels = n.metadata.labels or {}
        alloc = (n.status.allocatable or {}) if n.status else {}
        cap = (n.status.capacity or {}) if n.status else {}
        agg = per_node.get(name, {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0})
        cpu_alloc, mem_alloc = _cpu_m(alloc.get("cpu")), _mem_b(alloc.get("memory"))
        u = usage.get(name)
        rows.append(NodeAllocRow(
            name=name,
            roles=_node_roles(labels),
            unschedulable=bool(n.spec.unschedulable) if n.spec else False,
            pod_count=agg["pods"],
            cpu_alloc_m=cpu_alloc,
            mem_alloc_b=mem_alloc,
            cpu_capacity_m=_cpu_m(cap.get("cpu")),
            mem_capacity_b=_mem_b(cap.get("memory")),
            cpu_usage_m=(u[0] if u else None),
            mem_usage_b=(u[1] if u else None),
            cpu_req_m=agg["rc"],
            mem_req_b=agg["rm"],
            cpu_lim_m=agg["lc"],
            mem_lim_b=agg["lm"],
            cpu_slack_m=cpu_alloc - agg["rc"],
            mem_slack_b=mem_alloc - agg["rm"],
            cpu_alloc_display=_fmt_cpu(cpu_alloc),
            mem_alloc_display=_fmt_mem(mem_alloc),
            cpu_usage_display=(_fmt_cpu(u[0]) if u else None),
            mem_usage_display=(_fmt_mem(u[1]) if u else None),
            cpu_req_display=_fmt_cpu(agg["rc"]),
            mem_req_display=_fmt_mem(agg["rm"]),
            cpu_lim_display=_fmt_cpu(agg["lc"]),
            mem_lim_display=_fmt_mem(agg["lm"]),
        ))
    rows.sort(key=lambda r: r.name)
    return {"count": len(rows), "items": rows, "metrics_available": bool(usage)}


@router.get("/{cluster_id}/allocation/namespaces")
def allocation_namespaces(cluster_id: UUID, db: Session = Depends(get_db)):
    """네임스페이스별 request/limit/usage 총합 + 클러스터 summary. (요구 3)"""
    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)
    v1 = k8s_client.CoreV1Api(client)
    apps = k8s_client.AppsV1Api(client)
    try:
        nodes = v1.list_node(limit=_LIST_LIMIT)
        pods = v1.list_pod_for_all_namespaces(limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}")

    pusage = _pod_usage(client)
    rs_map = _build_rs_owner_map(apps, None)

    per_ns: dict[str, dict] = {}
    summary = {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0, "pods": 0, "norq": 0}
    for p in (pods.items or []):
        if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
            continue
        ns = p.metadata.namespace
        rc, rm, lc, lm = _sum_resources(p.spec.containers if p.spec else [])
        um = pusage.get((ns, p.metadata.name))
        owner = _top_owner(p, rs_map)
        no_req = (rc == 0 and rm == 0)
        slot = per_ns.setdefault(ns, {
            "rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0,
            "pods": 0, "norq": 0, "owners": set(), "has_usage": False,
        })
        slot["rc"] += rc
        slot["rm"] += rm
        slot["lc"] += lc
        slot["lm"] += lm
        slot["pods"] += 1
        slot["owners"].add(owner)
        if no_req:
            slot["norq"] += 1
        if um:
            slot["uc"] += um["cpu"]
            slot["um"] += um["mem"]
            slot["has_usage"] = True
        summary["rc"] += rc
        summary["rm"] += rm
        summary["lc"] += lc
        summary["lm"] += lm
        summary["pods"] += 1
        if no_req:
            summary["norq"] += 1
        if um:
            summary["uc"] += um["cpu"]
            summary["um"] += um["mem"]

    metrics_available = bool(pusage)
    rows: list[NamespaceAllocRow] = []
    for ns, s in per_ns.items():
        rows.append(NamespaceAllocRow(
            namespace=ns,
            pod_count=s["pods"],
            workload_count=len(s["owners"]),
            no_request_pods=s["norq"],
            cpu_req_m=s["rc"],
            mem_req_b=s["rm"],
            cpu_lim_m=s["lc"],
            mem_lim_b=s["lm"],
            cpu_usage_m=(s["uc"] if s["has_usage"] else None),
            mem_usage_b=(s["um"] if s["has_usage"] else None),
            cpu_req_display=_fmt_cpu(s["rc"]),
            mem_req_display=_fmt_mem(s["rm"]),
            cpu_usage_display=(_fmt_cpu(s["uc"]) if s["has_usage"] else None),
            mem_usage_display=(_fmt_mem(s["um"]) if s["has_usage"] else None),
        ))
    rows.sort(key=lambda r: r.cpu_req_m, reverse=True)

    cpu_alloc = mem_alloc = 0
    for n in (nodes.items or []):
        alloc = (n.status.allocatable or {}) if n.status else {}
        cpu_alloc += _cpu_m(alloc.get("cpu"))
        mem_alloc += _mem_b(alloc.get("memory"))

    summary_model = AllocSummary(
        node_count=len(nodes.items or []),
        pod_count=summary["pods"],
        cpu_alloc_m=cpu_alloc,
        mem_alloc_b=mem_alloc,
        cpu_req_m=summary["rc"],
        mem_req_b=summary["rm"],
        cpu_lim_m=summary["lc"],
        mem_lim_b=summary["lm"],
        cpu_usage_m=(summary["uc"] if metrics_available else None),
        mem_usage_b=(summary["um"] if metrics_available else None),
        no_request_pods=summary["norq"],
    )
    return {
        "count": len(rows),
        "items": rows,
        "summary": summary_model,
        "metrics_available": metrics_available,
    }


@router.get("/{cluster_id}/allocation/namespaces/{namespace}/workloads")
def allocation_workloads(cluster_id: UUID, namespace: str, db: Session = Depends(get_db)):
    """NS 내 상위 워크로드(Deployment/STS/DS/RS/Job/…) 단위 집계. (요구 4-1)"""
    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)
    v1 = k8s_client.CoreV1Api(client)
    apps = k8s_client.AppsV1Api(client)
    try:
        pods = v1.list_namespaced_pod(namespace, limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}")

    pusage = _pod_usage(client, namespace)
    rs_map = _build_rs_owner_map(apps, namespace)

    groups: dict[tuple[str, str], dict] = {}
    for p in (pods.items or []):
        if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
            continue
        kind, name = _top_owner(p, rs_map)
        rc, rm, lc, lm = _sum_resources(p.spec.containers if p.spec else [])
        um = pusage.get((namespace, p.metadata.name))
        g = groups.setdefault((kind, name), {
            "rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0,
            "pods": 0, "norq": 0, "has_usage": False,
        })
        g["rc"] += rc
        g["rm"] += rm
        g["lc"] += lc
        g["lm"] += lm
        g["pods"] += 1
        if rc == 0 and rm == 0:
            g["norq"] += 1
        if um:
            g["uc"] += um["cpu"]
            g["um"] += um["mem"]
            g["has_usage"] = True

    rows: list[WorkloadAllocRow] = []
    for (kind, name), g in groups.items():
        rows.append(WorkloadAllocRow(
            namespace=namespace,
            kind=kind,
            name=name,
            pod_count=g["pods"],
            no_request_pods=g["norq"],
            cpu_req_m=g["rc"],
            mem_req_b=g["rm"],
            cpu_lim_m=g["lc"],
            mem_lim_b=g["lm"],
            cpu_usage_m=(g["uc"] if g["has_usage"] else None),
            mem_usage_b=(g["um"] if g["has_usage"] else None),
        ))
    rows.sort(key=lambda r: r.cpu_req_m, reverse=True)
    return {"count": len(rows), "items": rows, "metrics_available": bool(pusage)}


@router.get("/{cluster_id}/allocation/namespaces/{namespace}/workloads/{kind}/{name}/pods")
def allocation_pods(
    cluster_id: UUID,
    namespace: str,
    kind: str,
    name: str,
    db: Session = Depends(get_db),
):
    """워크로드 소속 파드 + 컨테이너 단위 request/limit/usage. (요구 4-2)"""
    cluster = _require_cluster(cluster_id, db)
    client = _api_client(cluster)
    v1 = k8s_client.CoreV1Api(client)
    apps = k8s_client.AppsV1Api(client)
    try:
        pods = v1.list_namespaced_pod(namespace, limit=_LIST_LIMIT)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}")

    pusage = _pod_usage(client, namespace)
    rs_map = _build_rs_owner_map(apps, namespace)

    rows: list[PodAllocRow] = []
    for p in (pods.items or []):
        ok, on = _top_owner(p, rs_map)
        if ok != kind or on != name:
            continue
        pkey = (namespace, p.metadata.name)
        cmap = (pusage.get(pkey) or {}).get("containers", {})
        cells: list[ContainerAllocCell] = []
        prc = prm = plc = plm = 0
        puc = pum = 0
        has_usage = False
        for c in (p.spec.containers if p.spec else []):
            res = getattr(c, "resources", None)
            req = (res.requests or {}) if res else {}
            lim = (res.limits or {}) if res else {}
            crc, crm = _cpu_m(req.get("cpu")), _mem_b(req.get("memory"))
            clc, clm = _cpu_m(lim.get("cpu")), _mem_b(lim.get("memory"))
            cu = cmap.get(c.name)
            cells.append(ContainerAllocCell(
                name=c.name,
                cpu_req_m=crc,
                mem_req_b=crm,
                cpu_lim_m=clc,
                mem_lim_b=clm,
                cpu_usage_m=(cu[0] if cu else None),
                mem_usage_b=(cu[1] if cu else None),
                has_requests=(crc > 0 or crm > 0),
            ))
            prc += crc
            prm += crm
            plc += clc
            plm += clm
            if cu:
                puc += cu[0]
                pum += cu[1]
                has_usage = True
        rows.append(PodAllocRow(
            name=p.metadata.name,
            namespace=namespace,
            node=(p.spec.node_name if p.spec else None),
            qos=(p.status.qos_class if p.status else None),
            phase=(p.status.phase if p.status else "-") or "-",
            containers=cells,
            cpu_req_m=prc,
            mem_req_b=prm,
            cpu_lim_m=plc,
            mem_lim_b=plm,
            cpu_usage_m=(puc if has_usage else None),
            mem_usage_b=(pum if has_usage else None),
        ))
    rows.sort(key=lambda r: r.name)
    return {"count": len(rows), "items": rows, "metrics_available": bool(pusage)}
