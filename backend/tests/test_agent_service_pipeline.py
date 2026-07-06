"""Agent Loop(5-node pipeline) 단위 테스트 — agent_service.py.

httpx.AsyncClient 를 monkeypatch 해서 실제 Ollama 없이 각 노드/파이프라인을 검증한다
(tests/test_cluster_registration.py 의 httpx monkeypatch 패턴과 동일한 접근).
"""
from types import SimpleNamespace as NS
from unittest.mock import MagicMock

import httpx
import pytest

from app.services import agent_service as agent_service_module
from app.services.agent_service import (
    AgentState,
    AIAgentService,
    CardRendererNode,
    ContextCollectorNode,
    LLMCallerNode,
    PromptBuilderNode,
    RiskParserNode,
)


# ── ContextCollectorNode ──────────────────────────────────────────────────

def test_context_collector_without_db_or_cluster_is_noop():
    state = AgentState(query="q", context={"cluster_name": "preset"})
    ContextCollectorNode(db=None, cluster=None).run(state)
    assert state.context == {"cluster_name": "preset"}


def test_context_collector_fills_from_latest_daily_check_log(monkeypatch):
    cluster = NS(id="c1", name="prod-a", status=NS(value="healthy"))
    log = NS(
        ready_nodes=3,
        total_nodes=3,
        error_messages=["oom on node-2"],
        overall_status=NS(value="warning"),
        api_server_status=NS(value="healthy"),
        checked_at="2026-07-06T09:00:00",
    )

    db = MagicMock()
    query = db.query.return_value
    query.filter.return_value = query
    query.order_by.return_value = query
    query.first.return_value = log

    state = AgentState(query="q")
    ContextCollectorNode(db=db, cluster=cluster).run(state)

    assert state.context["cluster_name"] == "prod-a"
    assert state.context["cluster_status"] == "healthy"
    assert state.context["node_status"] == "3/3 Ready"
    assert state.context["error_messages"] == ["oom on node-2"]
    assert "overall=warning" in state.context["extra"]


def test_context_collector_handles_no_daily_check_log(monkeypatch):
    cluster = NS(id="c1", name="prod-a", status="healthy")
    db = MagicMock()
    query = db.query.return_value
    query.filter.return_value = query
    query.order_by.return_value = query
    query.first.return_value = None

    state = AgentState(query="q")
    ContextCollectorNode(db=db, cluster=cluster).run(state)

    assert "최근 일일점검 기록 없음" in state.context["extra"]


def test_context_collector_failure_is_caught_by_safe_run():
    db = MagicMock()
    db.query.side_effect = RuntimeError("db down")
    cluster = NS(id="c1", name="prod-a", status="healthy")

    state = AgentState(query="q")
    ok = ContextCollectorNode(db=db, cluster=cluster).safe_run(state)

    assert ok is False
    assert state.audit[-1].node == "context_collector"
    assert state.audit[-1].status == "error"


# ── PromptBuilderNode ─────────────────────────────────────────────────────

def test_prompt_builder_includes_context_block():
    state = AgentState(query="what's wrong?", context={"cluster_name": "prod-a", "cluster_status": "warning"})
    PromptBuilderNode().run(state)
    assert "### Cluster Context" in state.prompt
    assert "Cluster: prod-a" in state.prompt
    assert "### User Question\nwhat's wrong?" in state.prompt


def test_prompt_builder_falls_back_to_bare_query_without_context():
    state = AgentState(query="what's wrong?", context={})
    PromptBuilderNode().run(state)
    assert state.prompt == "what's wrong?"


# ── LLMCallerNode / _call_llm fail-safe ───────────────────────────────────

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
        agent_service_module.httpx, "AsyncClient",
        lambda *a, **k: _FakeAsyncClient(behavior),
    )


@pytest.mark.asyncio
async def test_llm_caller_ok_response(monkeypatch):
    def ok_response():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"response": "all good\nRISK: healthy", "model": "llama3"}
        return resp

    _patch_client(monkeypatch, ok_response)
    agent = AIAgentService()
    state = AgentState(query="q", prompt="q")
    ok = await LLMCallerNode(agent).safe_run(state)

    assert ok is True
    assert state.llm_response["status"] == "ok"
    assert state.llm_response["model"] == "llama3"


@pytest.mark.asyncio
async def test_llm_caller_connect_error_is_fail_safe(monkeypatch):
    def raise_connect_error():
        raise httpx.ConnectError("refused")

    _patch_client(monkeypatch, raise_connect_error)
    agent = AIAgentService()
    state = AgentState(query="q", prompt="q")
    ok = await LLMCallerNode(agent).safe_run(state)

    assert ok is True  # _call_llm never raises, so the node itself reports "ok"
    assert state.llm_response["status"] == "offline"
    assert "unavailable" in state.llm_response["answer"]


@pytest.mark.asyncio
async def test_llm_caller_timeout_is_fail_safe(monkeypatch):
    def raise_timeout():
        raise httpx.TimeoutException("timed out")

    _patch_client(monkeypatch, raise_timeout)
    agent = AIAgentService()
    state = AgentState(query="q", prompt="q")
    await LLMCallerNode(agent).safe_run(state)

    assert state.llm_response["status"] == "offline"
    assert "timed out" in state.llm_response["answer"]


