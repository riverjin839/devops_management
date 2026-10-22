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
from datetime import datetime, timedelta
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
def get_doc(db: Session, service: LakeService) -> Optional[ServiceArchDoc]:
    """문서 조회만 — 없으면 None (조회 경로는 행을 만들지 않는다, A-3)."""
    return (
        db.query(ServiceArchDoc)
        .filter(ServiceArchDoc.lake_service_id == service.id)
        .first()
    )


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


def doc_node_ids(doc: ServiceArchDoc) -> set[str]:
    """문서가 아는 노드 id — auto 그래프 노드(stale 포함) + 수동 노드."""
    known = {n["id"] for n in (doc.auto_graph or {}).get("nodes") or [] if isinstance(n, dict) and n.get("id")}
    known.update(mn.node_id for mn in doc.manual_nodes or [])
    return known


def _filter_known_node_ids(content: dict[str, Any], doc: ServiceArchDoc) -> dict[str, Any]:
    known = doc_node_ids(doc)
    content["components"] = [c for c in content.get("components") or [] if c["node_id"] in known]
    content["flow_steps"] = [
        s for s in content.get("flow_steps") or []
        if (not s["source"] or s["source"] in known) and (not s["target"] or s["target"] in known)
    ]
    return content


# ── LLM 상태 ────────────────────────────────────────────────────────────────
# llm_status 값:
#   none     — 아직 생성 시도 없음
#   pending  — 생성 중 (LLM_PENDING_TIMEOUT 을 넘기면 다음 조회에서 error 로 복구)
#   ok       — 생성 완료
#   offline  — LLM 서버에 닿지 않음(연결 실패·활성 프로필 없음)
#   error    — 호출은 했지만 실패(시간 초과·HTTP 오류·모델/인증·라우팅 오류·작업 중단) — 사유는 llm_error
#   failed   — 노드가 없어 생성할 수 없음(= failed_no_nodes, 먼저 동기화 필요). 이름은 하위 호환으로 유지
LLM_STATUS_FAILED_NO_NODES = "failed"
LLM_PENDING_TIMEOUT = timedelta(minutes=10)
LLM_NO_NODES_MESSAGE = "다이어그램 노드가 없어 AI 분석을 만들 수 없습니다 — 먼저 동기화하세요."
LLM_PENDING_TIMEOUT_MESSAGE = (
    "AI 분석이 10분 넘게 끝나지 않아 중단된 것으로 처리했습니다 (워커 재시작·작업 유실 추정). 다시 시도하세요."
)
_LLM_AUDIT_REASON = "llm_regenerate"
# 게이트웨이가 "닿지 않음"으로 보고하는 코드 — 나머지 실패는 error 로 구분한다.
_OFFLINE_ERROR_CODES = {"connect_error", "no_enabled_profile"}


def describe_llm_error(error: Optional[str], *, profile: str = "", model: str = "") -> str:
    """게이트웨이 오류 코드 → 운영자가 읽을 사유 문자열 (원문 코드도 괄호로 남긴다)."""
    code = (error or "").strip() or "unknown"
    where = f" (프로필 {profile})" if profile else ""
    if code == "connect_error":
        msg = f"LLM 서버에 연결할 수 없습니다{where}"
    elif code == "no_enabled_profile":
        msg = "사용 가능한 LLM 프로필이 없습니다 — Settings → AI/LLM 에서 프로필·용도 라우팅(arch_doc)을 확인하세요"
    elif code.startswith("timeout"):
        msg = f"LLM 응답 시간 초과{where}"
    elif code.startswith("model_not_found"):
        msg = f"모델 '{model or '?'}' 을 찾을 수 없습니다{where}"
    elif code.startswith("auth_failed"):
        msg = f"LLM 인증 실패{where} — API 키를 확인하세요"
    elif "429" in code or "rate" in code.lower():
        msg = f"LLM 호출 한도 초과(429){where}"
    else:
        msg = f"LLM 호출 실패{where}"
    return f"{msg} [{code[:200]}]"


def _llm_status_for_error(error: Optional[str]) -> str:
    return "offline" if (error or "") in _OFFLINE_ERROR_CODES else "error"


def record_llm_failure(db: Session, doc: ServiceArchDoc, *, status: str, message: str,
                        code: Optional[str] = None, profile: str = "", model: str = "") -> None:
    doc.llm_status = status
    _audit(db, doc, action="update", scope="sync", status="failed", reason=_LLM_AUDIT_REASON,
           after_data={"llm_status": status, "error": message, "code": code,
                       "profile": profile or None, "model": model or None})


def recover_stale_pending(db: Session, doc: Optional[ServiceArchDoc]) -> bool:
    """pending 이 LLM_PENDING_TIMEOUT 을 넘기면 error 로 바꾸고 사유를 남긴다 (조회 시 호출).

    기준 시각은 updated_at — pending 진입 시 갱신된다. 다른 편집이 updated_at 을 밀면 복구가 늦어질 뿐
    잘못 error 가 되지는 않는다. 반환: 복구했으면 True.
    """
    if doc is None or doc.llm_status != "pending" or doc.updated_at is None:
        return False
    if datetime.utcnow() - doc.updated_at < LLM_PENDING_TIMEOUT:
        return False
    try:
        record_llm_failure(db, doc, status="error", message=LLM_PENDING_TIMEOUT_MESSAGE, code="pending_timeout")
        db.commit()
        db.refresh(doc)
        return True
    except Exception as e:  # noqa: BLE001 — 복구 실패가 조회를 막지 않게
        db.rollback()
        logger.warning("arch doc pending 복구 실패 doc=%s: %s", doc.id, e)
        return False


