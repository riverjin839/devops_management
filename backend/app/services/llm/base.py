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

    게이트웨이(Gateway API HTTPRoute·Ingress·사내 프록시) 뒤에 있는 모델 서버를 화면에서
    맞출 수 있도록 경로·TLS·프록시·헤더 옵션을 둔다(UI-First). 기본값은 기존 동작과 같다.
    """

    name: str
    provider: str                    # "ollama" | "openai_compat"
    base_url: str
    model: str
    api_key_ref: str = ""
    timeout_seconds: int = 120
    max_concurrency: int = 2
    enabled: bool = True
    # ── 게이트웨이 / HTTPRoute 고급 옵션 ──
    api_path: str = "/v1"            # OpenAI 호환 API 접두사 ("" = 게이트웨이가 이미 붙임)
    tls_verify: bool = True          # https 인증서 검증
    ca_bundle: str = ""              # 파드 안 CA 번들 경로 (사내 CA)
    use_env_proxy: bool = True       # HTTP(S)_PROXY / NO_PROXY 환경변수 사용(httpx trust_env)
    host_header: str = ""            # Host 헤더 덮어쓰기 — IP 로 붙되 HTTPRoute hostnames 로 매칭
    auth_header: str = "Authorization"
    auth_scheme: str = "Bearer"      # "" 이면 키 원문만 보낸다 (api-key: <key>)
    extra_headers: dict[str, str] = field(default_factory=dict)  # 비밀 아닌 값만 (헤더 매칭 등)
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict) -> "LLMProfile":
        api_path = raw.get("api_path", "/v1")
        api_path = "/v1" if api_path is None else str(api_path).strip()
        if api_path and not api_path.startswith("/"):
            api_path = "/" + api_path
        extra_headers = _normalize_headers(raw.get("extra_headers"))
        return cls(
            name=str(raw.get("name", "")).strip(),
            provider=str(raw.get("provider", "ollama")).strip().lower(),
            base_url=str(raw.get("base_url", "")).strip().rstrip("/"),
            model=str(raw.get("model", "")).strip(),
            api_key_ref=str(raw.get("api_key_ref", "") or ""),
            timeout_seconds=int(raw.get("timeout_seconds") or 120),
            max_concurrency=max(1, int(raw.get("max_concurrency") or 2)),
            enabled=bool(raw.get("enabled", True)),
            api_path=api_path.rstrip("/"),
            tls_verify=bool(raw.get("tls_verify", True)),
            ca_bundle=str(raw.get("ca_bundle", "") or "").strip(),
            use_env_proxy=bool(raw.get("use_env_proxy", True)),
            host_header=str(raw.get("host_header", "") or "").strip(),
            auth_header=str(raw.get("auth_header", "") or "").strip() or "Authorization",
            auth_scheme="Bearer" if raw.get("auth_scheme") is None else str(raw.get("auth_scheme")).strip(),
            extra_headers=extra_headers,
        )

    def advanced_dict(self) -> dict:
        """설정 저장/병합용 — 게이트웨이 고급 옵션만."""
        return {
            "api_path": self.api_path, "tls_verify": self.tls_verify, "ca_bundle": self.ca_bundle,
            "use_env_proxy": self.use_env_proxy, "host_header": self.host_header,
            "auth_header": self.auth_header, "auth_scheme": self.auth_scheme,
            # 리스트 형태로 저장/응답 — 프론트 axios 의 키 camel/snake 변환이 헤더 이름을 깨지 않게.
            "extra_headers": [{"name": k, "value": v} for k, v in self.extra_headers.items()],
        }

    # ── HTTP 헬퍼 (provider·진단 공용) ──

    def api_url(self, path: str) -> str:
        """OpenAI 호환 API URL — ``{base}{api_path}{path}``.

        base_url 이 이미 api_path(``/v1``)로 끝나면 중복으로 붙이지 않는다
        (``http://gw/qwen/v1`` + ``/v1/models`` → ``/v1/v1/models`` 404 방지).
        """
        base = self.base_url
        prefix = self.api_path
        if prefix and base.endswith(prefix):
            prefix = ""
        return f"{base}{prefix}{path}"

    def base_has_api_path(self) -> bool:
        return bool(self.api_path) and self.base_url.endswith(self.api_path)

    def client_kwargs(self, timeout: float) -> dict:
        """httpx.AsyncClient 인자 — 타임아웃·TLS 검증·환경 프록시."""
        verify: Any = self.tls_verify
        if self.tls_verify and self.ca_bundle:
            verify = self.ca_bundle
        return {"timeout": timeout, "verify": verify, "trust_env": self.use_env_proxy}

    def request_headers(self, api_key: Optional[str] = None, *, json_body: bool = False) -> dict:
        headers: dict[str, str] = {}
        if json_body:
            headers["Content-Type"] = "application/json"
        headers.update(self.extra_headers)
        if self.host_header:
            headers["Host"] = self.host_header
        if api_key:
            scheme = self.auth_scheme.strip()
            headers[self.auth_header or "Authorization"] = f"{scheme} {api_key}" if scheme else api_key
        return headers


def _normalize_headers(raw: Any) -> dict[str, str]:
    """추가 헤더 — ``[{"name","value"}]`` 리스트(화면 저장 형태) 또는 ``{name: value}`` dict 를 받는다."""
    out: dict[str, str] = {}
    if isinstance(raw, dict):
        items = list(raw.items())
    elif isinstance(raw, list):
        items = [(e.get("name"), e.get("value")) for e in raw if isinstance(e, dict)]
    else:
        return out
    for k, v in items:
        name = str(k or "").strip()
        if name and ":" not in name and "\n" not in name:
            out[name] = str(v if v is not None else "").strip()
    return out


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
        """단발 프롬프트 호출. 절대 raise 하지 않는다.

        ``options["json_schema"]`` (JSON Schema dict) 를 주면 provider 가 생성 단계에서 출력 형식을
        강제한다(Ollama ``format`` · OpenAI-호환 ``response_format``). 서버가 이를 지원하지 않아
        HTTP 400 을 내면 스키마 없이 한 번 다시 호출한다 — 호출부 파서는 그대로 둔다.
        """

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

    async def list_models_detailed(self) -> tuple[list[str], Optional[str]]:
        """모델 목록 + 실패 사유(화면 표시용). 기본 구현은 사유 없이 목록만."""
        models = await self.list_models()
        return models, None if models else "모델 목록이 비어 있다."
