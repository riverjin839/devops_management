"""LLM 게이트웨이 — 프로필 × 용도(purpose) 라우팅의 단일 진입점.

- 설정 원천: AppSetting ``llm_settings`` (UI-First — Settings → AI/LLM 탭에서 편집).
  행이 없으면 환경변수(OLLAMA_URL / LLM_API_BASE …)로 기본 프로필을 합성한다.
- 용도별 primary → fallback 프로필 순서로 호출하고, 둘 다 실패하면
  ``status="offline"`` 결과를 반환한다 (호출부는 각자 fail-safe 처리 —
  분석은 rule_based 로, 챗은 오프라인 안내문으로).
- 프로필별 동시성은 프로세스 내 ``asyncio.Semaphore`` 로 제한한다 (이벤트 루프별
  분리 — Celery 태스크가 매번 새 루프를 만들어도 안전). 전역(다중 replica) 부하
  제한은 Phase 2 의 전용 Celery llm 큐가 담당한다.
- 호출량/지연/토큰 통계를 Redis 에 시간 버킷으로 적재한다 (fail-open —
  Redis 불가 시 통계만 포기하고 호출은 계속).
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, AsyncIterator, Optional

from app.config import settings
from app.services.llm.base import LLMProfile, LLMResult, LLMStreamChunk, BaseLLMProvider
from app.services.llm.ollama_provider import OllamaProvider
from app.services.llm.openai_provider import OpenAICompatProvider
from app.services.llm.prompts import get_system_prompt

logger = logging.getLogger(__name__)

LLM_SETTINGS_KEY = "llm_settings"

PURPOSES: tuple[str, ...] = (
    "chat",
    "incident_analysis",
    "review_summary",
    "arch_doc",
    "trends",
    "embedding",
)

_SETTINGS_CACHE_TTL_SECONDS = 60

_redis_client = None


def _get_redis():
    """통계 적재용 Redis — login_rate_limiter 와 동일한 fail-open 패턴."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as _redis
        _redis_client = _redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=1,
        )
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client


def default_llm_settings() -> dict:
    """AppSetting 행이 없을 때 환경변수로 합성하는 기본 설정.

    - ``local-ollama`` 프로필은 항상 존재 (기존 배포 무변경 호환).
    - ``LLM_API_BASE`` 가 설정돼 있으면 ``internal-llm``(openai_compat) 프로필을 추가
      하되, 라우팅 기본값은 보수적으로 local-ollama 유지 — 전환은 운영자가 UI 에서
      명시적으로 한다 (점진 롤아웃 원칙).
    """
    profiles: list[dict] = [{
        "name": "local-ollama",
        "provider": "ollama",
        "base_url": settings.ollama_url.rstrip("/"),
        "model": settings.ollama_model,
        "api_key_ref": "",
        "timeout_seconds": settings.ollama_timeout,
        "max_concurrency": 2,
        "enabled": True,
    }]
    if settings.llm_api_base:
        profiles.append({
            "name": "internal-llm",
            "provider": "openai_compat",
            "base_url": settings.llm_api_base.rstrip("/"),
            "model": settings.llm_model or "",
            "api_key_ref": "env:LLM_API_KEY" if settings.llm_api_key else "",
            "timeout_seconds": settings.llm_timeout,
            "max_concurrency": 4,
            "enabled": True,
        })
    routing = {p: {"primary": "local-ollama", "fallback": None} for p in PURPOSES}
    return {
        "language": "ko",
        "analyzer_backend": (settings.analyzer_backend or "rule_based").lower().strip(),
        "embedding_model": settings.embedding_model,
        "profiles": profiles,
        "routing": routing,
    }


