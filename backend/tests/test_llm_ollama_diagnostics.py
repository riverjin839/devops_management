"""Ollama 모델명 자동 해석 + 연결 진단(services/llm/diagnostics.py) 테스트.

- pick_ollama_model: 정확 일치 → name:latest → 같은 base 이름
- chat / chat_stream: 404(model not found) 뒤 서버 모델 목록으로 해석해 1회 재시도
- health: 모델이 없으면 model_ready=False + detail, 자동 해석이면 resolved_model
- diagnose_profile: DNS 실패 시 중단·힌트, 정상 경로의 단계 기록
"""
import json

import httpx
import pytest

from app.services.llm import diagnostics as diag_module
from app.services.llm import ollama_provider as ollama_module
from app.services.llm.base import LLMProfile
from app.services.llm.ollama_provider import OllamaProvider, pick_ollama_model


def _profile(model="qwen2.5-coder", base_url="http://ollama:11434", **kw) -> LLMProfile:
    return LLMProfile(name="local-ollama", provider="ollama", base_url=base_url, model=model, **kw)


def _mock_ollama(monkeypatch, module, *, models, calls=None):
    """httpx.AsyncClient 를 MockTransport 로 바꾼다 — /api/generate 는 models 에 있는 이름만 200."""
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if calls is not None:
            calls.append((path, json.loads(request.content) if request.content else None))
        if path == "/":
            return httpx.Response(200, text="Ollama is running")
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.5.7"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m} for m in models]})
        if path == "/api/show":
            return httpx.Response(200, json={
                "details": {"family": "qwen2", "parameter_size": "7.6B", "quantization_level": "Q4_K_M"},
                "model_info": {"qwen2.context_length": 32768},
                "parameters": "num_ctx 8192\ntemperature 0.2",
                "modelfile": 'FROM qwen2.5-coder:7b\nSYSTEM "k8s"',
            })
        if path == "/api/generate":
            body = json.loads(request.content)
            if body["model"] not in models:
                return httpx.Response(404, json={"error": f"model '{body['model']}' not found"})
            if body.get("stream"):
                lines = [
                    json.dumps({"model": body["model"], "response": "정상", "done": False}),
                    json.dumps({"model": body["model"], "done": True, "eval_count": 1}),
                ]
                return httpx.Response(200, text="\n".join(lines))
            return httpx.Response(200, json={
                "model": body["model"], "response": "정상", "done": True,
                "load_duration": 2_000_000_000, "eval_count": 10, "eval_duration": 1_000_000_000,
            })
        return httpx.Response(404)

    monkeypatch.setattr(
        module.httpx, "AsyncClient",
        lambda *a, **k: real(transport=httpx.MockTransport(handler), timeout=k.get("timeout", 5)),
    )


@pytest.fixture(autouse=True)
def _clear_resolved():
    ollama_module._RESOLVED_MODELS.clear()
    yield
    ollama_module._RESOLVED_MODELS.clear()


# ── pick_ollama_model ────────────────────────────────────────────────

def test_pick_exact_match_wins():
    assert pick_ollama_model("qwen2.5-coder:7b", ["qwen2.5-coder:7b", "qwen2.5-coder:3b"]) == "qwen2.5-coder:7b"


def test_pick_untagged_prefers_latest():
    assert pick_ollama_model("pep-k8s-ops", ["pep-k8s-ops:latest", "qwen2.5-coder:7b"]) == "pep-k8s-ops:latest"


def test_pick_tag_mismatch_uses_same_base():
    # 이미지 태그(:5b)와 구워진 모델 태그(:7b)가 다른 흔한 경우
    assert pick_ollama_model("qwen2.5-coder:5b", ["qwen2.5-coder:7b"]) == "qwen2.5-coder:7b"


def test_pick_returns_none_when_no_candidate():
    assert pick_ollama_model("llama3", ["qwen2.5-coder:7b"]) is None
    assert pick_ollama_model("llama3", []) is None
    assert pick_ollama_model("", ["qwen2.5-coder:7b"]) is None


# ── chat / stream 재시도 ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_chat_retries_with_resolved_model_after_404(monkeypatch):
    calls: list = []
    _mock_ollama(monkeypatch, ollama_module, models=["qwen2.5-coder:7b"], calls=calls)
    result = await OllamaProvider(_profile(model="qwen2.5-coder:5b")).chat("hi")
    assert result.status == "ok"
    assert result.model == "qwen2.5-coder:7b"
    generated = [b["model"] for p, b in calls if p == "/api/generate"]
    assert generated == ["qwen2.5-coder:5b", "qwen2.5-coder:7b"]

    # 두 번째 호출부터는 기억한 이름으로 바로 호출 (재시도 없음)
    calls.clear()
    await OllamaProvider(_profile(model="qwen2.5-coder:5b")).chat("hi")
    assert [b["model"] for p, b in calls if p == "/api/generate"] == ["qwen2.5-coder:7b"]


