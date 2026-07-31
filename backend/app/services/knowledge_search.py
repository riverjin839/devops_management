"""지식(WorkGuide) 검색 서비스 — 시맨틱(pgvector) + ILIKE fallback.

라우터(`work_guide.py`)가 아닌 서비스로 분리한 이유: 이후 장애 분석기(analyzers)가
related_runbooks 를 실제 저장 문서로 채우는 RAG 확장 시 같은 함수를 호출하기 위함.

동작:
1. 쿼리 텍스트를 Ollama 임베딩(`embedding_service.embed`)으로 벡터화 → cosine_distance 정렬.
2. 임베딩 불가(Ollama 미기동)·pgvector 부재(DBAPIError) 시 제목/본문 ILIKE 로 폴백 —
   실패가 아니라 "시맨틱 아직 준비 안 됨" (`embedding_available=False`).
"""
from __future__ import annotations

import html as html_mod
import re

from sqlalchemy import or_
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models.work_guide import WorkGuide

_SNIPPET_LEN = 200


def strip_html_text(value: str | None) -> str:
    """HTML → 평문 (frontend lib/utils.ts 의 stripHtml 백엔드 대응)."""
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", value)
    text = html_mod.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _snippet(guide: WorkGuide) -> str:
    return strip_html_text(guide.content)[:_SNIPPET_LEN]


def _row(guide: WorkGuide, similarity: float | None) -> dict:
    return {
        "id": guide.id,
        "title": guide.title,
        "category": guide.category,
        "status": guide.status,
        "author": guide.author,
        "source": guide.source or "pep",
        "confluence_url": guide.confluence_url,
        "updated_at": guide.updated_at,
        "similarity": similarity,
        "snippet": _snippet(guide),
    }


def _ilike_search(db: Session, q: str, limit: int) -> list[dict]:
    pattern = f"%{q}%"
    rows = (
        db.query(WorkGuide)
        .filter(or_(WorkGuide.title.ilike(pattern), WorkGuide.content.ilike(pattern)))
        .order_by(WorkGuide.updated_at.desc())
        .limit(limit)
        .all()
    )
    return [_row(g, None) for g in rows]


async def search_guides(db: Session, q: str, limit: int = 10) -> dict:
    """반환 {"items": [...], "embedding_available": bool}. 절대 raise 하지 않는다."""
    q = (q or "").strip()
    if not q:
        return {"items": [], "embedding_available": False}
    limit = max(1, min(int(limit), 50))

    from app.services.embedding_service import embedding_service

    vector = await embedding_service.embed(q)
    if vector is None:
        return {"items": _ilike_search(db, q, limit), "embedding_available": False}
    try:
        distance = WorkGuide.embedding.cosine_distance(vector).label("distance")
        rows = (
            db.query(WorkGuide, distance)
            .filter(WorkGuide.embedding.isnot(None))
            .order_by(distance.asc())
            .limit(limit)
            .all()
        )
    except DBAPIError:
        # pgvector 확장/컬럼이 없는 환경 (마이그레이션 fail-open) — ILIKE 로 폴백
        db.rollback()
        return {"items": _ilike_search(db, q, limit), "embedding_available": False}
    return {
        "items": [_row(g, max(0.0, 1.0 - dist)) for g, dist in rows],
        "embedding_available": True,
    }
