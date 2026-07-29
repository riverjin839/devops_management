"""OpenAI-호환 API provider — 사내 LLM 서비스(vLLM, LiteLLM, 사내 게이트웨이 등) 연결용.

``POST {base_url}/v1/chat/completions`` (Bearer 인증 optional) 를 호출한다.
사내 게이트웨이가 표준과 미세하게 다를 수 있어 응답 파싱은 방어적으로 한다 —
어떤 형태 불일치도 예외 전파 없이 ``status="error"`` 로 구조화한다.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

import httpx

from app.services.llm.base import BaseLLMProvider, LLMResult

logger = logging.getLogger(__name__)


class OpenAICompatProvider(BaseLLMProvider):
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def chat(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> LLMResult:
        p = self.profile
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        payload: dict = {"model": p.model, "messages": messages, "stream": False}
        if options:
            # Ollama options 형태({"temperature":…, "num_predict":…})를 OpenAI 파라미터로 변환
            if "temperature" in options:
                payload["temperature"] = options["temperature"]
            if "num_predict" in options:
                payload["max_tokens"] = options["num_predict"]
            if "max_tokens" in options:
                payload["max_tokens"] = options["max_tokens"]
        start = datetime.utcnow()
        try:
            async with httpx.AsyncClient(timeout=p.timeout_seconds) as client:
                resp = await client.post(
                    f"{p.base_url}/v1/chat/completions",
                    json=payload,
                    headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()
                choices = data.get("choices") or []
                content = ""
                if choices and isinstance(choices[0], dict):
                    content = ((choices[0].get("message") or {}).get("content")) or ""
                if not content:
                    logger.warning("OpenAI-compat response missing content (profile=%s)", p.name)
                    return self._fail("error", "empty_or_unexpected_response", start)
                usage = data.get("usage") or {}
                return LLMResult(
                    status="ok",
                    text=content,
                    model=data.get("model", p.model),
                    profile=p.name,
                    latency_ms=_elapsed_ms(start),
                    prompt_tokens=usage.get("prompt_tokens"),
                    completion_tokens=usage.get("completion_tokens"),
                )
        except httpx.ConnectError:
            logger.warning("OpenAI-compat connect error (profile=%s)", p.name)
            return self._fail("offline", "connect_error", start)
        except httpx.TimeoutException:
            logger.warning("OpenAI-compat request timed out after %ss (profile=%s)", p.timeout_seconds, p.name)
            return self._fail("offline", f"timeout_{p.timeout_seconds}s", start)
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("OpenAI-compat returned HTTP %s (profile=%s): %s",
                           code, p.name, exc.response.text[:200])
            if code in (401, 403):
                return self._fail("error", f"auth_failed_http_{code}", start)
            return self._fail("error", f"http_{code}", start)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error calling OpenAI-compat endpoint (profile=%s): %s", p.name, exc)
            return self._fail("error", str(exc)[:200], start)

    async def embed(self, text: str, *, model: Optional[str] = None) -> Optional[list[float]]:
        if not text or not text.strip():
            return None
        p = self.profile
        try:
            async with httpx.AsyncClient(timeout=p.timeout_seconds) as client:
                resp = await client.post(
                    f"{p.base_url}/v1/embeddings",
                    json={"model": model or p.model, "input": text},
                    headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json().get("data") or []
                if data and isinstance(data[0], dict):
                    return data[0].get("embedding") or None
                return None
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI-compat embeddings failed (profile=%s): %s", p.name, exc)
            return None

    async def health(self) -> dict:
        p = self.profile
        start = datetime.utcnow()
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{p.base_url}/v1/models", headers=self._headers())
                if resp.status_code == 200:
                    return {"status": "online", "model": p.model, "detail": "",
                            "latency_ms": _elapsed_ms(start)}
                if resp.status_code in (401, 403):
                    return {"status": "offline", "model": p.model,
                            "detail": f"인증 실패 (HTTP {resp.status_code}) — API 키를 확인하세요.",
                            "latency_ms": _elapsed_ms(start)}
                return {"status": "offline", "model": p.model,
                        "detail": f"HTTP {resp.status_code}", "latency_ms": _elapsed_ms(start)}
        except Exception as exc:  # noqa: BLE001
            logger.debug("OpenAI-compat health-check failed (profile=%s): %s", p.name, exc)
            return {"status": "offline", "model": p.model, "detail": str(exc)[:200],
                    "latency_ms": _elapsed_ms(start)}

    async def list_models(self) -> list[str]:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.profile.base_url}/v1/models",
                                        headers=self._headers())
                if resp.status_code == 200:
                    data = resp.json().get("data") or []
                    return [m.get("id", "") for m in data if isinstance(m, dict)]
                return []
        except Exception:  # noqa: BLE001
            return []

    def _fail(self, status: str, error: str, start: datetime) -> LLMResult:
        return LLMResult(status=status, profile=self.profile.name,
                         model=self.profile.model, error=error,
                         latency_ms=_elapsed_ms(start))


def _elapsed_ms(start: datetime) -> int:
    return int((datetime.utcnow() - start).total_seconds() * 1000)