@pytest.mark.asyncio
async def test_chat_keeps_model_not_found_when_unresolvable(monkeypatch):
    _mock_ollama(monkeypatch, ollama_module, models=["qwen2.5-coder:7b"])
    result = await OllamaProvider(_profile(model="llama3")).chat("hi")
    assert result.status == "error"
    assert result.error == "model_not_found:llama3"


@pytest.mark.asyncio
async def test_stream_retries_with_resolved_model_after_404(monkeypatch):
    _mock_ollama(monkeypatch, ollama_module, models=["qwen2.5-coder:7b"])
    chunks = [c async for c in OllamaProvider(_profile(model="qwen2.5-coder")).chat_stream("hi")]
    assert [c.delta for c in chunks if not c.done] == ["정상"]
    assert chunks[-1].status == "ok"
    assert all(not (c.error or "").startswith("model_not_found") for c in chunks)


# ── health ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_health_reports_missing_model_as_not_ready(monkeypatch):
    _mock_ollama(monkeypatch, ollama_module, models=["qwen2.5-coder:7b"])
    h = await OllamaProvider(_profile(model="llama3")).health()
    assert h["status"] == "online"
    assert h["model_ready"] is False
    assert "llama3" in h["detail"]


@pytest.mark.asyncio
async def test_health_reports_resolved_model(monkeypatch):
    _mock_ollama(monkeypatch, ollama_module, models=["qwen2.5-coder:7b"])
    h = await OllamaProvider(_profile(model="qwen2.5-coder")).health()
    assert h["model_ready"] is True
    assert h["resolved_model"] == "qwen2.5-coder:7b"
    assert h["detail"] == ""


@pytest.mark.asyncio
async def test_health_empty_server_says_no_model(monkeypatch):
    _mock_ollama(monkeypatch, ollama_module, models=[])
    h = await OllamaProvider(_profile(model="qwen2.5-coder:7b")).health()
    assert h["model_ready"] is False
    assert "이미지에 모델 미포함" in h["detail"]


# ── diagnose_profile ─────────────────────────────────────────────────

def _collect_emit():
    events: list[dict] = []
    return events, events.append


@pytest.mark.asyncio
async def test_diagnose_stops_at_dns_failure(monkeypatch):
    def boom(*a, **k):
        raise OSError("Name or service not known")
    monkeypatch.setattr(diag_module.socket, "getaddrinfo", boom)
    events, emit = _collect_emit()
    res = await diag_module.diagnose_profile(_profile(model="qwen2.5-coder:7b"), emit, settings_stored=False)
    assert res["ok"] is False
    names = [c["name"] for c in res["checks"]]
    assert names == ["config", "dns"]
    assert res["checks"][-1]["status"] == "fail"
    assert "Service" in res["checks"][-1]["hint"]
    assert any(e["type"] == "step" and e["status"] == "failed" for e in events)


@pytest.mark.asyncio
async def test_diagnose_full_ollama_path(monkeypatch):
    monkeypatch.setattr(diag_module.socket, "getaddrinfo",
                        lambda *a, **k: [(None, None, None, None, ("10.0.0.5", 11434))])

    class _W:
        def close(self):
            pass

        async def wait_closed(self):
            pass

    async def fake_open(host, port):
        return None, _W()

    monkeypatch.setattr(diag_module.asyncio, "open_connection", fake_open)
    _mock_ollama(monkeypatch, diag_module, models=["qwen2.5-coder:7b", "pep-k8s-ops:latest"])
    events, emit = _collect_emit()
    res = await diag_module.diagnose_profile(_profile(model="pep-k8s-ops"), emit, settings_stored=False)
    assert res["ok"] is True
    assert res["resolved_model"] == "pep-k8s-ops:latest"
    by_name = {c["name"]: c for c in res["checks"]}
    assert list(by_name) == ["config", "dns", "tcp", "server", "models", "show", "generate"]
    assert by_name["models"]["status"] == "warn"      # 태그 없는 이름 → 자동 해석 안내
    assert by_name["show"]["status"] == "ok"          # num_ctx 지정됨
    assert "tok/s" in by_name["generate"]["detail"]
    assert any(e["type"] == "log" for e in events)


@pytest.mark.asyncio
async def test_diagnose_warns_when_db_settings_shadow_env(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "ollama_model", "qwen2.5-coder:7b")
    monkeypatch.setattr(diag_module.socket, "getaddrinfo", lambda *a, **k: (_ for _ in ()).throw(OSError("x")))
    _, emit = _collect_emit()
    res = await diag_module.diagnose_profile(_profile(model="llama3"), emit, settings_stored=True)
    assert res["checks"][0]["status"] == "warn"
    assert "OLLAMA_MODEL" in res["checks"][0]["detail"]