@pytest.mark.asyncio
async def test_ask_agent_still_works_end_to_end(monkeypatch):
    """/agent/chat 과 review_service 가 쓰는 기존 진입점 회귀 테스트."""
    def ok_response():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"response": "answer text", "model": "llama3"}
        return resp

    _patch_client(monkeypatch, ok_response)
    agent = AIAgentService()
    result = await agent.ask_agent("hello", context={"cluster_name": "prod-a"})

    assert result == {"status": "ok", "answer": "answer text", "model": "llama3"}


# ── RiskParserNode ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "answer,expected_risk,expected_summary",
    [
        ("클러스터는 정상입니다.\nRISK: healthy", "healthy", "클러스터는 정상입니다."),
        ("노드 하나가 NotReady.\nRISK: warning", "warning", "노드 하나가 NotReady."),
        ("etcd 리더 없음.\nRISK: critical", "critical", "etcd 리더 없음."),
        ("RISK 라인이 없는 응답", "info", "RISK 라인이 없는 응답"),
    ],
)
def test_risk_parser_extracts_risk_and_summary(answer, expected_risk, expected_summary):
    state = AgentState(query="q", llm_response={"status": "ok", "answer": answer})
    RiskParserNode().run(state)
    assert state.risk == expected_risk
    assert state.summary == expected_summary


def test_risk_parser_truncates_long_summary():
    long_line = "x" * 500
    state = AgentState(query="q", llm_response={"status": "ok", "answer": f"{long_line}\nRISK: healthy"})
    RiskParserNode().run(state)
    assert len(state.summary) == 400


# ── CardRendererNode ───────────────────────────────────────────────────────

def test_card_renderer_offline_response():
    state = AgentState(query="q", llm_response={"status": "offline", "answer": "unavailable", "model": ""})
    CardRendererNode().run(state)
    assert state.card.error is not None
    assert "LLM 미가용" in state.card.error
    assert state.card.status == "info"


def test_card_renderer_ok_response():
    state = AgentState(query="q", llm_response={"status": "ok", "answer": "raw answer", "model": "llama3"})
    state.risk = "warning"
    state.summary = "요약"
    CardRendererNode().run(state)
    assert state.card.error is None
    assert state.card.text == "요약"
    assert state.card.status == "warning"
    assert state.card.model == "llama3"
    assert state.card.raw == "raw answer"


# ── Full pipeline integration ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_full_pipeline_ok_produces_card_with_audit(monkeypatch):
    def ok_response():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"response": "클러스터 정상.\nRISK: healthy", "model": "llama3"}
        return resp

    _patch_client(monkeypatch, ok_response)
    cluster = NS(id="c1", name="prod-a", status=NS(value="healthy"))
    db = MagicMock()
    query = db.query.return_value
    query.filter.return_value = query
    query.order_by.return_value = query
    query.first.return_value = None

    agent = AIAgentService()
    card = await agent.run_cluster_summary_pipeline("요약해줘", db=db, cluster=cluster)

    assert card.error is None
    assert card.status == "healthy"
    assert card.text == "클러스터 정상."
    node_names = [a.node for a in card.audit]
    assert node_names == ["context_collector", "prompt_builder", "llm_caller", "risk_parser"]
    assert all(a.status == "ok" for a in card.audit)


@pytest.mark.asyncio
async def test_full_pipeline_offline_is_fail_safe_and_never_raises(monkeypatch):
    def raise_connect_error():
        raise httpx.ConnectError("refused")

    _patch_client(monkeypatch, raise_connect_error)
    cluster = NS(id="c1", name="prod-a", status="healthy")
    db = MagicMock()
    query = db.query.return_value
    query.filter.return_value = query
    query.order_by.return_value = query
    query.first.return_value = None

    agent = AIAgentService()
    card = await agent.run_cluster_summary_pipeline("요약해줘", db=db, cluster=cluster)

    assert card.error is not None
    assert card.status == "info"
    # risk_parser did not run since llm_response was offline
    assert [a.node for a in card.audit] == ["context_collector", "prompt_builder", "llm_caller"]


@pytest.mark.asyncio
async def test_full_pipeline_survives_context_collector_crash(monkeypatch):
    """context_collector 가 죽어도(DB 장애) 파이프라인은 계속 진행해 답을 만든다."""
    def ok_response():
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"response": "정상.\nRISK: healthy", "model": "llama3"}
        return resp

    _patch_client(monkeypatch, ok_response)
    cluster = NS(id="c1", name="prod-a", status="healthy")
    db = MagicMock()
    db.query.side_effect = RuntimeError("db down")

    agent = AIAgentService()
    card = await agent.run_cluster_summary_pipeline("요약해줘", db=db, cluster=cluster)

    assert card.error is None
    assert card.status == "healthy"
    audit_by_node = {a.node: a.status for a in card.audit}
    assert audit_by_node["context_collector"] == "error"
    assert audit_by_node["llm_caller"] == "ok"
