"""게이트웨이(HTTPRoute) 뒤 OpenAI 호환 모델 서버 연결 — 프로필 고급 옵션 + 진단 테스트.

- LLMProfile: api_url 의 /v1 중복 방지, 헤더(Host·인증 헤더·추가 헤더), httpx 옵션
- merge_llm_settings: 고급 옵션 보존, 구 설정(필드 없음) 기본값 호환
- list_models_detailed: 실패 사유 반환
- diagnose_profile(openai_compat): 빈 모델 → 서버 모델로 시험, envoy 404 힌트, TLS 오류 힌트, 프록시 판정
"""
import json

import httpx
import pytest

from app.services.llm import diagnostics as diag_module
from app.services.llm import openai_provider as openai_module
from app.services.llm.base import LLMProfile
from app.services.llm.openai_provider import OpenAICompatProvider
from app.services.llm.service import merge_llm_settings


def _gw(**kw) -> LLMProfile:
    raw = {"name": "gpu-qwen", "provider": "openai_compat",
           "base_url": "http://llm.gpu.corp/qwen3", "model": "Qwen/Qwen3-32B"}
    raw.update(kw)
    return LLMProfile.from_dict(raw)


# ── LLMProfile 헬퍼 ──────────────────────────────────────────────────

def test_api_url_appends_v1_by_default():
    assert _gw().api_url("/models") == "http://llm.gpu.corp/qwen3/v1/models"


def test_api_url_does_not_duplicate_v1():
    p = _gw(base_url="http://llm.gpu.corp/qwen3/v1/")
    assert p.api_url("/chat/completions") == "http://llm.gpu.corp/qwen3/v1/chat/completions"
    assert p.base_has_api_path()


def test_api_url_empty_api_path():
    assert _gw(api_path="").api_url("/models") == "http://llm.gpu.corp/qwen3/models"
    assert _gw(api_path="openai/v1").api_url("/models") == "http://llm.gpu.corp/qwen3/openai/v1/models"


def test_request_headers_gateway_options():
    p = _gw(host_header="qwen.llm.gpu.corp", auth_header="api-key", auth_scheme="",
            extra_headers={"x-model": "qwen3"})
    h = p.request_headers("sk-1", json_body=True)
    assert h["Host"] == "qwen.llm.gpu.corp"
    assert h["api-key"] == "sk-1"
    assert "Authorization" not in h
    assert h["x-model"] == "qwen3"
    assert h["Content-Type"] == "application/json"
    assert _gw().request_headers("sk-1")["Authorization"] == "Bearer sk-1"


def test_client_kwargs_tls_and_proxy():
    assert _gw().client_kwargs(5) == {"timeout": 5, "verify": True, "trust_env": True}
    assert _gw(tls_verify=False, use_env_proxy=False).client_kwargs(5)["verify"] is False
    assert _gw(ca_bundle="/etc/ssl/corp.pem").client_kwargs(5)["verify"] == "/etc/ssl/corp.pem"
    assert _gw(use_env_proxy=False).client_kwargs(5)["trust_env"] is False


def test_merge_keeps_advanced_options_and_defaults_old_profiles():
    cfg = merge_llm_settings({"profiles": [
        {"name": "old", "provider": "openai_compat", "base_url": "http://gw", "model": "m"},
        {"name": "gpu", "provider": "openai_compat", "base_url": "https://gw", "model": "m",
         "tls_verify": False, "host_header": "qwen.corp", "extra_headers": {"x-model": "q"}, "api_path": ""},
    ]})
    old, gpu = cfg["profiles"]
    assert old["extra_headers"] == []
    assert old["api_path"] == "/v1" and old["tls_verify"] is True and old["auth_header"] == "Authorization"
    assert gpu["tls_verify"] is False and gpu["host_header"] == "qwen.corp"
    assert gpu["extra_headers"] == [{"name": "x-model", "value": "q"}] and gpu["api_path"] == ""
    # 저장 형태(리스트)를 다시 읽어도 같은 헤더
    assert LLMProfile.from_dict(gpu).extra_headers == {"x-model": "q"}


# ── 모델 목록 실패 사유 ──────────────────────────────────────────────

def _mock(monkeypatch, module, handler):
    real = httpx.AsyncClient
    seen: list[dict] = []

    def factory(*a, **k):
        seen.append(k)
        return real(transport=httpx.MockTransport(handler), timeout=k.get("timeout", 5),
                    headers=k.get("headers"))

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)
    return seen


@pytest.mark.asyncio
async def test_list_models_detailed_reports_reason(monkeypatch):
    _mock(monkeypatch, openai_module,
          lambda req: httpx.Response(404, headers={"server": "envoy"}, text="route not found"))
    models, err = await OpenAICompatProvider(_gw()).list_models_detailed()
    assert models == []
    assert "HTTP 404" in err and "envoy" in err and "/qwen3/v1/models" in err


@pytest.mark.asyncio
async def test_provider_sends_gateway_headers(monkeypatch):
    got: dict = {}

    def handler(req: httpx.Request):
        got["host"] = req.headers.get("host")
        got["path"] = req.url.path
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    seen = _mock(monkeypatch, openai_module, handler)
    res = await OpenAICompatProvider(_gw(host_header="qwen.corp", tls_verify=False)).chat("hi")
    assert res.status == "ok"
    assert got == {"host": "qwen.corp", "path": "/qwen3/v1/chat/completions"}
    assert seen[0]["verify"] is False