def merge_llm_settings(stored: Optional[dict]) -> dict:
    """저장값 위에 기본값을 방어적으로 병합 (alert 설정과 동일한 defensive merge).

    - 미지의 purpose 는 기본 라우팅으로 채운다.
    - profiles 가 비면 기본 프로필로 대체한다.
    """
    base = default_llm_settings()
    if not isinstance(stored, dict):
        return base
    out = dict(base)
    if isinstance(stored.get("language"), str) and stored["language"].strip():
        out["language"] = stored["language"].strip().lower()
    if isinstance(stored.get("analyzer_backend"), str) and stored["analyzer_backend"].strip():
        out["analyzer_backend"] = stored["analyzer_backend"].strip().lower()
    if isinstance(stored.get("embedding_model"), str) and stored["embedding_model"].strip():
        out["embedding_model"] = stored["embedding_model"].strip()
    raw_profiles = stored.get("profiles")
    if isinstance(raw_profiles, list) and raw_profiles:
        cleaned: list[dict] = []
        seen: set[str] = set()
        for raw in raw_profiles:
            if not isinstance(raw, dict):
                continue
            try:
                prof = LLMProfile.from_dict(raw)
            except Exception:  # noqa: BLE001
                continue
            if not prof.name or prof.name in seen:
                continue
            if prof.provider not in ("ollama", "openai_compat"):
                continue
            if not prof.base_url:
                continue
            seen.add(prof.name)
            cleaned.append({
                "name": prof.name, "provider": prof.provider, "base_url": prof.base_url,
                "model": prof.model, "api_key_ref": prof.api_key_ref,
                "timeout_seconds": prof.timeout_seconds,
                "max_concurrency": prof.max_concurrency, "enabled": prof.enabled,
            })
        if cleaned:
            out["profiles"] = cleaned
    profile_names = {p["name"] for p in out["profiles"]}
    routing = dict(out["routing"])
    raw_routing = stored.get("routing")
    if isinstance(raw_routing, dict):
        for purpose in PURPOSES:
            entry = raw_routing.get(purpose)
            if not isinstance(entry, dict):
                continue
            primary = entry.get("primary")
            fallback = entry.get("fallback")
            routing[purpose] = {
                "primary": primary if primary in profile_names else routing[purpose]["primary"],
                "fallback": fallback if (fallback in profile_names and fallback != primary) else None,
            }
    # primary 가 더 이상 존재하지 않는 프로필을 가리키면 첫 프로필로 복구
    first = out["profiles"][0]["name"]
    for purpose in PURPOSES:
        if routing[purpose]["primary"] not in profile_names:
            routing[purpose]["primary"] = first
    out["routing"] = routing
    return out


