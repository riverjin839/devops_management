"""EmbeddingService(Ollama /api/embeddings) 단위 테스트 — fail-safe 회귀.

test_agent_service_pipeline.py 와 동일한 httpx.AsyncClient monkeypatch 패턴.
"""
from unittest.mock import MagicMock

import httpx
import pytest

from app.services import embedding_service as embedding_service_module
from app.services.embedding_service import EmbeddingService, build_embedding_text


class _FakeAsyncClient:
    def __init__(self, behavior):
        self._behavior = behavior

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, *_args, **_kwargs):
        return self._behavior()


def _patch_client(monkeypatch, behavior):
    monkeypatch.setattr(
        embedding_service_module.httpx, "AsyncClient",
        lambda *a, **k: _FakeAsyncClient(behavior),
    )


def test_build_embedding_text_joins_title_and_content():
    assert build_embedding_text("제목", "본문") == "제목\n\n본문"


def test_build_embedding_text_handles_missing_parts():
    assert build_embedding_text(None, "본문만") == "본문만"
    assert build_embedding_text("제목만", None) == "제목만"
    assert build_embedding_text(None, None) == ""
    assert build_embedding_text("  ", "  ") == ""


@pytest.mark.asyncio
async def test_embed_returns_none_for_empty_text():
    svc = EmbeddingService()
    assert await svc.embed("") is None
    assert await svc.embed("   ") is None


@pytest.mark.asyncio
async def test_embed_ok_response(monkeypatch):
    def ok_response():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"embedding": [0.1, 0.2, 0.3]}
        return resp

    _patch_client(monkeypatch, ok_response)
    svc = EmbeddingService()
    vector = await svc.embed("some work item text")
    assert vector == [0.1, 0.2, 0.3]


@pytest.mark.asyncio
async def test_embed_connect_error_is_fail_safe(monkeypatch):
    def raise_connect_error():
        raise httpx.ConnectError("refused")

    _patch_client(monkeypatch, raise_connect_error)
    svc = EmbeddingService()
    assert await svc.embed("text") is None


@pytest.mark.asyncio
async def test_embed_timeout_is_fail_safe(monkeypatch):
    def raise_timeout():
        raise httpx.TimeoutException("timed out")

    _patch_client(monkeypatch, raise_timeout)
    svc = EmbeddingService()
    assert await svc.embed("text") is None


@pytest.mark.asyncio
async def test_embed_http_error_is_fail_safe(monkeypatch):
    def raise_http_error():
        request = httpx.Request("POST", "http://ollama/api/embeddings")
        response = httpx.Response(404, request=request, text="model not found")
        raise httpx.HTTPStatusError("404", request=request, response=response)

    _patch_client(monkeypatch, raise_http_error)
    svc = EmbeddingService()
    assert await svc.embed("text") is None


@pytest.mark.asyncio
async def test_embed_missing_embedding_field_is_fail_safe(monkeypatch):
    def ok_but_empty():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {}
        return resp

    _patch_client(monkeypatch, ok_but_empty)
    svc = EmbeddingService()
    assert await svc.embed("text") is None
