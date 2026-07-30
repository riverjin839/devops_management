"""services/llm 게이트웨이 단위 테스트.

- env 합성/defensive merge (default_llm_settings / merge_llm_settings)
- purpose 라우팅: primary 실패 → fallback, 전부 실패 → offline
- api_key_ref 해석 (env: / 빈값)
- OpenAI-호환 provider 응답 파싱 (정상 / 비정상 / 인증 실패)
"""
from unittest.mock import MagicMock

import httpx
import pytest

from app.services.llm import ollama_provider as ollama_provider_module
from app.services.llm import openai_provider as openai_provider_module
from app.services.llm.base import LLMProfile, LLMResult, LLMStreamChunk
from app.services.llm.ollama_provider import OllamaProvider
from app.services.llm.openai_provider import OpenAICompatProvider
from app.services.llm.service import (
    LLMService,
    default_llm_settings,
    merge_llm_settings,
)


# ── 설정 합성 / merge ─────────────────────────────────────────────────────

def test_default_settings_always_has_local_ollama():
    cfg = default_llm_settings()
    names = [p["name"] for p in cfg["profiles"]]
    assert "local-ollama" in names
    assert cfg["language"] == "ko"
    for purpose in ("chat", "incident_analysis", "embedding"):
        assert cfg["routing"][purpose]["primary"] == "local-ollama"


def test_default_settings_synthesizes_internal_llm_from_env(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "llm_api_base", "http://llm-gw.corp:8000")
    monkeypatch.setattr(settings, "llm_model", "corp-model")
    monkeypatch.setattr(settings, "llm_api_key", "sk-test")
    cfg = default_llm_settings()
    internal = next(p for p in cfg["profiles"] if p["name"] == "internal-llm")
    assert internal["provider"] == "openai_compat"
    assert internal["api_key_ref"] == "env:LLM_API_KEY"
    # 라우팅 기본값은 보수적으로 local-ollama 유지 (점진 롤아웃)
    assert cfg["routing"]["chat"]["primary"] == "local-ollama"


def test_merge_falls_back_to_default_on_garbage():
    assert merge_llm_settings(None)["profiles"][0]["name"] == "local-ollama"
    assert merge_llm_settings({"profiles": "nope"})["profiles"][0]["name"] == "local-ollama"
    assert merge_llm_settings({"profiles": []})["profiles"][0]["name"] == "local-ollama"


def test_merge_keeps_stored_profiles_and_repairs_routing():
    stored = {
        "profiles": [
            {"name": "corp", "provider": "openai_compat", "base_url": "http://a", "model": "m"},
        ],
        "routing": {
            "chat": {"primary": "corp", "fallback": "ghost"},   # fallback 은 없는 프로필
            "trends": {"primary": "ghost"},                       # primary 도 없는 프로필
        },
    }
    m = merge_llm_settings(stored)
    assert [p["name"] for p in m["profiles"]] == ["corp"]
    assert m["routing"]["chat"] == {"primary": "corp", "fallback": None}
    # 존재하지 않는 primary 는 첫 프로필로 복구
    assert m["routing"]["trends"]["primary"] == "corp"
    # 저장에 없던 purpose 도 기본 라우팅으로 채워진다
    assert m["routing"]["embedding"]["primary"] == "corp"


def test_merge_rejects_invalid_provider_and_duplicates():
    stored = {"profiles": [
        {"name": "a", "provider": "ollama", "base_url": "http://x", "model": "m"},
        {"name": "a", "provider": "ollama", "base_url": "http://y", "model": "m"},   # dup
        {"name": "b", "provider": "wat", "base_url": "http://z", "model": "m"},      # bad provider
        {"name": "", "provider": "ollama", "base_url": "http://w", "model": "m"},    # empty name
    ]}
    m = merge_llm_settings(stored)
    assert [p["name"] for p in m["profiles"]] == ["a"]
    assert m["profiles"][0]["base_url"] == "http://x"


# ── purpose 라우팅 / fallback ─────────────────────────────────────────────

