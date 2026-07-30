"""services/llm 게이트웨이 단위 테스트.

- env 합성/defensive merge (default_llm_settings / merge_llm_settings)
- purpose 라우팅: primary 실패 → fallback, 전부 실패 → offline
- api_key_ref 해석 (env: / 빈값)
- OpenAI-호환 provider 응답 파싱 (정상 / 비정상 / 인증 실패)
"""
from unittest.mock import MagicMock

import httpx
import pytest

from app.services.llm import openai_provider as openai_provider_module
from app.services.llm.base import LLMProfile, LLMResult
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