class LLMService:
    """프로필 × 용도 라우팅 게이트웨이 (module-level singleton ``llm_service``)."""

    def __init__(self) -> None:
        self._cache: Optional[dict] = None
        self._cache_at: float = 0.0
        # (profile_name, loop_id) → Semaphore. 이벤트 루프별로 분리해야
        # Celery 태스크의 new_event_loop 브리지에서도 안전하다.
        self._semaphores: dict[tuple[str, int], asyncio.Semaphore] = {}

    # ── 설정 로딩 ────────────────────────────────────────────────────

    def resolve_settings(self, db=None) -> dict:
        """현재 유효 설정(defensive merge 적용)을 반환. 60초 TTL 캐시.

        ``db`` 를 넘기지 않으면 자체 세션을 짧게 연다. DB 조회 실패 시 env 기본값
        으로 폴백한다 (fail-safe — LLM 설정 조회가 새로운 장애점이 되면 안 된다).
        """
        now = time.monotonic()
        if self._cache is not None and (now - self._cache_at) < _SETTINGS_CACHE_TTL_SECONDS:
            return self._cache
        stored: Optional[dict] = None
        try:
            if db is not None:
                stored = self._load_stored(db)
            else:
                from app.database import SessionLocal  # 지연 import — 순환 방지
                session = SessionLocal()
                try:
                    stored = self._load_stored(session)
                finally:
                    session.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("llm_settings 조회 실패 — env 기본값 사용: %s", exc)
        merged = merge_llm_settings(stored)
        self._cache = merged
        self._cache_at = now
        return merged

    @staticmethod
    def _load_stored(db) -> Optional[dict]:
        from app.models.app_setting import AppSetting  # 지연 import
        row = db.query(AppSetting).filter(AppSetting.key == LLM_SETTINGS_KEY).first()
        return row.value if row is not None else None

    def invalidate_cache(self) -> None:
        """설정 저장 직후 호출 — 다음 호출부터 새 설정 반영."""
        self._cache = None
        self._cache_at = 0.0

    # ── 프로필/키 해석 ───────────────────────────────────────────────

    def get_profile(self, name: str, cfg: Optional[dict] = None) -> Optional[LLMProfile]:
        cfg = cfg or self.resolve_settings()
        for raw in cfg["profiles"]:
            if raw["name"] == name:
                return LLMProfile.from_dict(raw)
        return None

    def resolve_api_key(self, profile: LLMProfile) -> Optional[str]:
        """``api_key_ref`` 해석 — ``credential:<name>`` | ``env:<VAR>`` | ``""``.

        실패해도 raise 하지 않고 None 반환 (키 없는 호출은 provider 가 401 로 처리).
        """
        ref = (profile.api_key_ref or "").strip()
        if not ref:
            return None
        try:
            if ref.startswith("env:"):
                import os
                var = ref[len("env:"):].strip()
                # config Settings 로 선언된 표준 변수 우선, 그 외는 os.environ
                if var.upper() == "LLM_API_KEY" and settings.llm_api_key:
                    return settings.llm_api_key
                return os.environ.get(var) or None
            if ref.startswith("credential:"):
                name = ref[len("credential:"):].strip()
                from app.database import SessionLocal  # 지연 import
                from app.models.llm_credential import LlmCredential
                session = SessionLocal()
                try:
                    row = (
                        session.query(LlmCredential)
                        .filter(LlmCredential.name == name)
                        .first()
                    )
                    return row.api_key if row is not None else None
                finally:
                    session.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("api_key_ref '%s' 해석 실패: %s", ref, exc)
        return None

    def build_provider(self, profile: LLMProfile) -> BaseLLMProvider:
        api_key = self.resolve_api_key(profile)
        if profile.provider == "openai_compat":
            return OpenAICompatProvider(profile, api_key=api_key)
        return OllamaProvider(profile, api_key=api_key)

    # ── 핵심 호출 경로 ───────────────────────────────────────────────

    async def chat_for_purpose(
        self,
        purpose: str,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
        db=None,
    ) -> LLMResult:
        """용도별 라우팅에 따라 primary → fallback 순서로 호출한다.

        ``system`` 을 넘기지 않으면 purpose × language 기본 시스템 프롬프트를 쓴다.
        절대 raise 하지 않는다 — 모든 프로필 실패 시 마지막 실패 결과를 반환한다.
        """
        cfg = self.resolve_settings(db)
        if system is None:
            system = get_system_prompt(purpose, cfg.get("language", "ko"))
        # 시크릿 마스킹 — 게이트웨이 진입점에서 일괄 적용 (호출부 누락 방지).
        from app.services.llm.masking import mask_secrets
        prompt = mask_secrets(prompt)
        route = cfg["routing"].get(purpose) or cfg["routing"]["chat"]
        candidates = [route.get("primary"), route.get("fallback")]
        last: Optional[LLMResult] = None
        for name in candidates:
            if not name:
                continue
            profile = self.get_profile(name, cfg)
            if profile is None or not profile.enabled:
                continue
            provider = self.build_provider(profile)
            sem = self._semaphore_for(profile)
            async with sem:
                result = await provider.chat(prompt, system=system, options=options)
            self._record_stats(profile.name, purpose, result)
            if result.status == "ok":
                return result
            logger.warning(
                "LLM 호출 실패 (purpose=%s, profile=%s, status=%s, error=%s)%s",
                purpose, profile.name, result.status, result.error,
                " — fallback 시도" if name == route.get("primary") and route.get("fallback") else "",
            )
            last = result
        return last or LLMResult(status="offline", error="no_enabled_profile",
                                 profile="", model="")

    async def chat_stream_for_purpose(
        self,
        purpose: str,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
        db=None,
    ) -> AsyncIterator[LLMStreamChunk]:
        """스트리밍 버전 — primary → fallback 은 **아직 아무 델타도 방출하지 않았을 때만**
        시도한다. 이미 사용자에게 부분 응답을 보여준 뒤 중간에 끊기면, 다른 프로필로
        다시 시작해 이어붙이면 앞뒤가 안 맞는 답변이 되므로 그 자리에서 오류로 종료한다.

        절대 raise 하지 않는다 — 실패는 항상 ``done=True`` 청크로 알린다.
        """
        cfg = self.resolve_settings(db)
        if system is None:
            system = get_system_prompt(purpose, cfg.get("language", "ko"))
        from app.services.llm.masking import mask_secrets
        prompt = mask_secrets(prompt)
        route = cfg["routing"].get(purpose) or cfg["routing"]["chat"]
        candidates = [route.get("primary"), route.get("fallback")]

        last_error: Optional[LLMStreamChunk] = None
        for name in candidates:
            if not name:
                continue
            profile = self.get_profile(name, cfg)
            if profile is None or not profile.enabled:
                continue
            provider = self.build_provider(profile)
            sem = self._semaphore_for(profile)
            started = False
            start_time = time.monotonic()
            prompt_tokens = completion_tokens = None
            async with sem:
                async for chunk in provider.chat_stream(prompt, system=system, options=options):
                    if not chunk.done:
                        started = True
                        yield chunk
                        continue
                    prompt_tokens = chunk.prompt_tokens
                    completion_tokens = chunk.completion_tokens
                    if chunk.status == "ok" or started:
                        # 이미 델타를 보냈다면 성공/실패와 무관하게 여기서 스트림을 끝낸다
                        # (fallback 이 앞선 부분 응답과 이어붙지 않도록).
                        self._record_stats(profile.name, purpose, LLMResult(
                            status=chunk.status, profile=profile.name, model=chunk.model,
                            latency_ms=int((time.monotonic() - start_time) * 1000),
                            prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
                            error=chunk.error,
                        ))
                        yield chunk
                        return
                    # 델타 없이 바로 실패 — fallback 후보로 넘어간다.
                    self._record_stats(profile.name, purpose, LLMResult(
                        status=chunk.status, profile=profile.name, model=chunk.model,
                        latency_ms=int((time.monotonic() - start_time) * 1000), error=chunk.error,
                    ))
                    last_error = chunk
                    logger.warning(
                        "LLM 스트리밍 실패 (purpose=%s, profile=%s, status=%s, error=%s)%s",
                        purpose, profile.name, chunk.status, chunk.error,
                        " — fallback 시도" if name == route.get("primary") and route.get("fallback") else "",
                    )
        yield last_error or LLMStreamChunk(done=True, status="offline", error="no_enabled_profile")

    async def embed(self, text: str, *, db=None) -> Optional[list[float]]:
        """임베딩 — routing.embedding 프로필 + ``embedding_model`` 로 호출.

        모델은 프로필의 chat 모델이 아니라 ``llm_settings.embedding_model``
        (기본 nomic-embed-text, 768차원) 을 쓴다 — pgvector 컬럼 차원과 결합돼
        있어 함부로 바꾸면 기존 임베딩과 비교 불가 (UI 에서 경고).
        """
        if not text or not text.strip():
            return None
        cfg = self.resolve_settings(db)
        route = cfg["routing"].get("embedding") or {}
        embedding_model = cfg.get("embedding_model") or settings.embedding_model
        for name in (route.get("primary"), route.get("fallback")):
            if not name:
                continue
            profile = self.get_profile(name, cfg)
            if profile is None or not profile.enabled:
                continue
            # 임베딩은 짧은 호출 — 전용 타임아웃 사용
            profile.timeout_seconds = settings.embedding_timeout
            provider = self.build_provider(profile)
            vector = await provider.embed(text, model=embedding_model)
            if vector is not None:
                return vector
        return None

    # ── 운영/관리 ────────────────────────────────────────────────────

    async def health_all(self, db=None) -> list[dict]:
        """전 프로필 병렬 health — Settings 탭 상태 pill 데이터."""
        cfg = self.resolve_settings(db)
        profiles = [LLMProfile.from_dict(p) for p in cfg["profiles"]]

        async def _one(profile: LLMProfile) -> dict:
            provider = self.build_provider(profile)
            h = await provider.health()
            return {
                "profile": profile.name,
                "provider": profile.provider,
                "enabled": profile.enabled,
                "base_url": profile.base_url,
                **h,
            }

        return list(await asyncio.gather(*(_one(p) for p in profiles)))

    async def health_for_purpose(self, purpose: str, db=None) -> dict:
        """해당 용도의 primary 프로필 health (기존 /agent/health 호환)."""
        cfg = self.resolve_settings(db)
        route = cfg["routing"].get(purpose) or {}
        profile = self.get_profile(route.get("primary") or "", cfg)
        if profile is None:
            return {"status": "offline", "detail": "no_profile", "model": ""}
        provider = self.build_provider(profile)
        return await provider.health()

    async def list_profile_models(self, name: str, db=None) -> list[str]:
        profile = self.get_profile(name, self.resolve_settings(db))
        if profile is None:
            return []
        return await self.build_provider(profile).list_models()

    def first_ollama_profile(self, db=None) -> Optional[LLMProfile]:
        """Ollama 전용 기능(pull-model 등)을 위임할 첫 enabled ollama 프로필."""
        cfg = self.resolve_settings(db)
        for raw in cfg["profiles"]:
            if raw.get("provider") == "ollama" and raw.get("enabled", True):
                return LLMProfile.from_dict(raw)
        return None

    # ── 내부 ─────────────────────────────────────────────────────────

    def _semaphore_for(self, profile: LLMProfile) -> asyncio.Semaphore:
        try:
            loop_id = id(asyncio.get_running_loop())
        except RuntimeError:
            loop_id = 0
        key = (profile.name, loop_id)
        sem = self._semaphores.get(key)
        if sem is None:
            sem = asyncio.Semaphore(profile.max_concurrency)
            # 오래된 루프의 세마포어가 무한히 쌓이지 않도록 가볍게 정리
            if len(self._semaphores) > 64:
                self._semaphores.clear()
            self._semaphores[key] = sem
        return sem

    @staticmethod
    def _record_stats(profile_name: str, purpose: str, result: LLMResult) -> None:
        """Redis 시간 버킷 통계 (fail-open). Settings 탭 사용량 대시보드의 데이터 소스."""
        client = _get_redis()
        if not client:
            return
        try:
            bucket = datetime.utcnow().strftime("%Y%m%d%H")
            key = f"llm:stats:{profile_name}:{purpose}:{bucket}"
            pipe = client.pipeline()
            pipe.hincrby(key, "count", 1)
            if result.status != "ok":
                pipe.hincrby(key, "errors", 1)
            pipe.hincrby(key, "latency_ms_sum", max(0, result.latency_ms))
            if result.prompt_tokens:
                pipe.hincrby(key, "prompt_tokens", int(result.prompt_tokens))
            if result.completion_tokens:
                pipe.hincrby(key, "completion_tokens", int(result.completion_tokens))
            pipe.expire(key, 25 * 3600)
            pipe.execute()
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def usage_stats() -> list[dict]:
        """최근 24h 시간버킷 통계 집계 — ``GET /llm/usage`` 응답 데이터."""
        client = _get_redis()
        if not client:
            return []
        out: list[dict] = []
        try:
            for raw_key in client.scan_iter(match="llm:stats:*", count=500):
                key = raw_key.decode() if isinstance(raw_key, bytes) else str(raw_key)
                parts = key.split(":")
                if len(parts) != 5:
                    continue
                _, _, profile_name, purpose, bucket = parts
                h = client.hgetall(key)
                data = {
                    (k.decode() if isinstance(k, bytes) else k):
                    int(v.decode() if isinstance(v, bytes) else v)
                    for k, v in h.items()
                }
                count = data.get("count", 0)
                out.append({
                    "profile": profile_name,
                    "purpose": purpose,
                    "bucket": bucket,
                    "count": count,
                    "errors": data.get("errors", 0),
                    "avg_latency_ms": (data.get("latency_ms_sum", 0) // count) if count else 0,
                    "prompt_tokens": data.get("prompt_tokens", 0),
                    "completion_tokens": data.get("completion_tokens", 0),
                })
        except Exception:  # noqa: BLE001
            return out
        out.sort(key=lambda x: (x["bucket"], x["profile"], x["purpose"]), reverse=True)
        return out


# Module-level singleton
llm_service = LLMService()
