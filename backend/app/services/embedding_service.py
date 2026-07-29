"""
Embedding Service — ``services/llm`` 게이트웨이 위임 (purpose="embedding").

Same fail-safe convention as ``agent_service.AIAgentService``: every exception
is caught and ``None`` is returned instead of raising, so a missing/offline
embedding model never breaks a WorkItem/WorkGuide write — embedding
computation always runs out-of-band via a Celery task (see
``app.celery_app.compute_work_item_embedding`` / ``compute_work_guide_embedding``),
never on the synchronous request path.

주의: 임베딩 모델(기본 nomic-embed-text, 768차원)은 pgvector 컬럼 차원과 결합돼
있다 — 모델을 바꾸면 기존 저장 임베딩과 비교 불가(전체 재계산 필요).
"""

import logging
from typing import Optional

from app.config import settings
from app.services.llm import llm_service

logger = logging.getLogger(__name__)


class EmbeddingService:
    """Resilient proxy — 실제 호출은 llm_service (routing.embedding 프로필) 가 한다."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
        # 레거시 호환 필드 (표시용) — 실제 라우팅은 llm_settings 가 결정한다.
        self.base_url = (base_url or settings.ollama_url).rstrip("/")
        self.model = model or settings.embedding_model
        self.timeout = timeout or settings.embedding_timeout

    async def embed(self, text: str) -> Optional[list[float]]:
        """Return the embedding vector for ``text``, or ``None`` if unavailable.

        Never raises — mirrors ``AIAgentService.ask_agent``'s fail-safe contract.
        """
        if not text or not text.strip():
            return None
        try:
            return await llm_service.embed(text)
        except Exception as exc:  # noqa: BLE001  (방어 — 게이트웨이는 원래 raise 하지 않음)
            logger.exception("Unexpected error calling embedding gateway: %s", exc)
            return None


def build_embedding_text(title: Optional[str], content: Optional[str]) -> str:
    """제목 + 본문을 하나의 임베딩 입력 텍스트로 합친다 (WorkItem/WorkGuide 공용)."""
    parts = [p.strip() for p in (title, content) if p and p.strip()]
    return "\n\n".join(parts)


# Module-level singleton for convenience
embedding_service = EmbeddingService()