def is_pending_stale(doc_status: Optional[str], updated_at: Optional[datetime]) -> bool:
    """목록처럼 쓰기 없이 표시만 할 때 — pending 이 시간 초과인지."""
    return (doc_status == "pending" and updated_at is not None
            and datetime.utcnow() - updated_at >= LLM_PENDING_TIMEOUT)


def llm_error_for(db: Session, doc: Optional[ServiceArchDoc]) -> Optional[str]:
    """현재 llm_status 의 실패 사유. 성공·미시도·진행 중이면 None."""
    if doc is None:
        return None
    status = doc.llm_status
    if status == LLM_STATUS_FAILED_NO_NODES:
        return LLM_NO_NODES_MESSAGE
    if status not in ("offline", "error"):
        return None
    try:
        row = (
            db.query(TopologyAuditLog)
            .filter(TopologyAuditLog.entity_type == "arch_doc",
                    TopologyAuditLog.entity_id == str(doc.lake_service_id),
                    TopologyAuditLog.reason == _LLM_AUDIT_REASON,
                    TopologyAuditLog.status == "failed")
            .order_by(TopologyAuditLog.created_at.desc())
            .first()
        )
        msg = (row.after_data or {}).get("error") if row is not None else None
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.debug("arch doc llm_error 조회 실패: %s", e)
        msg = None
    if msg:
        return str(msg)
    # 사유 기록 이전(구버전)에 남은 상태
    return ("LLM 서버에 연결할 수 없습니다 (사유 기록 없음)" if status == "offline"
            else "LLM 호출 실패 (사유 기록 없음)")


def _owner_llm_tenant(db: Session, cluster_id) -> Optional[dict]:
    """클러스터 소유 테넌트의 LLM 라우팅 컨텍스트 (정책 ⑨, D-114 와 같은 방식). 실패하면 None(전역 설정)."""
    try:
        from app.services.tenant_concurrency import owner_tenant
        from app.services.tenant_scope import llm_tenant_dict
        return llm_tenant_dict(owner_tenant(db, cluster_id))
    except Exception:  # noqa: BLE001
        logger.warning("arch doc: 소유 테넌트 조회 실패 (cluster=%s) — 전역 LLM 설정 사용", cluster_id, exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            logger.debug("arch doc: rollback 실패", exc_info=True)
        return None


async def generate_llm_content(
    db: Session, doc: ServiceArchDoc, service: LakeService,
) -> ServiceArchDoc:
    """LLM 요약/역할/플로우 생성. never raises — 실패는 llm_status + llm_error(감사 행)로만 표시.

    실패해도 기존 llm_content 는 보존한다. LLM 호출은 클러스터 소유 테넌트의 라우팅 컨텍스트 안에서 한다
    (수동 재생성·Celery 동일).
    """
    from app.services.llm.service import llm_service, llm_tenant_context

    if not (doc.auto_graph or {}).get("nodes"):
        doc.llm_status = LLM_STATUS_FAILED_NO_NODES
        db.commit()
        db.refresh(doc)
        return doc

    tenant = _owner_llm_tenant(db, doc.cluster_id)
    doc.llm_status = "pending"
    db.commit()

    try:
        with llm_tenant_context(tenant):
            result = await llm_service.chat_for_purpose("arch_doc", build_llm_prompt(doc, service))
        status, text = result.status, result.text or ""
        error, profile, model = result.error, result.profile or "", result.model or ""
    except Exception as e:  # noqa: BLE001  (방어 — 게이트웨이는 원래 raise 하지 않음)
        logger.exception("arch doc LLM 호출 실패: %s", e)
        status, text, error, profile, model = "error", "", f"exception: {str(e)[:180]}", "", ""

    if status != "ok":
        record_llm_failure(
            db, doc, status=_llm_status_for_error(error),
            message=describe_llm_error(error, profile=profile, model=model),
            code=error, profile=profile, model=model,
        )
        db.commit()
        db.refresh(doc)
        return doc

    content = _filter_known_node_ids(parse_llm_response(text), doc)
    content["model"] = model
    content["generated_at"] = datetime.utcnow().isoformat()
    doc.llm_content = content
    doc.llm_status = "ok"
    _audit(db, doc, action="update", scope="sync", status="success",
           reason=_LLM_AUDIT_REASON, after_data={"model": content["model"],
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
    """모듈별 문서 요약 — LakeService 목록 기준 (문서 미생성 모듈 포함).

    권한 판정은 라우터가 한다(cluster_id 없는 전체 목록은 admin 전용). 시간 초과 pending 은
    표시만 error 로 바꾼다(기록은 문서 조회 시 :func:`recover_stale_pending`).
    """
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
            "llm_status": (
                "error" if d and is_pending_stale(d.llm_status, d.updated_at)
                else (d.llm_status if d else "none")
            ),
            "auto_sync_enabled": d.auto_sync_enabled if d else True,
            "drift_counts": (
                {k: len(v) for k, v in drift.items() if isinstance(v, list)} if drift else None
            ),
        })
    return out