class _FakeProvider:
    def __init__(self, profile, result: LLMResult):
        self.profile = profile
        self._result = result

    async def chat(self, prompt, *, system=None, options=None):
        return self._result


def _service_with(monkeypatch, cfg: dict, results: dict[str, LLMResult]) -> LLMService:
    svc = LLMService()
    monkeypatch.setattr(svc, "resolve_settings", lambda db=None: merge_llm_settings(cfg))
    monkeypatch.setattr(
        svc, "build_provider",
        lambda profile: _FakeProvider(profile, results[profile.name]),
    )
    return svc


_TWO_PROFILE_CFG = {
    "profiles": [
        {"name": "corp", "provider": "openai_compat", "base_url": "http://a", "model": "m1"},
        {"name": "local", "provider": "ollama", "base_url": "http://b", "model": "m2"},
    ],
    "routing": {"chat": {"primary": "corp", "fallback": "local"}},
}


@pytest.mark.asyncio
async def test_chat_uses_primary_when_ok(monkeypatch):
    svc = _service_with(monkeypatch, _TWO_PROFILE_CFG, {
        "corp": LLMResult(status="ok", text="hi", model="m1", profile="corp"),
        "local": LLMResult(status="ok", text="bye", model="m2", profile="local"),
    })
    result = await svc.chat_for_purpose("chat", "q")
    assert result.profile == "corp"
    assert result.text == "hi"


@pytest.mark.asyncio
async def test_chat_falls_back_when_primary_fails(monkeypatch):
    svc = _service_with(monkeypatch, _TWO_PROFILE_CFG, {
        "corp": LLMResult(status="offline", profile="corp", error="connect_error"),
        "local": LLMResult(status="ok", text="bye", model="m2", profile="local"),
    })
    result = await svc.chat_for_purpose("chat", "q")
    assert result.status == "ok"
    assert result.profile == "local"


@pytest.mark.asyncio
async def test_chat_returns_last_failure_when_all_fail(monkeypatch):
    svc = _service_with(monkeypatch, _TWO_PROFILE_CFG, {
        "corp": LLMResult(status="offline", profile="corp", error="connect_error"),
        "local": LLMResult(status="error", profile="local", error="http_500"),
    })
    result = await svc.chat_for_purpose("chat", "q")
    assert result.status == "error"
    assert result.profile == "local"


@pytest.mark.asyncio
async def test_chat_skips_disabled_profile(monkeypatch):
    cfg = {
        "profiles": [
            {"name": "corp", "provider": "openai_compat", "base_url": "http://a",
             "model": "m1", "enabled": False},
            {"name": "local", "provider": "ollama", "base_url": "http://b", "model": "m2"},
        ],
        "routing": {"chat": {"primary": "corp", "fallback": "local"}},
    }
    svc = _service_with(monkeypatch, cfg, {
        "corp": LLMResult(status="ok", text="should not be used", profile="corp"),
        "local": LLMResult(status="ok", text="bye", model="m2", profile="local"),
    })
    result = await svc.chat_for_purpose("chat", "q")
    assert result.profile == "local"


# ── api_key_ref 해석 ─────────────────────────────────────────────────────

def test_resolve_api_key_empty_ref_returns_none():
    svc = LLMService()
    profile = LLMProfile(name="p", provider="ollama", base_url="http://x", model="m")
    assert svc.resolve_api_key(profile) is None


def test_resolve_api_key_env_ref(monkeypatch):
    monkeypatch.setenv("MY_LLM_KEY", "sk-abc")
    svc = LLMService()
    profile = LLMProfile(name="p", provider="openai_compat", base_url="http://x",
                         model="m", api_key_ref="env:MY_LLM_KEY")
    assert svc.resolve_api_key(profile) == "sk-abc"


def test_resolve_api_key_standard_env_var(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "llm_api_key", "sk-from-settings")
    svc = LLMService()
    profile = LLMProfile(name="p", provider="openai_compat", base_url="http://x",
                         model="m", api_key_ref="env:LLM_API_KEY")
    assert svc.resolve_api_key(profile) == "sk-from-settings"


