"""Architecture Doc Service — 서비스 모듈(LakeService)별 아키텍처 문서 생성/현행화.

파이프라인:
 1. `collect_topology(cluster, namespace)` 로 자동 발견 (기존 service_topology 엔진 재사용)
 2. `simplify_graph` 로 아키텍처 수준으로 단순화 (pods collapse, ConfigMap/Secret 제거)
 3. `reconcile` 로 기존 문서와 병합 — 사라진 노드는 stale 마킹(삭제 X),
    수동 레이어(manual nodes/edges, layout, annotations, summary_override)는 절대 불변
 4. best-effort 트래픽 엣지(`build_traffic`) + TopologyAuditLog(sync) 기록
 5. LLM enrichment 는 sync 와 분리된 별도 단계 — 실패해도 문서는 완전 동작 (fail-safe)
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import Cluster, LakeService, TopologyAuditLog
from app.models.service_arch_doc import (
    ServiceArchDoc,
    ServiceArchManualEdge,
    ServiceArchManualNode,
)
from app.services import service_topology_service as topo_svc
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

# 아키텍처 수준에서 유지할 kind — pods 는 collapse, ConfigMap/Secret 은 노이즈로 제거
ARCH_KINDS = {
    "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob",
    "Service", "Ingress", "PVC",
}
DROP_EDGE_TYPES = {"uses_config", "uses_secret"}

# LLM 프롬프트에 넣을 최대 노드/트래픽 수 (Ollama 컨텍스트 보호)
_LLM_MAX_NODES = 80
_LLM_MAX_TRAFFIC = 20


# ── graph shaping ────────────────────────────────────────────────────────────
def simplify_graph(raw: dict[str, Any]) -> dict[str, Any]:
    """collect_topology 결과를 아키텍처 수준으로 단순화.

    ConfigMap/Secret 노드와 uses_config/uses_secret 엣지를 제거하고,
    양끝이 살아있는 엣지만 유지한다. 내부 필드(_refs/selector/labels)는 버린다.
    """
    nodes: list[dict] = []
    for n in raw.get("nodes") or []:
        if n.get("kind") not in ARCH_KINDS:
            continue
        nodes.append({
            "id": n["id"],
            "kind": n["kind"],
            "name": n["name"],
            "namespace": n.get("namespace"),
            "status": n.get("status", "healthy"),
            "detail": n.get("detail"),
        })
    node_ids = {n["id"] for n in nodes}

    edges: list[dict] = []
    for e in raw.get("edges") or []:
        if e.get("type") in DROP_EDGE_TYPES:
            continue
        if e.get("source") not in node_ids or e.get("target") not in node_ids:
            continue
        edges.append({
            "id": e.get("id") or f"{e['source']}|{e.get('type', '')}|{e['target']}",
            "source": e["source"],
            "target": e["target"],
            "type": e.get("type", "custom"),
            "label": e.get("label", ""),
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "warnings": list(raw.get("warnings") or []),
        "truncated": bool(raw.get("truncated")),
    }


def compute_source_hash(graph: dict[str, Any]) -> str:
    """구조 해시 — 노드 (id, kind) + 엣지 (source, target, type)만. status 플래핑 무시."""
    node_sig = sorted((n["id"], n.get("kind", "")) for n in graph.get("nodes") or [])
    edge_sig = sorted(
        (e["source"], e["target"], e.get("type", "")) for e in graph.get("edges") or []
    )
    payload = json.dumps([node_sig, edge_sig], ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _referenced_node_ids(doc: ServiceArchDoc) -> set[str]:
    """수동 엣지/배치/주석이 참조하는 auto node_id — prune 시에도 보호."""
    refs: set[str] = set()
    for me in doc.manual_edges or []:
        refs.add(me.source_id)
        refs.add(me.target_id)
    for view_map in (doc.layout or {}).values():
        if isinstance(view_map, dict):
            refs.update(view_map.keys())
    refs.update(k for k in (doc.annotations or {}).keys() if k != "__doc__")
    return refs


def reconcile(doc: ServiceArchDoc, new_graph: dict[str, Any], *, prune: bool = False) -> dict:
    """기존 auto_graph 와 새 그래프 병합. 사라진 노드는 stale 마킹(ghost 렌더).

    수동 레이어(manual nodes/edges, layout, annotations, summary_override)는 건드리지 않는다.
    반환: {"added": [...], "removed": [...], "changed": [...]} (빈 리스트는 생략).
    """
    old = doc.auto_graph or {}
    old_nodes = {n["id"]: n for n in old.get("nodes") or []}
    new_nodes = {n["id"]: n for n in new_graph.get("nodes") or []}

    added: list[str] = []
    removed: list[str] = []
    changed: list[str] = []
    merged: list[dict] = []

    for nid, n in new_nodes.items():
        merged.append(dict(n))  # 최신 데이터 우선 — stale 플래그 자연 해제
        prev = old_nodes.get(nid)
        if prev is None:
            added.append(nid)
        elif (
            prev.get("stale")  # stale 이던 노드 복귀도 drift 로 보고
            or (prev.get("kind"), prev.get("status")) != (n.get("kind"), n.get("status"))
        ):
            changed.append(nid)

    referenced = _referenced_node_ids(doc)
    now_iso = datetime.utcnow().isoformat()
    for nid, n in old_nodes.items():
        if nid in new_nodes:
            continue
        was_stale = bool(n.get("stale"))
        if prune and nid not in referenced:
            if not was_stale:
                removed.append(nid)
            continue
        merged.append({**n, "stale": True, "stale_since": n.get("stale_since") or now_iso})
        if not was_stale:
            removed.append(nid)

    # auto 엣지는 사용자 상태가 없으므로 전량 교체 — stale 노드 대상 엣지는 자연 소멸
    doc.auto_graph = {
        "nodes": merged,
        "edges": new_graph.get("edges") or [],
        "warnings": new_graph.get("warnings") or [],
        "truncated": bool(new_graph.get("truncated")),
    }

    diff: dict[str, list[str]] = {}
    if added:
        diff["added"] = added
    if removed:
        diff["removed"] = removed
    if changed:
        diff["changed"] = changed
    return diff


# ── doc lifecycle ────────────────────────────────────────────────────────────
def get_or_create_doc(db: Session, service: LakeService) -> ServiceArchDoc:
    """문서 조회, 없으면 빈 shell 생성 (K8s 호출 없음)."""
    doc = (
        db.query(ServiceArchDoc)
        .filter(ServiceArchDoc.lake_service_id == service.id)
        .first()
    )
    if doc:
        # 모듈의 namespace 가 바뀌었으면 스코프 추종 (다음 sync 부터 반영)
        if service.namespace and doc.namespace != service.namespace:
            doc.namespace = service.namespace
        return doc
    doc = ServiceArchDoc(
        lake_service_id=service.id,
        cluster_id=service.cluster_id,
        namespace=service.namespace or "",
        layout={},
        annotations={},
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


def _audit(
    db: Session,
    doc: ServiceArchDoc,
    *,
    action: str,
    scope: str,
    status: str = "success",
    reason: Optional[str] = None,
    before_data: Optional[dict] = None,
    after_data: Optional[dict] = None,
) -> None:
    try:
        db.add(TopologyAuditLog(
            cluster_id=doc.cluster_id,
            entity_type="arch_doc",
            entity_id=str(doc.lake_service_id),
            action=action,
            scope=scope,
            status=status,
            reason=reason,
            before_data=before_data,
            after_data=after_data,
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning("arch_doc audit 기록 실패: %s", e)


def sync_doc(
    db: Session,
    service: LakeService,
    *,
    triggered_by: str = "manual",
    username: Optional[str] = None,
    include_traffic: bool = True,
    prune: bool = False,
) -> ServiceArchDoc:
    """문서 현행화. 동기 — 라우터는 asyncio.to_thread 로, Celery 는 직접 호출.

    실패해도 raise 하지 않고 last_sync_status="failed" + sync_error 로 기록 (fail-soft).
    """
    doc = get_or_create_doc(db, service)
    before_hash = doc.source_hash

    if not (service.namespace or "").strip():
        doc.last_sync_status = "failed"
        doc.sync_error = "서비스 모듈에 namespace 가 설정되지 않았습니다. Settings 에서 namespace 를 지정하세요."
        _audit(db, doc, action="sync", scope="sync", status="failed",
               reason=doc.sync_error, after_data={"triggered_by": triggered_by})
        db.commit()
        db.refresh(doc)
        return doc

    cluster = db.query(Cluster).filter(Cluster.id == service.cluster_id).first()
    if cluster is None:
        doc.last_sync_status = "failed"
        doc.sync_error = "클러스터를 찾을 수 없습니다."
        _audit(db, doc, action="sync", scope="sync", status="failed", reason=doc.sync_error)
        db.commit()
        db.refresh(doc)
        return doc

    try:
        raw = topo_svc.collect_topology(
            cluster, service.namespace, include_pods=False, include_orphans=False,
        )
        graph = simplify_graph(raw)

        # best-effort 트래픽 (Hubble→conntrack 폴백) — 실패는 warning 으로만
        if include_traffic:
            try:
                kc = ensure_kubeconfig_file(cluster)
                if kc:
                    from app.services.cilium_trace_service import detect_status
                    hubble = bool(detect_status(kc).get("hubble_relay_installed"))
                    traffic = topo_svc.build_traffic(
                        cluster, kc, service.namespace,
                        hubble_installed=hubble,
                        pod_name_index=raw.get("pod_name_index") or {},
                        pod_ip_index=raw.get("pod_ip_index") or {},
                    )
                    if traffic.get("status") == "ok":
                        doc.traffic_edges = traffic.get("edges") or []
                    else:
                        graph["warnings"].append(
                            f"트래픽 수집 불가: {traffic.get('reason') or 'unavailable'}"
                        )
            except Exception as e:  # noqa: BLE001
                graph["warnings"].append(f"트래픽 수집 실패: {str(e)[:120]}")

        diff = reconcile(doc, graph, prune=prune)
        doc.source_hash = compute_source_hash(graph)
        doc.last_synced_at = datetime.utcnow()
        doc.last_sync_status = "partial" if (graph["warnings"] or graph["truncated"]) else "ok"
        doc.sync_error = None
        doc.drift = ({**diff, "detected_at": datetime.utcnow().isoformat()} if diff else None)
        if service.namespace:
            doc.namespace = service.namespace

        _audit(
            db, doc, action="sync", scope="sync", status=doc.last_sync_status,
            before_data={"hash": before_hash},
            after_data={
                "hash": doc.source_hash,
                "node_count": len(doc.auto_graph["nodes"]),
                "diff": diff or None,
                "triggered_by": triggered_by,
                "username": username,
                "prune": prune,
            },
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.exception("arch doc sync 실패 service=%s: %s", service.id, e)
        doc = get_or_create_doc(db, service)
        doc.last_sync_status = "failed"
        doc.sync_error = str(e)[:500]
        _audit(db, doc, action="sync", scope="sync", status="failed",
               reason=doc.sync_error, after_data={"triggered_by": triggered_by})
        db.commit()

    db.refresh(doc)
    return doc


# ── LLM enrichment (fail-safe — 없이도 완전 동작) ────────────────────────────
def build_llm_prompt(doc: ServiceArchDoc, service: LakeService) -> str:
    graph = doc.auto_graph or {}
    nodes = [
        {"id": n["id"], "kind": n.get("kind"), "name": n.get("name")}
        for n in (graph.get("nodes") or [])[:_LLM_MAX_NODES]
    ]
    truncated_note = ""
    total = len(graph.get("nodes") or [])
    if total > _LLM_MAX_NODES:
        truncated_note = f"\n(노드 {total}개 중 {_LLM_MAX_NODES}개만 표시)"
    edges = [
        {"source": e["source"], "target": e["target"], "type": e.get("type")}
        for e in graph.get("edges") or []
    ]
    traffic = [
        {"source": t.get("source"), "target": t.get("target"),
         "flow_count": t.get("flow_count")}
        for t in sorted(
            doc.traffic_edges or [],
            key=lambda t: -(t.get("flow_count") or 0),
        )[:_LLM_MAX_TRAFFIC]
    ]
    manual_edges = [
        {"source": me.source_id, "target": me.target_id,
         "type": me.edge_type, "label": me.label}
        for me in doc.manual_edges or []
    ]
    payload = {
        "service": {
            "name": service.name,
            "service_type": service.service_type,
            "namespace": service.namespace,
            "endpoint_url": service.endpoint_url,
        },
        "nodes": nodes,
        "edges": edges,
        "traffic": traffic,
        "manual_edges": manual_edges,
    }
    schema = (
        '{"summary": "3~5문장 한국어 아키텍처 요약", '
        '"components": [{"node_id": "<node_id>", "role": "한 문장 역할 설명"}], '
        '"flow_steps": [{"order": 1, "source": "<node_id>", "target": "<node_id>", '
        '"description": "요청 흐름 한 문장"}]}'
    )
    return (
        "당신은 Kubernetes 플랫폼 아키텍트입니다. 아래 서비스 모듈의 K8s 리소스 그래프를 "
        "분석해 아키텍처 요약과 서비스 요청 흐름을 작성하세요.\n"
        f"다음 JSON 스키마로 **JSON 만** 출력하세요 (코드펜스/설명 금지):\n{schema}\n"
        "node_id 는 반드시 입력 nodes 목록의 id 값만 사용하세요."
        f"{truncated_note}\n\n입력 그래프:\n{json.dumps(payload, ensure_ascii=False)}"
    )


def parse_llm_response(text: str) -> dict[str, Any]:
    """LLM 응답 파싱 — 코드펜스 제거 후 JSON. 실패 시 raw_fallback 요약으로 강등."""
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    # 앞뒤 잡담 방어 — 첫 '{' 부터 마지막 '}' 까지 시도
    if not cleaned.startswith("{"):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start >= 0 and end > start:
            cleaned = cleaned[start:end + 1]
    try:
        data = json.loads(cleaned)
        if not isinstance(data, dict):
            raise ValueError("not a dict")
    except Exception:  # noqa: BLE001
        return {"summary": (text or "").strip()[:2000], "components": [],
                "flow_steps": [], "raw_fallback": True}

    out: dict[str, Any] = {
        "summary": str(data.get("summary") or "")[:4000],
        "components": [],
        "flow_steps": [],
        "raw_fallback": False,
    }
    for c in data.get("components") or []:
        if isinstance(c, dict) and c.get("node_id") and c.get("role"):
            out["components"].append(
                {"node_id": str(c["node_id"]), "role": str(c["role"])[:500]}
            )
    for i, s in enumerate(data.get("flow_steps") or []):
        if not isinstance(s, dict):
            continue
        out["flow_steps"].append({
            "order": int(s.get("order") or (i + 1)),
            "source": str(s.get("source") or ""),
            "target": str(s.get("target") or ""),
            "description": str(s.get("description") or "")[:500],
        })
    return out


def _filter_known_node_ids(content: dict[str, Any], doc: ServiceArchDoc) -> dict[str, Any]:
    known = {n["id"] for n in (doc.auto_graph or {}).get("nodes") or []}
    known.update(mn.node_id for mn in doc.manual_nodes or [])
    content["components"] = [c for c in content.get("components") or [] if c["node_id"] in known]
    content["flow_steps"] = [
        s for s in content.get("flow_steps") or []
        if (not s["source"] or s["source"] in known) and (not s["target"] or s["target"] in known)
    ]
    return content


async def generate_llm_content(
    db: Session, doc: ServiceArchDoc, service: LakeService,
) -> ServiceArchDoc:
    """LLM 요약/역할/플로우 생성. never raises — 실패는 llm_status 로만 표시.

    Ollama 오프라인이면 기존 llm_content 를 보존하고 status 만 offline 으로 둔다.
    """
    from app.services.agent_service import agent_service

    if not (doc.auto_graph or {}).get("nodes"):
        doc.llm_status = "failed"
        db.commit()
        db.refresh(doc)
        return doc

    doc.llm_status = "pending"
    db.commit()

    try:
        resp = await agent_service._call_llm(build_llm_prompt(doc, service), purpose="arch_doc")
    except Exception as e:  # noqa: BLE001  (방어 — _call_llm 은 원래 raise 하지 않음)
        logger.exception("arch doc LLM 호출 실패: %s", e)
        resp = {"status": "offline", "answer": "", "model": ""}

    if resp.get("status") != "ok":
        doc.llm_status = "offline"
        db.commit()
        db.refresh(doc)
        return doc

    content = _filter_known_node_ids(parse_llm_response(resp.get("answer") or ""), doc)
    content["model"] = resp.get("model") or ""
    content["generated_at"] = datetime.utcnow().isoformat()
    doc.llm_content = content
    doc.llm_status = "ok"
    _audit(db, doc, action="update", scope="sync", status="success",
           reason="llm_regenerate", after_data={"model": content["model"],
                                                "raw_fallback": content.get("raw_fallback", False)})
    db.commit()
    db.refresh(doc)
    return doc


# ── sync schedule (AppSetting — resource_count_service 패턴) ─────────────────
SCHEDULE_KEY = "arch_doc.sync_schedule"
DEFAULT_CRON = "0 6 * * *"  # 매일 06:00 (KST 해석 — BATCH_JOBS_TIMEZONE)


def get_schedule(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == SCHEDULE_KEY).first()
    val = (row.value if row and isinstance(row.value, dict) else None) or {}
    return {
        "enabled": bool(val.get("enabled", True)),
        "cron": val.get("cron") or DEFAULT_CRON,
        "last_run_at": val.get("last_run_at"),
    }


def set_schedule(
    db: Session, enabled: bool, cron: str, last_run_at: Optional[str] = "__keep__",
) -> dict[str, Any]:
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


# ── list ─────────────────────────────────────────────────────────────────────
def list_doc_summaries(db: Session, cluster_id: Optional[UUID] = None) -> list[dict]:
    """모듈별 문서 요약 — LakeService 목록 기준 (문서 미생성 모듈 포함)."""
    q = db.query(LakeService).filter(LakeService.enabled.is_(True))
    if cluster_id:
        q = q.filter(LakeService.cluster_id == cluster_id)
    services = q.order_by(LakeService.name).all()
    docs = {
        d.lake_service_id: d
        for d in db.query(ServiceArchDoc).filter(
            ServiceArchDoc.lake_service_id.in_([s.id for s in services])
        ).all()
    } if services else {}

    out: list[dict] = []
    for s in services:
        d = docs.get(s.id)
        drift = d.drift if d else None
        out.append({
            "service_id": str(s.id),
            "service_name": s.name,
            "service_type": s.service_type,
            "cluster_id": str(s.cluster_id),
            "namespace": s.namespace,
            "has_doc": d is not None,
            "last_synced_at": d.last_synced_at.isoformat() if d and d.last_synced_at else None,
            "last_sync_status": d.last_sync_status if d else "pending",
            "llm_status": d.llm_status if d else "none",
            "auto_sync_enabled": d.auto_sync_enabled if d else True,
            "drift_counts": (
                {k: len(v) for k, v in drift.items() if isinstance(v, list)} if drift else None
            ),
        })
    return out
