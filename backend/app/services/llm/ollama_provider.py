"""Ollama 네이티브 API provider.

기존 ``agent_service._call_llm`` / ``embedding_service`` / ``local_llm_analyzer`` 에
흩어져 있던 Ollama 호출(``/api/generate``, ``/api/embeddings``, ``/api/tags``,
``/api/pull``)을 한 곳으로 이관한 구현. 동작(페이로드 형태, health 의 base-name
모델 매칭, fail-safe 메시지)은 기존과 동일하게 유지한다.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

import httpx

from app.services.llm.base import BaseLLMProvider, LLMResult

logger = logging.getLogger(__name__)


class OllamaProvider(BaseLLMProvider):
    async def chat(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> LLMResult:
        p = self.profile
        payload: dict = {
            "model": p.model,
            "prompt": prompt,
            "stream": False,
        }
        if system:
            payload["system"] = system
        if options:
            payload["options"] = options
        start = datetime.utcnow()
        try:
            async with httpx.AsyncClient(timeout=p.timeout_seconds) as client:
                resp = await client.post(f"{p.base_url}/api/generate", json=payload)
                resp.raise_for_status()
                data = resp.json()
                return LLMResult(
                    status="ok",
                    text=data.get("response", ""),
                    model=data.get("model", p.model),
                    profile=p.name,
                    latency_ms=_elapsed_ms(start),
                    prompt_tokens=data.get("prompt_eval_count"),
                    completion_tokens=data.get("eval_count"),
                )
        except httpx.ConnectError:
            logger.warning("Ollama connect error (profile=%s) — service may not be deployed.", p.name)
            return self._fail("offline", "connect_error", start)
        except httpx.TimeoutException:
            logger.warning("Ollama request timed out after %ss (profile=%s).", p.timeout_seconds, p.name)
            return self._fail("offline", f"timeout_{p.timeout_seconds}s", start)
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("Ollama returned HTTP %s (profile=%s): %s", code, p.name, exc.response.text[:200])
            if code == 404:
                return self._fail("error", f"model_not_found:{p.model}", start)
            return self._fail("error", f"http_{code}", start)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error calling Ollama (profile=%s): %s", p.name, exc)
            return self._fail("error", str(exc)[:200], start)

    async def embed(self, text: str, *, model: Optional[str] = None) -> Optional[list[float]]:
        if not text or not text.strip():
            return None
        p = self.profile
        try:
            async with httpx.AsyncClient(timeout=p.timeout_seconds) as client:
                resp = await client.post(
                    f"{p.base_url}/api/embeddings",
                    json={"model": model or p.model, "prompt": text},
                )
                resp.raise_for_status()
                embedding = resp.json().get("embedding")
                if not embedding:
                    logger.warning("Ollama embeddings response missing 'embedding' field (profile=%s)", p.name)
                    return None
                return embedding
        except Exception as exc:  # noqa: BLE001
            logger.warning("Ollama embeddings failed (profile=%s): %s", p.name, exc)
            return None

    async def health(self) -> dict:
        """기존 agent_service.health_check 로직 이관 — base-name 모델 매칭 유지."""
        p = self.profile
        start = datetime.utcnow()
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{p.base_url}/")
                if resp.status_code != 200:
                    return {"status": "offline", "model": p.model,
                            "detail": f"HTTP {resp.status_code}", "latency_ms": _elapsed_ms(start)}
                tags_resp = await client.get(f"{p.base_url}/api/tags")
                if tags_resp.status_code == 200:
                    models = tags_resp.json().get("models", [])
                    # Ollama 는 "qwen2.5:7b" 같은 전체 이름을 반환한다. 전체 이름 또는
                    # ":" 앞 base 이름으로 매칭 (model="qwen2.5" ↔ pulled "qwen2.5:7b").
                    full = [m.get("name", "") for m in models]
                    base = [n.split(":")[0] for n in full]
                    configured_base = p.model.split(":")[0]
                    if not (p.model in full or configured_base in base):
                        return {
                            "status": "online", "model": p.model, "latency_ms": _elapsed_ms(start),
                            "detail": (
                                f"Server running but model '{p.model}' not pulled. "
                                f"Available: {full or 'none'}"
                            ),
                        }
                return {"status": "online", "model": p.model, "detail": "",
                        "latency_ms": _elapsed_ms(start)}
        except Exception as exc:  # noqa: BLE001
            logger.debug("Ollama health-check failed (profile=%s): %s", p.name, exc)
            return {"status": "offline", "model": p.model, "detail": str(exc)[:200],
                    "latency_ms": _elapsed_ms(start)}

    async def list_models(self) -> list[str]:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.profile.base_url}/api/tags")
                if resp.status_code == 200:
                    return [m.get("name", "") for m in resp.json().get("models", [])]
                return []
        except Exception:  # noqa: BLE001
            return []

    async def pull_model(self, model: Optional[str] = None) -> dict:
        """Ollama 전용 — 모델 pull 트리거 (기존 agent_service.pull_model 이관)."""
        p = self.profile
        target = model or p.model
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{p.base_url}/api/pull",
                    json={"name": target, "stream": False},
                )
                if resp.status_code == 200:
                    return {"status": "ok", "message": f"Model '{target}' pull initiated."}
                return {"status": "error", "message": f"HTTP {resp.status_code}: {resp.text[:200]}"}
        except httpx.ConnectError:
            return {"status": "offline", "message": "Ollama service is not reachable."}
        except httpx.TimeoutException:
            return {"status": "ok", "message": (
                f"Model '{target}' pull started (large model, request timed out "
                "but pull continues server-side)."
            )}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Error pulling model: %s", exc)
            return {"status": "error", "message": str(exc)}

    def _fail(self, status: str, error: str, start: datetime) -> LLMResult:
        return LLMResult(status=status, profile=self.profile.name,
                         model=self.profile.model, error=error,
                         latency_ms=_elapsed_ms(start))


def _elapsed_ms(start: datetime) -> int:
    return int((datetime.utcnow() - start).total_seconds() * 1000)
