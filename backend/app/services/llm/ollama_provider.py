"""Ollama 네이티브 API provider.

기존 ``agent_service._call_llm`` / ``embedding_service`` / ``local_llm_analyzer`` 에
흩어져 있던 Ollama 호출(``/api/generate``, ``/api/embeddings``, ``/api/tags``,
``/api/pull``)을 한 곳으로 이관한 구현. 설정 모델명이 서버에 정확히 없으면(태그 불일치)
``pick_ollama_model`` 로 실제 모델명을 해석해 1회 재시도한다 — health 도 같은 규칙으로
판정해 "온라인인데 채팅만 404" 상태를 숨기지 않는다.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import AsyncIterator, Optional

import httpx

from app.services.llm.base import BaseLLMProvider, LLMResult, LLMStreamChunk

logger = logging.getLogger(__name__)

# (base_url, 설정 모델명) → 실제로 pull 돼 있는 모델명. 404 를 한 번 겪은 뒤 해석된 이름을
# 기억해 두어 다음 호출부터는 재시도 없이 바로 쓴다(프로세스 수명 동안 유지).
_RESOLVED_MODELS: dict[tuple[str, str], str] = {}


def pick_ollama_model(configured: str, available: list[str]) -> Optional[str]:
    """설정 모델명을 서버에 실제로 있는 모델명으로 해석한다. 못 찾으면 None.

    Ollama 는 태그 없는 이름을 ``:latest`` 로 해석하므로 ``qwen2.5-coder`` 로 설정하고
    ``qwen2.5-coder:7b`` 만 구워진 이미지에 보내면 404 가 난다. 이미지 태그(``:5b`` 등)와
    모델 태그가 다른 경우도 흔하다. 순서: 정확히 일치 → ``name:latest`` → 같은 base 이름
    (여러 개면 정렬 첫 번째 — 결정적으로).
    """
    if not configured or not available:
        return None
    if configured in available:
        return configured
    base = configured.split(":", 1)[0]
    if f"{base}:latest" in available:
        return f"{base}:latest"
    same = sorted(m for m in available if m.split(":", 1)[0] == base)
    return same[0] if same else None


class OllamaProvider(BaseLLMProvider):
    def _model(self) -> str:
        p = self.profile
        return _RESOLVED_MODELS.get((p.base_url, p.model), p.model)

    async def _resolve_missing(self, tried: str) -> Optional[str]:
        """404(model not found) 뒤 호출 — 서버 모델 목록에서 대체 이름을 찾아 기억한다."""
        available = await self.list_models()
        alt = pick_ollama_model(self.profile.model, available)
        if alt and alt != tried:
            logger.warning(
                "Ollama 모델 '%s' 이 서버에 없어 '%s' 로 자동 해석 (profile=%s, available=%s)",
                tried, alt, self.profile.name, available,
            )
            _RESOLVED_MODELS[(self.profile.base_url, self.profile.model)] = alt
            return alt
        return None

    async def chat(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> LLMResult:
        model = self._model()
        result = await self._chat_once(model, prompt, system=system, options=options)
        if (result.error or "").startswith("model_not_found"):
            alt = await self._resolve_missing(model)
            if alt:
                result = await self._chat_once(alt, prompt, system=system, options=options)
        return result

    async def _chat_once(
        self,
        model: str,
        prompt: str,
        *,
        system: Optional[str],
        options: Optional[dict],
    ) -> LLMResult:
        p = self.profile
        payload: dict = {
            "model": model,
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
                    model=data.get("model", model),
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
                return self._fail("error", f"model_not_found:{model}", start)
            return self._fail("error", f"http_{code}", start)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error calling Ollama (profile=%s): %s", p.name, exc)
            return self._fail("error", str(exc)[:200], start)

    async def chat_stream(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> AsyncIterator[LLMStreamChunk]:
        # 404 는 델타가 나오기 전에만 생기므로, 그때만 모델을 다시 해석해 한 번 재시도한다.
        model = self._model()
        async for chunk in self._stream_once(model, prompt, system=system, options=options):
            if chunk.done and (chunk.error or "").startswith("model_not_found"):
                alt = await self._resolve_missing(model)
                if alt:
                    async for c2 in self._stream_once(alt, prompt, system=system, options=options):
                        yield c2
                    return
            yield chunk

    async def _stream_once(
        self,
        model: str,
        prompt: str,
        *,
        system: Optional[str],
        options: Optional[dict],
    ) -> AsyncIterator[LLMStreamChunk]:
        p = self.profile
        payload: dict = {"model": model, "prompt": prompt, "stream": True}
        if system:
            payload["system"] = system
        if options:
            payload["options"] = options
        started = False
        try:
            async with httpx.AsyncClient(timeout=p.timeout_seconds) as client:
                async with client.stream("POST", f"{p.base_url}/api/generate", json=payload) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            obj = json.loads(line)
                        except ValueError:
                            continue
                        started = True
                        piece = obj.get("response", "")
                        if piece:
                            yield LLMStreamChunk(delta=piece, profile=p.name, model=obj.get("model", model))
                        if obj.get("done"):
                            yield LLMStreamChunk(
                                done=True, status="ok", profile=p.name,
                                model=obj.get("model", model),
                                prompt_tokens=obj.get("prompt_eval_count"),
                                completion_tokens=obj.get("eval_count"),
                            )
                            return
            # 스트림이 done:true 없이 끝난 경우 — 그래도 정상 종료로 처리.
            if started:
                yield LLMStreamChunk(done=True, status="ok", profile=p.name, model=model)
        except httpx.ConnectError:
            logger.warning("Ollama connect error (profile=%s, stream)", p.name)
            yield LLMStreamChunk(done=True, status="offline", profile=p.name, model=model, error="connect_error")
        except httpx.TimeoutException:
            logger.warning("Ollama stream timed out after %ss (profile=%s)", p.timeout_seconds, p.name)
            yield LLMStreamChunk(done=True, status="offline", profile=p.name, model=model,
                                 error=f"timeout_{p.timeout_seconds}s")
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("Ollama returned HTTP %s (profile=%s, stream)", code, p.name)
            error = f"model_not_found:{model}" if code == 404 else f"http_{code}"
            yield LLMStreamChunk(done=True, status="error", profile=p.name, model=model, error=error)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error in Ollama stream (profile=%s): %s", p.name, exc)
            yield LLMStreamChunk(done=True, status="error", profile=p.name, model=model, error=str(exc)[:200])

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
                    full = [m.get("name", "") for m in tags_resp.json().get("models", [])]
                    resolved = pick_ollama_model(p.model, full)
                    if resolved is None:
                        # 서버는 떠 있지만 채팅은 404 로 실패하는 상태 — detail 로 "모델 미준비" 를
                        # 띄운다. 구 base-name 매칭은 ``qwen2.5-coder`` ↔ ``qwen2.5-coder:7b`` 를
                        # 정상으로 판정했지만 /api/generate 는 정확한 이름이 아니면 404 였다.
                        return {
                            "status": "online", "model": p.model, "latency_ms": _elapsed_ms(start),
                            "model_ready": False, "available_models": full,
                            "detail": (
                                f"서버는 응답하지만 모델 '{p.model}' 이 없습니다. "
                                f"서버 모델: {', '.join(full) if full else '없음(이미지에 모델 미포함)'}"
                            ),
                        }
                    if resolved != p.model:
                        # 호출은 자동 해석으로 성공하므로 detail(=모델 미준비)은 비우고 힌트만 준다.
                        return {
                            "status": "online", "model": p.model, "detail": "",
                            "model_ready": True, "resolved_model": resolved,
                            "available_models": full, "latency_ms": _elapsed_ms(start),
                            "hint": f"설정 모델 '{p.model}' 대신 서버의 '{resolved}' 로 자동 해석해 호출합니다. "
                                    "프로필 모델명을 정확한 이름으로 맞추는 것을 권장합니다.",
                        }
                return {"status": "online", "model": p.model, "detail": "", "model_ready": True,
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
