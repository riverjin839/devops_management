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
) -> list[dict[str, Any]]:
    """query_text 와 유사한 내부 문서 상위 k 건을 Citation 목록으로 반환.

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

    wanted = set(source_types or ("work_guide", "work_item", "ops_note", "ontology_event"))
    candidates: list[dict[str, Any]] = []

    if "work_guide" in wanted:
        candidates += _search_work_guides(db, vector, k)
    if "work_item" in wanted:
        candidates += _search_work_items(db, vector, k)
    if "ops_note" in wanted:
        candidates += _search_ops_notes(db, vector, k)
    if "ontology_event" in wanted:
        candidates += _search_ontology_events(db, vector, k)

    candidates = [c for c in candidates if c["similarity"] >= MIN_SIMILARITY]
    candidates.sort(key=lambda c: c["similarity"], reverse=True)
    return candidates[:k]


def _search_work_guides(db: Session, vector: list[float], k: int) -> list[dict]:
    try:
        from app.models.work_guide import WorkGuide
        dist = WorkGuide.embedding.cosine_distance(vector)
        rows = (
            db.query(WorkGuide, dist.label("dist"))
            .filter(WorkGuide.embedding.isnot(None))
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


def _search_work_items(db: Session, vector: list[float], k: int) -> list[dict]:
    try:
        from app.models.work_item import WorkItem
        dist = WorkItem.embedding.cosine_distance(vector)
        rows = (
            db.query(WorkItem, dist.label("dist"))
            .filter(WorkItem.embedding.isnot(None))
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


def _search_ops_notes(db: Session, vector: list[float], k: int) -> list[dict]:
    try:
        from app.models.ops_note import OpsNote
        dist = OpsNote.embedding.cosine_distance(vector)
        rows = (
            db.query(OpsNote, dist.label("dist"))
            .filter(OpsNote.embedding.isnot(None))
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


def _search_ontology_events(db: Session, vector: list[float], k: int) -> list[dict]:
    try:
        from app.models.ontology import OntologyEvent
        dist = OntologyEvent.embedding.cosine_distance(vector)
        rows = (
            db.query(OntologyEvent, dist.label("dist"))
            .filter(OntologyEvent.embedding.isnot(None))
            .order_by(dist)
            .limit(k)
            .all()
        )
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