# ── OpenAI-호환 provider 파싱 ─────────────────────────────────────────────

class _FakeAsyncClient:
    def __init__(self, behavior):
        self._behavior = behavior

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, *_args, **_kwargs):
        return self._behavior()

    async def get(self, *_args, **_kwargs):
        return self._behavior()


def _patch_openai_client(monkeypatch, behavior):
    monkeypatch.setattr(
        openai_provider_module.httpx, "AsyncClient",
        lambda *a, **k: _FakeAsyncClient(behavior),
    )


def _profile() -> LLMProfile:
    return LLMProfile(name="corp", provider="openai_compat",
                      base_url="http://llm-gw", model="corp-model")


@pytest.mark.asyncio
async def test_openai_provider_parses_ok_response(monkeypatch):
    def ok():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {
            "model": "corp-model-v2",
            "choices": [{"message": {"role": "assistant", "content": "안녕하세요"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        return resp

    _patch_openai_client(monkeypatch, ok)
    result = await OpenAICompatProvider(_profile()).chat("q", system="s")
    assert result.status == "ok"
    assert result.text == "안녕하세요"
    assert result.model == "corp-model-v2"
    assert result.prompt_tokens == 10
    assert result.completion_tokens == 5


@pytest.mark.asyncio
async def test_openai_provider_handles_missing_content(monkeypatch):
    def weird():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"choices": []}
        return resp

    _patch_openai_client(monkeypatch, weird)
    result = await OpenAICompatProvider(_profile()).chat("q")
    assert result.status == "error"
    assert result.error == "empty_or_unexpected_response"


@pytest.mark.asyncio
async def test_openai_provider_auth_failure(monkeypatch):
    def raise_401():
        request = httpx.Request("POST", "http://llm-gw/v1/chat/completions")
        response = httpx.Response(401, request=request, text="unauthorized")
        raise httpx.HTTPStatusError("401", request=request, response=response)

    _patch_openai_client(monkeypatch, raise_401)
    result = await OpenAICompatProvider(_profile()).chat("q")
    assert result.status == "error"
    assert result.error == "auth_failed_http_401"


@pytest.mark.asyncio
async def test_openai_provider_connect_error_is_offline(monkeypatch):
    def raise_connect():
        raise httpx.ConnectError("refused")

    _patch_openai_client(monkeypatch, raise_connect)
    result = await OpenAICompatProvider(_profile()).chat("q")
    assert result.status == "offline"
    assert result.error == "connect_error"


@pytest.mark.asyncio
async def test_openai_provider_sends_bearer_header(monkeypatch):
    captured: dict = {}

    class _CapturingClient(_FakeAsyncClient):
        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            captured["json"] = json
            resp = MagicMock()
            resp.raise_for_status.return_value = None
            resp.json.return_value = {"choices": [{"message": {"content": "ok"}}]}
            return resp

    monkeypatch.setattr(
        openai_provider_module.httpx, "AsyncClient",
        lambda *a, **k: _CapturingClient(None),
    )
    provider = OpenAICompatProvider(_profile(), api_key="sk-secret")
    result = await provider.chat("질문", system="시스템")
    assert result.status == "ok"
    assert captured["url"].endswith("/v1/chat/completions")
    assert captured["headers"]["Authorization"] == "Bearer sk-secret"
    assert captured["json"]["messages"][0] == {"role": "system", "content": "시스템"}
    assert captured["json"]["messages"][1] == {"role": "user", "content": "질문"}


# ── 스트리밍 provider (SSE 챗) ────────────────────────────────────────────

class _FakeStreamResponse:
    def __init__(self, lines, status_code=200):
        self._lines = lines
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://x")
            response = httpx.Response(self.status_code, request=request, text="err")
            raise httpx.HTTPStatusError(str(self.status_code), request=request, response=response)

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeStreamCtx:
    def __init__(self, lines, status_code=200, raise_exc=None):
        self._lines = lines
        self._status_code = status_code
        self._raise_exc = raise_exc

    async def __aenter__(self):
        if self._raise_exc:
            raise self._raise_exc
        return _FakeStreamResponse(self._lines, self._status_code)

    async def __aexit__(self, *a):
        return False


class _FakeStreamClient:
    def __init__(self, lines, status_code=200, raise_exc=None):
        self._lines = lines
        self._status_code = status_code
        self._raise_exc = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def stream(self, method, url, **kwargs):
        return _FakeStreamCtx(self._lines, self._status_code, self._raise_exc)


def _patch_ollama_stream(monkeypatch, lines=None, status_code=200, raise_exc=None):
    monkeypatch.setattr(
        ollama_provider_module.httpx, "AsyncClient",
        lambda *a, **k: _FakeStreamClient(lines or [], status_code, raise_exc),
    )


def _patch_openai_stream(monkeypatch, lines=None, status_code=200, raise_exc=None):
    monkeypatch.setattr(
        openai_provider_module.httpx, "AsyncClient",
        lambda *a, **k: _FakeStreamClient(lines or [], status_code, raise_exc),
    )


async def _collect(agen):
    return [c async for c in agen]


@pytest.mark.asyncio
async def test_ollama_stream_yields_deltas_then_done(monkeypatch):
    lines = [
        '{"model":"qwen2.5-coder:7b","response":"안","done":false}',
        '{"model":"qwen2.5-coder:7b","response":"녕","done":false}',
        '{"model":"qwen2.5-coder:7b","done":true,"prompt_eval_count":5,"eval_count":2}',
    ]
    _patch_ollama_stream(monkeypatch, lines=lines)
    chunks = await _collect(OllamaProvider(_profile_with(provider="ollama")).chat_stream("q"))
    deltas = [c.delta for c in chunks if not c.done]
    assert deltas == ["안", "녕"]
    assert chunks[-1].done is True
    assert chunks[-1].status == "ok"
    assert chunks[-1].prompt_tokens == 5
    assert chunks[-1].completion_tokens == 2


@pytest.mark.asyncio
async def test_ollama_stream_connect_error_yields_single_offline_chunk(monkeypatch):
    _patch_ollama_stream(monkeypatch, raise_exc=httpx.ConnectError("refused"))
    chunks = await _collect(OllamaProvider(_profile_with(provider="ollama")).chat_stream("q"))
    assert len(chunks) == 1
    assert chunks[0].done is True
    assert chunks[0].status == "offline"
    assert chunks[0].error == "connect_error"


@pytest.mark.asyncio
async def test_ollama_stream_malformed_lines_are_skipped(monkeypatch):
    lines = ["not json", '{"response":"ok","done":false}', '{"done":true}']
    _patch_ollama_stream(monkeypatch, lines=lines)
    chunks = await _collect(OllamaProvider(_profile_with(provider="ollama")).chat_stream("q"))
    deltas = [c.delta for c in chunks if not c.done]
    assert deltas == ["ok"]
    assert chunks[-1].status == "ok"


@pytest.mark.asyncio
async def test_openai_stream_parses_sse_delta_and_done(monkeypatch):
    lines = [
        'data: {"model":"corp-model","choices":[{"delta":{"content":"안"}}]}',
        "",
        'data: {"model":"corp-model","choices":[{"delta":{"content":"녕"}}]}',
        "",
        "data: [DONE]",
    ]
    _patch_openai_stream(monkeypatch, lines=lines)
    chunks = await _collect(OpenAICompatProvider(_profile()).chat_stream("q"))
    deltas = [c.delta for c in chunks if not c.done]
    assert deltas == ["안", "녕"]
    assert chunks[-1].done is True
    assert chunks[-1].status == "ok"
    assert chunks[-1].model == "corp-model"


@pytest.mark.asyncio
async def test_openai_stream_no_content_is_error(monkeypatch):
    lines = ["data: [DONE]"]
    _patch_openai_stream(monkeypatch, lines=lines)
    chunks = await _collect(OpenAICompatProvider(_profile()).chat_stream("q"))
    assert len(chunks) == 1
    assert chunks[0].status == "error"
    assert chunks[0].error == "empty_or_unexpected_response"


@pytest.mark.asyncio
async def test_openai_stream_auth_failure(monkeypatch):
    _patch_openai_stream(monkeypatch, status_code=401,
                         raise_exc=None, lines=[])
    # raise_for_status is called inside __aenter__'s response object, triggered on first access.
    chunks = await _collect(OpenAICompatProvider(_profile()).chat_stream("q"))
    assert chunks[0].status == "error"
    assert chunks[0].error == "auth_failed_http_401"


def _profile_with(provider="ollama") -> LLMProfile:
    return LLMProfile(name="local", provider=provider, base_url="http://ollama:11434", model="qwen2.5-coder:7b")


# ── LLMService.chat_stream_for_purpose — fallback 시맨틱 ──────────────────

class _FakeStreamProvider:
    def __init__(self, profile, chunks):
        self.profile = profile
        self._chunks = chunks

    async def chat_stream(self, prompt, *, system=None, options=None):
        for c in self._chunks:
            yield c


def _stream_service_with(monkeypatch, cfg: dict, chunks_by_profile: dict) -> LLMService:
    svc = LLMService()
    monkeypatch.setattr(svc, "resolve_settings", lambda db=None: merge_llm_settings(cfg))
    monkeypatch.setattr(
        svc, "build_provider",
        lambda profile: _FakeStreamProvider(profile, chunks_by_profile[profile.name]),
    )
    return svc


@pytest.mark.asyncio
async def test_stream_falls_back_when_primary_fails_before_any_delta(monkeypatch):
    svc = _stream_service_with(monkeypatch, _TWO_PROFILE_CFG, {
        "corp": [LLMStreamChunk(done=True, status="offline", profile="corp", error="connect_error")],
        "local": [
            LLMStreamChunk(delta="안녕", profile="local"),
            LLMStreamChunk(done=True, status="ok", profile="local", model="m2"),
        ],
    })
    chunks = await _collect(svc.chat_stream_for_purpose("chat", "q"))
    deltas = [c.delta for c in chunks if not c.done]
    assert deltas == ["안녕"]
    assert chunks[-1].profile == "local"
    assert chunks[-1].status == "ok"


@pytest.mark.asyncio
async def test_stream_does_not_fallback_after_partial_delta(monkeypatch):
    """primary 가 델타를 일부 보낸 뒤 실패하면, fallback 으로 다시 시작하지 않고
    그 자리에서 오류로 끝난다 (앞뒤 안 맞는 이어붙이기 방지)."""
    svc = _stream_service_with(monkeypatch, _TWO_PROFILE_CFG, {
        "corp": [
            LLMStreamChunk(delta="일부 응답", profile="corp"),
            LLMStreamChunk(done=True, status="error", profile="corp", error="http_500"),
        ],
        "local": [LLMStreamChunk(delta="이건 안 보여야 함", profile="local")],
    })
    chunks = await _collect(svc.chat_stream_for_purpose("chat", "q"))
    deltas = [c.delta for c in chunks if not c.done]
    assert deltas == ["일부 응답"]
    assert chunks[-1].profile == "corp"
    assert chunks[-1].status == "error"


@pytest.mark.asyncio
async def test_stream_all_fail_yields_final_offline(monkeypatch):
    svc = _stream_service_with(monkeypatch, _TWO_PROFILE_CFG, {
        "corp": [LLMStreamChunk(done=True, status="offline", profile="corp", error="connect_error")],
        "local": [LLMStreamChunk(done=True, status="offline", profile="local", error="connect_error")],
    })
    chunks = await _collect(svc.chat_stream_for_purpose("chat", "q"))
    assert len(chunks) == 1
    assert chunks[0].done is True
    assert chunks[0].status == "offline"
    assert chunks[0].profile == "local"