# ── 진단 ─────────────────────────────────────────────────────────────

@pytest.fixture
def _net_ok(monkeypatch):
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
                "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(diag_module.socket, "getaddrinfo",
                        lambda *a, **k: [(None, None, None, None, ("10.1.2.3", 80))])

    class _W:
        def close(self):
            pass

        async def wait_closed(self):
            pass

    async def fake_open(host, port):
        return None, _W()

    monkeypatch.setattr(diag_module.asyncio, "open_connection", fake_open)


def _emit():
    events: list[dict] = []
    return events, events.append


def _by_name(res):
    return {c["name"]: c for c in res["checks"]}


@pytest.mark.asyncio
async def test_diagnose_empty_model_uses_server_model(monkeypatch, _net_ok):
    def handler(req: httpx.Request):
        if req.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "Qwen/Qwen3-32B"}]})
        body = json.loads(req.content)
        assert body["model"] == "Qwen/Qwen3-32B"
        return httpx.Response(200, json={"model": body["model"], "choices": [{"message": {"content": "정상"}}]})

    _mock(monkeypatch, diag_module, handler)
    _, emit = _emit()
    res = await diag_module.diagnose_profile(_gw(model=""), emit, settings_stored=True)
    checks = _by_name(res)
    assert checks["config"]["status"] == "warn"           # 빈 모델은 더 이상 fail 이 아니다
    assert checks["models"]["status"] == "warn"
    assert checks["generate"]["status"] == "ok"
    assert res["ok"] is True
    assert res["resolved_model"] == "Qwen/Qwen3-32B"     # 화면의 '모델명 저장' 대상


@pytest.mark.asyncio
async def test_diagnose_envoy_404_points_to_httproute(monkeypatch, _net_ok):
    _mock(monkeypatch, diag_module,
          lambda req: httpx.Response(404, headers={"server": "istio-envoy"}, text=""))
    events, emit = _emit()
    res = await diag_module.diagnose_profile(_gw(), emit, settings_stored=True)
    checks = _by_name(res)
    assert checks["models"]["status"] == "warn"
    assert checks["generate"]["status"] == "fail"
    assert "hostnames" in checks["generate"]["hint"]
    assert "URLRewrite" in checks["generate"]["hint"]     # base_url 에 /qwen3 prefix
    assert any("/qwen3/v1/chat/completions" in e.get("message", "") for e in events if e.get("type") == "log")


@pytest.mark.asyncio
async def test_diagnose_tls_error_hint(monkeypatch, _net_ok):
    def handler(req):
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")

    _mock(monkeypatch, diag_module, handler)
    _, emit = _emit()
    res = await diag_module.diagnose_profile(_gw(base_url="https://llm.gpu.corp/qwen3"), emit, settings_stored=True)
    models = _by_name(res)["models"]
    assert models["status"] == "fail"
    assert "CA 번들" in models["hint"]


@pytest.mark.asyncio
async def test_diagnose_proxy_warning(monkeypatch, _net_ok):
    monkeypatch.setenv("HTTP_PROXY", "http://user:pw@proxy.corp:3128")
    _mock(monkeypatch, diag_module, lambda req: httpx.Response(200, json={"data": [{"id": "Qwen/Qwen3-32B"}],
                                                                       "choices": [{"message": {"content": "ok"}}]}))
    _, emit = _emit()
    res = await diag_module.diagnose_profile(_gw(), emit, settings_stored=True)
    proxy = _by_name(res)["proxy"]
    assert proxy["status"] == "warn"
    assert "pw" not in proxy["detail"]                     # 프록시 자격증명은 가린다

    monkeypatch.setenv("NO_PROXY", ".gpu.corp")
    res = await diag_module.diagnose_profile(_gw(), emit, settings_stored=True)
    assert _by_name(res)["proxy"]["status"] == "ok"

    res = await diag_module.diagnose_profile(_gw(use_env_proxy=False), emit, settings_stored=True)
    assert _by_name(res)["proxy"]["status"] == "ok"


# ── LiteLLM 감지 힌트 ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_diagnose_litellm_unknown_model_hint(monkeypatch, _net_ok):
    def handler(req: httpx.Request):
        h = {"x-litellm-version": "1.50.0"}
        if req.url.path.endswith("/models"):
            return httpx.Response(200, headers=h, json={"data": [{"id": "glm-flash"}]})
        return httpx.Response(400, headers=h, json={"error": {"message": "Invalid model name passed in model=nope"}})

    _mock(monkeypatch, diag_module, handler)
    events, emit = _emit()
    res = await diag_module.diagnose_profile(
        _gw(base_url="http://litellm.ai.svc:4000", model="nope"), emit, settings_stored=True)
    gen = _by_name(res)["generate"]
    assert gen["status"] == "fail"
    assert "model_list" in gen["hint"]
    assert any("LiteLLM 프록시" in e.get("message", "") for e in events if e.get("type") == "log")
