"""RAG 검색 서비스 — PEP 내부 지식(작업 가이드/업무 이력/운영 노트) pgvector 검색.

AI 분석·챗봇 응답의 **근거·출처(citations)** 를 공급한다. 원칙
(docs/AIRGAP_LLM_ARCHITECTURE.md §0-4): 조치 가이드의 근거는 PEP 에 등록된
내부 문서다 — 외부 지식 의존 최소화, 모델 일반 지식 + 내부 문서 검색 조합.

Citation 형태 (JSONB 저장·API 응답·프론트 딥링크 공용):
    {"title", "source_type": "work_guide"|"work_item"|"ops_note"|"ontology_event",
     "ref_id", "route", "snippet", "similarity"}

fail-safe: 임베딩/DB 실패 시 빈 목록 반환 — 검색 실패가 분석/챗을 막지 않는다.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.services.llm import llm_service

logger = logging.getLogger(__name__)

# 이 값보다 유사도가 낮으면(=거리가 멀면) 근거로 쓰지 않는다 — 무관한 문서를
# 인용하는 것이 인용 없는 것보다 나쁘다.
MIN_SIMILARITY = 0.35
SNIPPET_CHARS = 300


def _snippet(*parts: Optional[str]) -> str:
    text = " ".join(p.strip() for p in parts if p and p.strip())
    return text[:SNIPPET_CHARS]


async def retrieve(
    db: Session,
    query_text: str,
    k: int = 4,
    source_types: Optional[list[str]] = None,
    *,
    cluster_scope: Any = None,
    tenant_scope: Any = None,
) -> list[dict[str, Any]]:
    """query_text 와 유사한 내부 문서 상위 k 건을 Citation 목록으로 반환.

    ``cluster_scope`` (``services.cluster_access.ClusterScope`` — ``.hidden`` 집합)를 주면 온톨로지 이벤트를
    그 사용자의 클러스터 가시 범위로 거른다. 없으면 fail-closed 기본 범위를 쓴다
    (:func:`_search_ontology_events` 참고).

    ``tenant_scope`` (``services.tenant_scope.TenantScope``)를 주면 작업 가이드·업무 이력·운영 노트를 그
    사용자의 테넌트 가시 범위(업무 항목은 소속 프로젝트 테넌트 포함)로 거른다. 없으면 fail-closed —
    공유(``tenant_id IS NULL``) 행만(업무 항목은 공유 프로젝트 소속이거나 프로젝트 없는 것만).

    절대 raise 하지 않는다 — 어떤 실패도 빈 목록으로 수렴.
    """
    if not query_text or not query_text.strip():
        return []
    try:
        vector = await llm_service.embed(query_text)
    except Exception:  # noqa: BLE001
        vector = None
    if vector is None:
        return []

    tscope = tenant_scope if tenant_scope is not None else _shared_only_scope()
    wanted = set(source_types or ("work_guide", "work_item", "ops_note", "ontology_event"))
    candidates: list[dict[str, Any]] = []

    if "work_guide" in wanted:
        candidates += _search_work_guides(db, vector, k, tscope)
    if "work_item" in wanted:
        candidates += _search_work_items(db, vector, k, tscope)
    if "ops_note" in wanted:
        candidates += _search_ops_notes(db, vector, k, tscope)
    if "ontology_event" in wanted:
        candidates += _search_ontology_events(db, vector, k, cluster_scope=cluster_scope)

    candidates = [c for c in candidates if c["similarity"] >= MIN_SIMILARITY]
    candidates.sort(key=lambda c: c["similarity"], reverse=True)
    return candidates[:k]


def _shared_only_scope():
    """사용자 맥락이 없는 호출의 fail-closed 범위 — 공유(``tenant_id IS NULL``) 행만 보인다."""
    from app.services.tenant_scope import TenantScope
    return TenantScope(is_admin=False, tenant_ids=frozenset())


def _search_work_guides(db: Session, vector: list[float], k: int, tscope: Any) -> list[dict]:
    try:
        from app.models.work_guide import WorkGuide
        dist = WorkGuide.embedding.cosine_distance(vector)
        q = db.query(WorkGuide, dist.label("dist")).filter(WorkGuide.embedding.isnot(None))
        rows = (
            tscope.apply(q, WorkGuide.tenant_id)
            .order_by(dist)
            .limit(k)
            .all()
        )
        return [{
            "title": g.title,
            "source_type": "work_guide",
            "ref_id": str(g.id),
            "route": f"/work-guides/{g.id}",
            "snippet": _snippet(g.content),
            "similarity": round(1.0 - float(d), 3),
        } for g, d in rows]
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.debug("work_guide RAG 검색 실패: %s", exc)
        return []


def _search_work_items(db: Session, vector: list[float], k: int, tscope: Any) -> list[dict]:
    try:
        from app.models.work_item import WorkItem
        from app.services.tenant_scope import work_item_visibility
        dist = WorkItem.embedding.cosine_distance(vector)
        q = db.query(WorkItem, dist.label("dist")).filter(WorkItem.embedding.isnot(None))
        rows = (
            work_item_visibility(tscope, q, db)  # 항목 tenant_id + 소속(비공개) 프로젝트 tenant_id
            .order_by(dist)
            .limit(k)
            .all()
        )
        return [{
            "title": w.title or (w.content or "")[:60],
            "source_type": "work_item",
            "ref_id": str(w.id),
            "route": f"/tasks-mgmt/{w.id}",
            "snippet": _snippet(w.content, getattr(w, "resolution", None)),
            "similarity": round(1.0 - float(d), 3),
        } for w, d in rows]
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.debug("work_item RAG 검색 실패: %s", exc)
        return []


def _search_ops_notes(db: Session, vector: list[float], k: int, tscope: Any) -> list[dict]:
    try:
        from app.models.ops_note import OpsNote
        dist = OpsNote.embedding.cosine_distance(vector)
        q = db.query(OpsNote, dist.label("dist")).filter(OpsNote.embedding.isnot(None))
        rows = (
            tscope.apply(q, OpsNote.tenant_id)
            .order_by(dist)
            .limit(k)
            .all()
        )
        return [{
            "title": n.title,
            "source_type": "ops_note",
            "ref_id": str(n.id),
            "route": f"/ops-notes/{n.id}",
            "snippet": _snippet(n.content, n.back_content),
            "similarity": round(1.0 - float(d), 3),
        } for n, d in rows]
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.debug("ops_note RAG 검색 실패: %s", exc)
        return []


# 영향 분석(what-if) 기록 — 실제 구성 변경 이력이 아니므로 근거 인용 대상이 아니다(A-17).
EXCLUDED_ONTOLOGY_CATEGORIES: frozenset[str] = frozenset({"impact_simulation"})


def _ontology_visibility_filter(query, cluster_scope: Any):
    """온톨로지 이벤트 쿼리에 클러스터 가시 범위를 건다.

    - ``cluster_scope`` 가 있으면 그 ``hidden`` 집합(바인딩 멤버가 아닌 클러스터)을 뺀다.
    - 없으면(사용자 맥락을 모르는 호출 — Agent 채팅·자동 분석 등) fail-closed:
      테넌트 바인딩이 없는 클러스터 + 현재 LLM 테넌트 컨텍스트(``llm_tenant_context``)에 바인딩된
      클러스터만 남긴다. 컨텍스트도 없으면 바인딩 없는 클러스터만.
    """
    from app.models.ontology import OntologyEvent
    from app.models.tenant import ClusterBinding

    if cluster_scope is not None:
        hidden = getattr(cluster_scope, "hidden", None) or frozenset()
        if hidden:
            query = query.filter(OntologyEvent.cluster_id.notin_(list(hidden)))
        return query

    cond = ~OntologyEvent.cluster_id.in_(query.session.query(ClusterBinding.cluster_id).distinct())
    try:
        from app.services.llm.service import current_llm_tenant
        tenant = current_llm_tenant()
    except Exception:  # noqa: BLE001
        tenant = None
    tenant_id = tenant.get("id") if isinstance(tenant, dict) else None
    if tenant_id:
        from uuid import UUID
        try:
            tid = UUID(str(tenant_id))
        except (TypeError, ValueError):
            tid = None
        if tid is not None:
            mine = query.session.query(ClusterBinding.cluster_id).filter(ClusterBinding.tenant_id == tid)
            cond = cond | OntologyEvent.cluster_id.in_(mine)
    return query.filter(cond)


def _search_ontology_events(
    db: Session, vector: list[float], k: int, *, cluster_scope: Any = None,
) -> list[dict]:
    try:
        from app.models.ontology import OntologyEvent
        dist = OntologyEvent.embedding.cosine_distance(vector)
        q = (
            db.query(OntologyEvent, dist.label("dist"))
            .filter(OntologyEvent.embedding.isnot(None))
            .filter(OntologyEvent.category.notin_(list(EXCLUDED_ONTOLOGY_CATEGORIES)))
        )
        q = _ontology_visibility_filter(q, cluster_scope)
        rows = q.order_by(dist).limit(k).all()
        return [{
            "title": e.title,
            "source_type": "ontology_event",
            "ref_id": str(e.id),
            "route": "/ontology",
            "snippet": _snippet(e.description, f"영향 리소스 {e.impacted_count}건"),
            "similarity": round(1.0 - float(d), 3),
        } for e, d in rows]
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.debug("ontology_event RAG 검색 실패: %s", exc)
        return []


def build_reference_block(citations: list[dict]) -> str:
    """프롬프트에 주입할 번호 매긴 '사내 참고자료' 블록."""
    if not citations:
        return ""
    lines = ["### 사내 참고자료 (근거로 인용할 것 — [번호] 형식)"]
    type_labels = {
        "work_guide": "작업 가이드", "work_item": "업무 이력", "ops_note": "운영 노트",
        "ontology_event": "구성변경 영향분석 이력",
    }
    for i, c in enumerate(citations, 1):
        label = type_labels.get(c["source_type"], c["source_type"])
        lines.append(f"[{i}] ({label}) {c['title']} — {c['snippet']}")
    return "\n".join(lines)
