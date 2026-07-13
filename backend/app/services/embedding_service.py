"""
Embedding Service — Fail-Safe wrapper around Ollama's ``/api/embeddings``.

Same fail-safe convention as ``agent_service.AIAgentService``: every exception
is caught and ``None`` is returned instead of raising, so a missing/offline
embedding model never breaks a WorkItem/WorkGuide write — embedding
computation always runs out-of-band via a Celery task (see
``app.celery_app.compute_work_item_embedding`` / ``compute_work_guide_embedding``),
never on the synchronous request path.
"""

import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class EmbeddingService:
    """Resilient proxy to a local Ollama embedding model."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
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
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/api/embeddings",
                    json={"model": self.model, "prompt": text},
                )
                resp.raise_for_status()
                data = resp.json()
                embedding = data.get("embedding")
                if not embedding:
                    logger.warning("Ollama embeddings response missing 'embedding' field")
                    return None
                return embedding
        except httpx.ConnectError:
            logger.warning("Ollama connect error — embedding model may not be deployed.")
            return None
        except httpx.TimeoutException:
            logger.warning("Ollama embeddings request timed out after %ss.", self.timeout)
            return None
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "Ollama embeddings returned HTTP %s: %s",
                exc.response.status_code, exc.response.text[:200],
            )
            return None
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error calling Ollama embeddings: %s", exc)
            return None


def build_embedding_text(title: Optional[str], content: Optional[str]) -> str:
    """제목 + 본문을 하나의 임베딩 입력 텍스트로 합친다 (WorkItem/WorkGuide 공용)."""
    parts = [p.strip() for p in (title, content) if p and p.strip()]
    return "\n\n".join(parts)


# Module-level singleton for convenience
embedding_service = EmbeddingService()
