"""LLM provider 공통 계약.

Provider 는 절대 예외를 전파하지 않는다 — 모든 실패는 ``LLMResult(status=...)`` 로
구조화해 반환한다 (agent_service/prometheus_service 와 동일한 fail-safe 컨벤션).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional


@dataclass
class LLMResult:
    """단일 LLM 호출 결과 — provider 종류와 무관한 공통 형태."""

    status: str                      # "ok" | "offline" | "error"
    text: str = ""
    model: str = ""
    profile: str = ""                # 응답을 만든 프로필 이름 (fallback 추적용)
    latency_ms: int = 0
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    error: Optional[str] = None


@dataclass
class LLMStreamChunk:
    """스트리밍 청크 — 중간 청크는 ``delta`` 만, 마지막 청크는 ``done=True`` + 메타데이터.

    ``status`` 는 ``done=True`` 청크에서만 의미가 있다("ok"|"offline"|"error").
    중간 청크의 status 는 "ok" 고정(스트림이 이어지고 있다는 뜻일 뿐).
    """

    delta: str = ""
    done: bool = False
    status: str = "ok"
    model: str = ""
    profile: str = ""
    error: Optional[str] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None


@dataclass
class LLMProfile:
    """엔드포인트 프로필 — AppSetting ``llm_settings.profiles[]`` 의 한 항목.

    ``api_key_ref`` 는 키 원문이 아니라 참조 문자열이다:
    ``credential:<name>`` (llm_credentials 테이블, 암호화 저장) |
    ``env:<VAR>`` (환경변수) | ``""`` (키 없음 — Ollama).
    """

    name: str
    provider: str                    # "ollama" | "openai_compat"
    base_url: str
    model: str
    api_key_ref: str = ""
    timeout_seconds: int = 120
    max_concurrency: int = 2
    enabled: bool = True
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict) -> "LLMProfile":
        return cls(
            name=str(raw.get("name", "")).strip(),
            provider=str(raw.get("provider", "ollama")).strip().lower(),
            base_url=str(raw.get("base_url", "")).rstrip("/"),
            model=str(raw.get("model", "")),
            api_key_ref=str(raw.get("api_key_ref", "") or ""),
            timeout_seconds=int(raw.get("timeout_seconds") or 120),
            max_concurrency=max(1, int(raw.get("max_concurrency") or 2)),
            enabled=bool(raw.get("enabled", True)),
        )


class BaseLLMProvider(ABC):
    """Provider 구현 계약. 모든 메서드는 예외를 잡아 구조화된 결과를 반환한다."""

    def __init__(self, profile: LLMProfile, api_key: Optional[str] = None):
        self.profile = profile
        self.api_key = api_key or None

    @abstractmethod
    async def chat(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> LLMResult:
        """단발 프롬프트 호출. 절대 raise 하지 않는다."""

    @abstractmethod
    def chat_stream(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> AsyncIterator[LLMStreamChunk]:
        """토큰 단위 스트리밍 호출. 마지막 청크는 항상 ``done=True`` 로 끝난다
        (정상/오류 모두). 첫 청크 이전 연결 실패는 게이트웨이가 fallback 판단에
        쓸 수 있도록 ``done=True, status="offline"|"error"`` 단일 청크만 방출한다."""

    @abstractmethod
    async def embed(self, text: str, *, model: Optional[str] = None) -> Optional[list[float]]:
        """임베딩 벡터 반환. 실패 시 None (절대 raise 하지 않는다)."""

    @abstractmethod
    async def health(self) -> dict:
        """{"status": "online"|"offline", "model": str, "detail": str, "latency_ms": int}"""

    @abstractmethod
    async def list_models(self) -> list[str]:
        """엔드포인트가 제공하는 모델 이름 목록. 실패 시 빈 목록."""
