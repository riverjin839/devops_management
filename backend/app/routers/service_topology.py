"""Service Topology endpoints — 자동 발견 그래프 + 수동 연계 + 실트래픽 오버레이.

- `GET    /service-topology/{cluster_id}/graph`            자동 그래프(+수동 엣지/외부 노드 병합)
- `GET    /service-topology/{cluster_id}/traffic`          실트래픽 엣지(Hubble→conntrack 폴백)
- `GET    /service-topology/{cluster_id}/links`            수동 링크 목록
- `POST   /service-topology/{cluster_id}/links`            수동 링크 생성
- `PATCH  /service-topology/links/{link_id}`               수동 링크 수정
- `DELETE /service-topology/links/{link_id}`               수동 링크 삭제
- `POST   /service-topology/{cluster_id}/external-nodes`   외부 노드 생성
- `DELETE /service-topology/external-nodes/{node_id}`      외부 노드 삭제

graph 응답의 빈 500 금지 — kubeconfig 없으면 422, 클러스터 오류는 502/504 + detail.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster, ServiceTopologyLink, ServiceTopologyExternalNode
from app.services import service_topology_service as svc
from app.services.cilium_trace_service import detect_status
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.prometheus_service import prometheus_service
from app.services.snapshot_jobs import SnapshotManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/service-topology", tags=["service-topology"])

# 클러스터 전체 토폴로지 집계는 무거우므로 백그라운드 스냅샷으로 수행(요청 비블로킹 → 502 회피).
_cluster_topo_mgr = SnapshotManager(ttl=20.0)


# ── schemas ──────────────────────────────────────────────────────────────────
class NodeMetricAxis(BaseModel):
    usage: Optional[float] = None
    request: Optional[float] = None
    limit: Optional[float] = None


class NodeMetrics(BaseModel):
    cpu: NodeMetricAxis = Field(default_factory=NodeMetricAxis)
    mem: NodeMetricAxis = Field(default_factory=NodeMetricAxis)


class TopoNode(BaseModel):
    id: str
    kind: str
    name: str
    namespace: str
    status: str = "healthy"
    pod_count: int = 0
    ready_count: int = 0
    restart_count: int = 0
    ghost: bool = False
    age_seconds: Optional[int] = None
    detail: Optional[str] = None
    node_type: Optional[str] = None  # external 노드용
    external_id: Optional[str] = None  # external 노드의 DB id(삭제용)
    metrics: NodeMetrics = Field(default_factory=NodeMetrics)


class TopoEdge(BaseModel):
    id: str
    source: str
    target: str
    type: str
    label: str = ""
    detail: str = ""
    manual_id: Optional[str] = None


class TopologyGraphResponse(BaseModel):
    cluster_id: UUID
    namespace: str
    nodes: list[TopoNode]
    edges: list[TopoEdge]
    metrics_status: str = "unknown"   # ok | offline | unknown
    truncated: bool = False
    warnings: list[str] = Field(default_factory=list)
    generated_at: datetime


class ClusterTopologyResponse(BaseModel):
    cluster_id: UUID
    mode: str = "summary"                 # summary | detail
    nodes: list[TopoNode]
    edges: list[TopoEdge]
    metrics_status: str = "unknown"
    truncated: bool = False
    summary_recommended: bool = False
    namespace_count: int = 0
    warnings: list[str] = Field(default_factory=list)
    generated_at: datetime
    # 스냅샷 진행 메타(프론트 폴링/진행률)
    status: str = "ready"                 # computing | ready | error
    progress: Optional[float] = None
    processed: int = 0
    total: Optional[int] = None
    stale: bool = False


class TrafficEdgeOut(BaseModel):
    source: str
    target: str
    flow_count: int = 0
    dropped_count: int = 0
    protocols: list[str] = Field(default_factory=list)
    ports: list[int] = Field(default_factory=list)


class TopologyTrafficResponse(BaseModel):
    cluster_id: UUID
    namespace: str
    status: str           # ok | unavailable | error
    source: Optional[str] = None  # hubble | conntrack
    reason: Optional[str] = None
    edges: list[TrafficEdgeOut] = Field(default_factory=list)
    generated_at: datetime


class LinkCreate(BaseModel):
    namespace: str = "default"
    source_kind: str
    source_name: str
    target_kind: str
    target_name: str
    link_type: str = "depends_on"
    label: Optional[str] = None
    note: Optional[str] = None


class LinkUpdate(BaseModel):
    link_type: Optional[str] = None
    label: Optional[str] = None
    note: Optional[str] = None


class LinkOut(BaseModel):
    id: UUID
    cluster_id: UUID
    namespace: str
    source_kind: str
    source_name: str
    target_kind: str
    target_name: str
    link_type: str
    label: Optional[str]
    note: Optional[str]
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ExternalNodeCreate(BaseModel):
    namespace: str = "default"
    name: str
    node_type: str = "other"   # database | api | queue | other
    note: Optional[str] = None


class ExternalNodeOut(BaseModel):
    id: UUID
    cluster_id: UUID
    namespace: str
    name: str
    node_type: str
    note: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


# ── helpers ──────────────────────────────────────────────────────────────────
def _require_cluster(cluster_id: UUID, db: Session) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return c


def _ext_node_id(name: str, namespace: str) -> str:
    return svc.node_id("External", namespace, name)


async def _fill_usage(nodes: list[dict], workload_pods: dict, namespace: str) -> str:
    """Prometheus 로 pod usage 조회 → 워크로드 노드에 롤업. 반환: metrics_status."""
    cpu_q = (f'sum by (pod) (rate(container_cpu_usage_seconds_total'
             f'{{namespace="{namespace}",container!="",image!=""}}[5m]))')
    mem_q = (f'sum by (pod) (container_memory_working_set_bytes'
             f'{{namespace="{namespace}",container!=""}})')
    try:
        cpu_res, mem_res = await asyncio.gather(
            prometheus_service.query(cpu_q),
            prometheus_service.query(mem_q),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("prometheus usage 조회 실패: %s", e)
        return "offline"

    if cpu_res.get("status") != "ok" and mem_res.get("status") != "ok":
        return "offline"

    def _pod_map(res: dict) -> dict[str, float]:
        out: dict[str, float] = {}
        for item in (res.get("results") or []):
            pod = (item.get("labels") or {}).get("pod")
            val = item.get("value")
            if pod and val is not None:
                out[pod] = val
        # single-value shortcut
        if not out and res.get("labels") and res.get("value") is not None:
            pod = res["labels"].get("pod")
            if pod:
                out[pod] = res["value"]
        return out

    cpu_by_pod = _pod_map(cpu_res)
    mem_by_pod = _pod_map(mem_res)

    by_id = {n["id"]: n for n in nodes}
    for wl_id, pod_names in workload_pods.items():
        node = by_id.get(wl_id)
        if not node:
            continue
        cpu_sum = sum(cpu_by_pod.get(p, 0.0) for p in pod_names)
        mem_sum = sum(mem_by_pod.get(p, 0.0) for p in pod_names)
        has_cpu = any(p in cpu_by_pod for p in pod_names)
        has_mem = any(p in mem_by_pod for p in pod_names)
        if has_cpu:
            node["metrics"]["cpu"]["usage"] = round(cpu_sum, 4)
        if has_mem:
            node["metrics"]["mem"]["usage"] = int(mem_sum)
    return "ok"


# ── graph ────────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/graph", response_model=TopologyGraphResponse)
async def get_graph(
    cluster_id: UUID,
    namespace: str = Query(..., min_length=1, max_length=253),
    include_pods: bool = False,
    include_orphans: bool = False,
    with_metrics: bool = True,
    db: Session = Depends(get_db),
):
    cluster = _require_cluster(cluster_id, db)

    try:
        data = await asyncio.to_thread(
            svc.collect_topology, cluster, namespace,
            include_pods=include_pods, include_orphans=include_orphans,
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        code = 504 if "timeout" in msg.lower() else 502
        raise HTTPException(status_code=code, detail=f"토폴로지 수집 실패: {msg[:200]}") from e

    nodes = data["nodes"]
    edges = data["edges"]
    warnings = list(data["warnings"])

    metrics_status = "unknown"
    if with_metrics:
        metrics_status = await _fill_usage(nodes, data["workload_pods"], namespace)
        if metrics_status == "offline":
            warnings.append("Prometheus 오프라인 — usage 미표시(requests/limits 만 표시)")

    # 외부 노드 병합
    try:
        ext_nodes = (
            db.query(ServiceTopologyExternalNode)
            .filter(ServiceTopologyExternalNode.cluster_id == cluster_id,
                    ServiceTopologyExternalNode.namespace == namespace)
            .all()
        )
    except Exception as e:  # noqa: BLE001
        db.rollback(); ext_nodes = []; warnings.append(f"외부 노드 조회 실패: {str(e)[:120]}")

    node_ids = {n["id"] for n in nodes}
    for en in ext_nodes:
        eid = _ext_node_id(en.name, en.namespace)
        if eid not in node_ids:
            nodes.append({
                "id": eid, "kind": "External", "name": en.name, "namespace": en.namespace,
                "status": "healthy", "pod_count": 0, "ready_count": 0, "restart_count": 0,
                "ghost": False, "age_seconds": None, "node_type": en.node_type,
                "external_id": str(en.id), "detail": en.note or "", "metrics": {"cpu": {}, "mem": {}},
            })
            node_ids.add(eid)

    # 수동 링크 병합 (+ ghost 노드)
    try:
        links = (
            db.query(ServiceTopologyLink)
            .filter(ServiceTopologyLink.cluster_id == cluster_id,
                    ServiceTopologyLink.namespace == namespace)
            .all()
        )
    except Exception as e:  # noqa: BLE001
        db.rollback(); links = []; warnings.append(f"수동 링크 조회 실패: {str(e)[:120]}")

    for ln in links:
        s_id = (_ext_node_id(ln.source_name, ln.namespace) if ln.source_kind == "External"
                else svc.node_id(ln.source_kind, ln.namespace, ln.source_name))
        t_id = (_ext_node_id(ln.target_name, ln.namespace) if ln.target_kind == "External"
                else svc.node_id(ln.target_kind, ln.namespace, ln.target_name))
        # 사라진 엔드포인트는 ghost 노드로 표시
        for gid, gkind, gname in ((s_id, ln.source_kind, ln.source_name), (t_id, ln.target_kind, ln.target_name)):
            if gid not in node_ids:
                nodes.append({
                    "id": gid, "kind": gkind, "name": gname, "namespace": ln.namespace,
                    "status": "warning", "pod_count": 0, "ready_count": 0, "restart_count": 0,
                    "ghost": True, "age_seconds": None, "detail": "수동 링크 대상이 현재 없음",
                    "metrics": {"cpu": {}, "mem": {}},
                })
                node_ids.add(gid)
                warnings.append(f"수동 링크 대상 누락: {gkind}/{gname}")
        edges.append({
            "id": f"manual:{ln.id}", "source": s_id, "target": t_id, "type": "manual",
            "label": ln.label or ln.link_type, "detail": ln.note or "", "manual_id": str(ln.id),
        })

    return TopologyGraphResponse(
        cluster_id=cluster_id, namespace=namespace, nodes=nodes, edges=edges,
        metrics_status=metrics_status, truncated=data["truncated"], warnings=warnings,
        generated_at=datetime.utcnow(),
    )


# ── cluster-wide graph (전 네임스페이스) ──────────────────────────────────────
def _cluster_meta(view: dict) -> dict:
    return {
        "status": view["status"], "progress": view["progress"],
        "processed": view["processed"], "total": view["total"], "stale": view["stale"],
    }


@router.get("/{cluster_id}/cluster-graph", response_model=ClusterTopologyResponse)
def get_cluster_graph(
    cluster_id: UUID,
    mode: str = Query("summary", pattern="^(summary|detail)$"),
    include_pods: bool = False,
    with_metrics: bool = False,   # cluster scope 기본 OFF(대규모)
    db: Session = Depends(get_db),
):
    """전 네임스페이스 서비스 아키텍처. SnapshotManager 백그라운드 + 진행률 폴링."""
    cluster = _require_cluster(cluster_id, db)
    # 백그라운드 스레드의 detached 인스턴스 접근 회피 — 요청 스레드에서 kubeconfig 구체화.
    try:
        ensure_kubeconfig_file(cluster)
    except Exception:  # noqa: BLE001
        pass

    key = f"{cluster_id}:cluster-topo:{mode}:{int(include_pods)}"
    view = _cluster_topo_mgr.get(
        key,
        lambda prog: svc.collect_cluster_topology(
            cluster, include_pods=include_pods, mode=mode, progress=prog,
        ),
    )
    data = view["data"]
    if data is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"클러스터 토폴로지 수집 실패: {view['error']}")
        # 집계 중 — 빈 그래프 + 진행 메타(프론트가 진행률 카드 표시 후 폴링)
        return ClusterTopologyResponse(
            cluster_id=cluster_id, mode=mode, nodes=[], edges=[], generated_at=datetime.utcnow(),
            **_cluster_meta(view),
        )

    nodes = list(data["nodes"])
    edges = list(data["edges"])
    warnings = list(data["warnings"])
    is_summary = data["mode"] == "summary"

    # 외부 노드/수동 링크 read-only 병합 (클러스터 전체). summary 면 양끝을 Namespace 노드로 collapse.
    node_ids = {n["id"] for n in nodes}

    def _collapse(nid: str, kind: str, ns: str) -> str:
        return svc.node_id("Namespace", ns, ns) if is_summary else nid

    try:
        ext_nodes = (db.query(ServiceTopologyExternalNode)
                     .filter(ServiceTopologyExternalNode.cluster_id == cluster_id).all())
    except Exception as e:  # noqa: BLE001
        db.rollback(); ext_nodes = []; warnings.append(f"외부 노드 조회 실패: {str(e)[:120]}")
    if not is_summary:
        for en in ext_nodes:
            eid = _ext_node_id(en.name, en.namespace)
            if eid not in node_ids:
                nodes.append({
                    "id": eid, "kind": "External", "name": en.name, "namespace": en.namespace,
                    "status": "healthy", "ghost": False, "node_type": en.node_type,
                    "external_id": str(en.id), "detail": en.note or "", "metrics": {"cpu": {}, "mem": {}},
                })
                node_ids.add(eid)

    try:
        links = (db.query(ServiceTopologyLink)
                 .filter(ServiceTopologyLink.cluster_id == cluster_id).all())
    except Exception as e:  # noqa: BLE001
        db.rollback(); links = []; warnings.append(f"수동 링크 조회 실패: {str(e)[:120]}")
    for ln in links:
        s_raw = (_ext_node_id(ln.source_name, ln.namespace) if ln.source_kind == "External"
                 else svc.node_id(ln.source_kind, ln.namespace, ln.source_name))
        t_raw = (_ext_node_id(ln.target_name, ln.namespace) if ln.target_kind == "External"
                 else svc.node_id(ln.target_kind, ln.namespace, ln.target_name))
        s_id = _collapse(s_raw, ln.source_kind, ln.namespace)
        t_id = _collapse(t_raw, ln.target_kind, ln.namespace)
        if s_id == t_id:
            continue  # summary 에서 동일 NS 내 링크는 self-loop → skip
        # 양끝이 그래프에 있을 때만(요약은 Namespace 노드, 상세는 실제 노드) 엣지 추가
        if s_id in node_ids and t_id in node_ids:
            edges.append({
                "id": f"manual:{ln.id}", "source": s_id, "target": t_id, "type": "manual",
                "label": ln.label or ln.link_type, "detail": ln.note or "", "manual_id": str(ln.id),
            })

    if with_metrics and not is_summary and data["namespace_count"] <= 20:
        warnings.append("클러스터 상세 — usage 는 네임스페이스별 보기에서 확인 권장")
    elif with_metrics:
        warnings.append("클러스터 범위 — usage 생략(네임스페이스별 보기에서 확인)")

    return ClusterTopologyResponse(
        cluster_id=cluster_id, mode=data["mode"], nodes=nodes, edges=edges,
        metrics_status="unknown", truncated=data["truncated"],
        summary_recommended=data["summary_recommended"], namespace_count=data["namespace_count"],
        warnings=warnings, generated_at=datetime.utcnow(), **_cluster_meta(view),
    )


# ── traffic ──────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/traffic", response_model=TopologyTrafficResponse)
async def get_traffic(
    cluster_id: UUID,
    namespace: str = Query(..., min_length=1, max_length=253),
    since_seconds: int = Query(60, ge=1, le=3600),
    limit: int = Query(2000, ge=1, le=10000),
    db: Session = Depends(get_db),
):
    cluster = _require_cluster(cluster_id, db)
    kc = ensure_kubeconfig_file(cluster)
    if not kc:
        raise HTTPException(status_code=422, detail="kubeconfig 가 없습니다.")

    # pod index 를 위해 토폴로지 한 번 더 수집(가벼운 collapse 모드).
    try:
        topo = await asyncio.to_thread(svc.collect_topology, cluster, namespace,
                                       include_pods=False, include_orphans=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"pod 인덱스 수집 실패: {str(e)[:200]}") from e

    status = await asyncio.to_thread(detect_status, kc)
    hubble = bool(status.get("hubble_relay_installed"))

    try:
        result = await asyncio.to_thread(
            svc.build_traffic, cluster, kc, namespace,
            since_seconds=since_seconds, limit=limit, hubble_installed=hubble,
            pod_name_index=topo["pod_name_index"], pod_ip_index=topo["pod_ip_index"],
        )
    except Exception as e:  # noqa: BLE001
        return TopologyTrafficResponse(cluster_id=cluster_id, namespace=namespace,
                                       status="error", reason=str(e)[:200],
                                       edges=[], generated_at=datetime.utcnow())

    return TopologyTrafficResponse(
        cluster_id=cluster_id, namespace=namespace,
        status=result["status"], source=result.get("source"), reason=result.get("reason"),
        edges=[TrafficEdgeOut(**e) for e in result.get("edges", [])],
        generated_at=datetime.utcnow(),
    )


# ── manual links CRUD ────────────────────────────────────────────────────────
@router.get("/{cluster_id}/links", response_model=list[LinkOut])
def list_links(
    cluster_id: UUID,
    namespace: Optional[str] = None,
    db: Session = Depends(get_db),
):
    _require_cluster(cluster_id, db)
    q = db.query(ServiceTopologyLink).filter(ServiceTopologyLink.cluster_id == cluster_id)
    if namespace:
        q = q.filter(ServiceTopologyLink.namespace == namespace)
    return q.order_by(ServiceTopologyLink.created_at.desc()).all()


@router.post("/{cluster_id}/links", response_model=LinkOut, status_code=201)
def create_link(
    cluster_id: UUID,
    payload: LinkCreate,
    db: Session = Depends(get_db),
):
    _require_cluster(cluster_id, db)
    link = ServiceTopologyLink(
        cluster_id=cluster_id, namespace=payload.namespace,
        source_kind=payload.source_kind, source_name=payload.source_name,
        target_kind=payload.target_kind, target_name=payload.target_name,
        link_type=payload.link_type, label=payload.label, note=payload.note,
    )
    db.add(link)
    try:
        db.commit(); db.refresh(link)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"링크 저장 실패: {str(e)[:200]}") from e
    return link


@router.patch("/links/{link_id}", response_model=LinkOut)
def update_link(
    link_id: UUID,
    payload: LinkUpdate,
    db: Session = Depends(get_db),
):
    link = db.query(ServiceTopologyLink).filter(ServiceTopologyLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(link, field, val)
    try:
        db.commit(); db.refresh(link)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"링크 수정 실패: {str(e)[:200]}") from e
    return link


@router.delete("/links/{link_id}", status_code=204)
def delete_link(link_id: UUID, db: Session = Depends(get_db)):
    link = db.query(ServiceTopologyLink).filter(ServiceTopologyLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    db.delete(link)
    db.commit()
    return None


# ── external nodes ───────────────────────────────────────────────────────────
@router.post("/{cluster_id}/external-nodes", response_model=ExternalNodeOut, status_code=201)
def create_external_node(
    cluster_id: UUID,
    payload: ExternalNodeCreate,
    db: Session = Depends(get_db),
):
    _require_cluster(cluster_id, db)
    en = ServiceTopologyExternalNode(
        cluster_id=cluster_id, namespace=payload.namespace,
        name=payload.name, node_type=payload.node_type, note=payload.note,
    )
    db.add(en)
    try:
        db.commit(); db.refresh(en)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"외부 노드 저장 실패: {str(e)[:200]}") from e
    return en


@router.delete("/external-nodes/{node_id}", status_code=204)
def delete_external_node(node_id: UUID, db: Session = Depends(get_db)):
    en = db.query(ServiceTopologyExternalNode).filter(ServiceTopologyExternalNode.id == node_id).first()
    if not en:
        raise HTTPException(status_code=404, detail="External node not found")
    db.delete(en)
    db.commit()
    return None
