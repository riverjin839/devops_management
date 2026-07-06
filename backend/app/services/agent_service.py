"""
AI Agent Service — Fail-Safe wrapper around Ollama LLM.

If Ollama is offline, unreachable, or returns errors, this service
returns a graceful fallback response instead of raising exceptions.
The main dashboard is NEVER affected by AI availability.

Agent Loop (5-node pipeline)
----------------------------
``run_cluster_summary_pipeline`` (used by the ``ai_cluster_summary`` dashboard
card, see ``cluster_item_service.py``) breaks the former single
request→response call into five independently testable nodes, mirroring the
Strategy-pattern already used by ``app.services.checkers.base.BaseChecker``:

1. ``ContextCollectorNode`` — gathers cluster/DailyCheckLog context.
2. ``PromptBuilderNode``    — assembles the final LLM prompt.
3. ``LLMCallerNode``        — calls the LLM endpoint (Ollama today; swapping
                              to another OpenAI-compatible endpoint later —
                              see Phase 3 vLLM migration — only touches this
                              node).
4. ``RiskParserNode``       — parses the trailing ``RISK: healthy|warning|critical``
                              line out of the answer.
5. ``CardRendererNode``     — renders the final dashboard-card payload.

Every node result (ok/error + duration) is appended to ``AgentState.audit``
so a failure can be traced to the exact stage it happened in. A node
raising never aborts the pipeline or propagates to the caller — the
orchestrator always returns an ``AgentCard`` (fail-safe, same guarantee as
the rest of this service).
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional, TYPE_CHECKING

import httpx

from app.config import settings

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models import Cluster

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a Kubernetes operations assistant embedded in a monitoring dashboard. "
    "You help DevOps engineers diagnose cluster issues, interpret health-check results, "
    "and suggest remediation steps. Be concise, technical, and actionable. "
    "When given cluster context (pod logs, node status, etc.), reference it directly."
)


class AIAgentService:
    """Resilient proxy to a local Ollama instance."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
        self.base_url = (base_url or settings.ollama_url).rstrip("/")
        self.model = model or settings.ollama_model
        self.timeout = timeout or settings.ollama_timeout

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def health_check(self) -> dict:
        """Quick probe — returns {"status": "online"} or {"status": "offline"}."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.base_url}/")
                if resp.status_code != 200:
                    return {"status": "offline", "detail": f"HTTP {resp.status_code}"}
                # Check if the model is available
                tags_resp = await client.get(f"{self.base_url}/api/tags")
                if tags_resp.status_code == 200:
                    models = tags_resp.json().get("models", [])
                    # Ollama returns full names like "qwen2.5:7b".
                    # Match by full name OR by base name (before ":") so that
                    # OLLAMA_MODEL="qwen2.5" matches a pulled "qwen2.5:7b".
                    model_names_full = [m.get("name", "") for m in models]
                    model_names_base = [n.split(":")[0] for n in model_names_full]
                    configured_base = self.model.split(":")[0]
                    model_found = (
                        self.model in model_names_full
                        or configured_base in model_names_base
                    )
                    if not model_found:
                        return {
                            "status": "online",
                            "model": self.model,
                            "detail": (
                                f"Server running but model '{self.model}' not pulled. "
                                f"Available: {model_names_full or 'none'}"
                            ),
                        }
                return {"status": "online", "model": self.model}
        except Exception as exc:
            logger.debug("Ollama health-check failed: %s", exc)
            return {"status": "offline", "model": self.model, "detail": str(exc)}

    async def ask_agent(self, query: str, context: Optional[dict] = None) -> dict:
        """
        Send a question to the Ollama LLM with optional K8s context.

        Returns
        -------
        dict  with keys:
            status  : "ok" | "offline"
            answer  : str   (LLM response or fallback message)
            model   : str   (model name, empty when offline)
        """
        prompt = self._build_prompt(query, context)
        return await self._call_llm(prompt)

    async def pull_model(self, model: Optional[str] = None) -> dict:
        """Trigger model pull on Ollama. Returns status immediately (pull runs server-side)."""
        target = model or self.model
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{self.base_url}/api/pull",
                    json={"name": target, "stream": False},
                )
                if resp.status_code == 200:
                    return {"status": "ok", "message": f"Model '{target}' pull initiated."}
                return {"status": "error", "message": f"HTTP {resp.status_code}: {resp.text[:200]}"}
        except httpx.ConnectError:
            return {"status": "offline", "message": "Ollama service is not reachable."}
        except httpx.TimeoutException:
            return {"status": "ok", "message": f"Model '{target}' pull started (large model, request timed out but pull continues server-side)."}
        except Exception as exc:
            logger.exception("Error pulling model: %s", exc)
            return {"status": "error", "message": str(exc)}

    async def list_models(self) -> dict:
        """List models available on Ollama."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.base_url}/api/tags")
                if resp.status_code == 200:
                    models = resp.json().get("models", [])
                    return {"status": "ok", "models": [m.get("name", "") for m in models]}
                return {"status": "error", "models": []}
        except Exception:
            return {"status": "offline", "models": []}

    async def run_cluster_summary_pipeline(
        self,
        query: str,
        *,
        db: Optional["Session"] = None,
        cluster: Optional["Cluster"] = None,
        context: Optional[dict] = None,
    ) -> "AgentCard":
        """Agent Loop entry point — context_collector → prompt_builder → llm_caller →
        risk_parser → card_renderer.

        Used by the ``ai_cluster_summary`` dashboard card
        (``cluster_item_service._collect_ai_summary``). Pass ``db`` + ``cluster`` to have
        ``ContextCollectorNode`` pull the latest ``DailyCheckLog`` automatically, or pass a
        pre-built ``context`` dict (e.g. from ``/agent/chat``) to skip DB lookup entirely.
        """
        state = AgentState(query=query, context=dict(context or {}))

        ContextCollectorNode(db=db, cluster=cluster).safe_run(state)
        PromptBuilderNode().safe_run(state)
        await LLMCallerNode(self).safe_run(state)

        if state.llm_response.get("status") == "ok":
            RiskParserNode().safe_run(state)
        CardRendererNode().safe_run(state)
        return state.card

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _call_llm(self, prompt: str) -> dict:
        """Raw call to the LLM endpoint. All exceptions are caught — never raises.

        Extracted from ``ask_agent`` so the Agent Loop's ``llm_caller`` node (and any
        future endpoint swap, e.g. Phase 3 vLLM) has a single call site to replace.
        """
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/api/generate",
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "system": SYSTEM_PROMPT,
                        "stream": False,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                return {
                    "status": "ok",
                    "answer": data.get("response", ""),
                    "model": data.get("model", self.model),
                }

        # ---- Fail-safe: catch ALL exceptions, never propagate --------
        except httpx.ConnectError:
            logger.warning("Ollama connect error — service may not be deployed.")
            return self._fallback("AI Agent is currently unavailable. Ollama service is not reachable.")

        except httpx.TimeoutException:
            logger.warning("Ollama request timed out after %ss.", self.timeout)
            return self._fallback("AI Agent request timed out. The model may be loading or the server is overloaded.")

        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("Ollama returned HTTP %s: %s", code, exc.response.text[:200])
            if code == 404:
                return self._fallback(
                    f"Model '{self.model}' is not available. "
                    "It may still be downloading. Use the pull-model endpoint or wait for auto-pull to finish."
                )
            return self._fallback(f"AI Agent returned an error (HTTP {code}).")

        except Exception as exc:
            # Catch-all so nothing leaks to the caller.
            logger.exception("Unexpected error calling Ollama: %s", exc)
            return self._fallback("AI Agent encountered an unexpected error.")

    @staticmethod
    def _fallback(message: str) -> dict:
        return {"status": "offline", "answer": message, "model": ""}

    @staticmethod
    def _build_prompt(query: str, context: Optional[dict] = None) -> str:
        """Inject K8s context into the prompt so the LLM has relevant data."""
        parts: list[str] = []

        if context:
            if context.get("cluster_name"):
                parts.append(f"Cluster: {context['cluster_name']}")
            if context.get("cluster_status"):
                parts.append(f"Cluster status: {context['cluster_status']}")
            if context.get("pod_logs"):
                parts.append(f"Recent pod logs:\n```\n{context['pod_logs']}\n```")
            if context.get("node_status"):
                parts.append(f"Node status:\n{context['node_status']}")
            if context.get("error_messages"):
                msgs = context["error_messages"]
                if isinstance(msgs, list):
                    msgs = "\n".join(msgs)
                parts.append(f"Error messages:\n{msgs}")
            if context.get("extra"):
                parts.append(f"Additional info:\n{context['extra']}")

        if parts:
            ctx_block = "\n\n".join(parts)
            return (
                f"### Cluster Context\n{ctx_block}\n\n"
                f"### User Question\n{query}"
            )
        return query


# ======================================================================
# Agent Loop — 5-node pipeline (checkers.base.BaseChecker 의 Strategy 패턴 재사용)
# ======================================================================


@dataclass
class NodeAudit:
    """단일 노드 실행 감사 기록 — 어느 단계가 실패했는지 추적."""
    node: str
    status: str            # "ok" | "error"
    detail: str = ""
    duration_ms: int = 0


@dataclass
class AgentCard:
    """card_renderer 의 최종 산출물 — 대시보드 카드가 그대로 소비 가능한 형태."""
    text: str = ""
    status: str = "info"    # healthy | warning | critical | info
    model: str = ""
    raw: str = ""
    error: Optional[str] = None
    audit: list[NodeAudit] = field(default_factory=list)


@dataclass
class AgentState:
    """5개 노드가 공유하는 실행 상태. 각 노드는 이 객체를 읽고 in-place 로 채운다."""
    query: str
    context: dict[str, Any] = field(default_factory=dict)
    prompt: str = ""
    llm_response: dict[str, Any] = field(default_factory=dict)
    risk: str = "info"
    summary: str = ""
    audit: list[NodeAudit] = field(default_factory=list)
    card: Optional[AgentCard] = None

    def log(self, node: str, status: str, detail: str = "", duration_ms: int = 0) -> None:
        self.audit.append(NodeAudit(node=node, status=status, detail=detail[:300], duration_ms=duration_ms))


def _elapsed_ms(start: datetime) -> int:
    return int((datetime.utcnow() - start).total_seconds() * 1000)


class AgentNode(ABC):
    """파이프라인 노드 기반 클래스 — ``checkers.base.BaseChecker.safe_check()`` 와 동일한
    fail-safe 컨벤션(예외를 잡아 감사 로그로 남기고 파이프라인은 계속 진행)."""

    name: str = "node"

    @abstractmethod
    def run(self, state: AgentState) -> None:
        """state 를 in-place 로 갱신한다. 실패 시 예외를 던지면 safe_run 이 잡아 audit 에 기록한다."""

    def safe_run(self, state: AgentState) -> bool:
        start = datetime.utcnow()
        try:
            self.run(state)
            state.log(self.name, "ok", duration_ms=_elapsed_ms(start))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Agent node '%s' failed: %s", self.name, exc)
            state.log(self.name, "error", detail=str(exc), duration_ms=_elapsed_ms(start))
            return False


class ContextCollectorNode(AgentNode):
    """DailyCheckLog 등 컨텍스트 수집.

    ``db``/``cluster`` 가 주어지면 최신 DailyCheckLog 를 조회해 컨텍스트를 채운다.
    둘 중 하나라도 없으면 아무것도 하지 않고 호출자가 미리 채운 ``state.context`` 를
    그대로 사용한다 (예: ``/agent/chat`` 은 프론트에서 context 를 실어 보낸다).
    """

    name = "context_collector"

    def __init__(self, db: Optional["Session"] = None, cluster: Optional["Cluster"] = None):
        self.db = db
        self.cluster = cluster

    def run(self, state: AgentState) -> None:
        if self.db is None or self.cluster is None:
            return

        from app.models import DailyCheckLog  # 지연 import — agent_service 가 모델에 항상 의존하지 않도록

        log = (
            self.db.query(DailyCheckLog)
            .filter(DailyCheckLog.cluster_id == self.cluster.id)
            .order_by(DailyCheckLog.checked_at.desc())
            .first()
        )

        ctx: dict[str, Any] = {
            "cluster_name": self.cluster.name,
            "cluster_status": getattr(self.cluster.status, "value", str(self.cluster.status)),
        }
        if log is not None:
            ctx["node_status"] = f"{log.ready_nodes}/{log.total_nodes} Ready"
            if log.error_messages:
                ctx["error_messages"] = log.error_messages
            ctx["extra"] = (
                f"overall={getattr(log.overall_status, 'value', log.overall_status)}, "
                f"api_server={getattr(log.api_server_status, 'value', log.api_server_status)}, "
                f"checked_at={log.checked_at}"
            )
        else:
            ctx["extra"] = "최근 일일점검 기록 없음 (수동 점검을 먼저 실행하세요)"

        state.context.update(ctx)


class PromptBuilderNode(AgentNode):
    """프롬프트 조립 — 기존 ``AIAgentService._build_prompt`` 로직을 그대로 재사용."""

    name = "prompt_builder"

    def run(self, state: AgentState) -> None:
        state.prompt = AIAgentService._build_prompt(state.query, state.context)


class LLMCallerNode:
    """현재 Ollama 호출부. 추후 엔드포인트만 교체 가능하게 인터페이스 분리
    (Phase 3 vLLM 전환 시 이 노드만 수정하면 나머지 노드는 무수정).

    ``AgentNode`` 의 다른 노드들과 달리 비동기 호출이라 별도 ``safe_run`` 을 갖는다.
    """

    name = "llm_caller"

    def __init__(self, agent: AIAgentService):
        self.agent = agent

    async def run(self, state: AgentState) -> None:
        state.llm_response = await self.agent._call_llm(state.prompt)

    async def safe_run(self, state: AgentState) -> bool:
        start = datetime.utcnow()
        try:
            await self.run(state)
            state.log(self.name, "ok", duration_ms=_elapsed_ms(start))
            return True
        except Exception as exc:  # noqa: BLE001
            # _call_llm 은 스스로 fail-safe 이므로 실제로는 여기까지 오지 않지만,
            # 방어적으로 한 번 더 감싼다.
            logger.warning("Agent node '%s' failed: %s", self.name, exc)
            state.log(self.name, "error", detail=str(exc), duration_ms=_elapsed_ms(start))
            state.llm_response = {"status": "offline", "answer": "AI Agent encountered an unexpected error.", "model": ""}
            return False


class RiskParserNode(AgentNode):
    """``RISK: healthy|warning|critical`` 라인 파싱 (기존 cluster_item_service 로직 이관)."""

    name = "risk_parser"

    def run(self, state: AgentState) -> None:
        answer = (state.llm_response.get("answer") or "").strip()
        risk = "info"
        summary_lines: list[str] = []
        for line in answer.splitlines():
            stripped = line.strip()
            upper = stripped.upper()
            if upper.startswith("RISK:") or upper.startswith("RISK :"):
                token = upper.split(":", 1)[1].strip().lower()
                if token.startswith("critical"):
                    risk = "critical"
                elif token.startswith("warning"):
                    risk = "warning"
                elif token.startswith("healthy"):
                    risk = "healthy"
                continue
            if stripped:
                summary_lines.append(stripped)
        state.risk = risk
        state.summary = " ".join(summary_lines).strip()[:400] or answer[:400]


class CardRendererNode(AgentNode):
    """응답 카드 렌더링 — 대시보드가 그대로 소비할 ``AgentCard`` 를 만든다."""

    name = "card_renderer"

    def run(self, state: AgentState) -> None:
        if state.llm_response.get("status") != "ok":
            state.card = AgentCard(
                status="info",
                error=f"LLM 미가용: {str(state.llm_response.get('answer', '')).strip()[:200]}",
                model=state.llm_response.get("model", ""),
                audit=list(state.audit),
            )
            return

        state.card = AgentCard(
            text=state.summary,
            status=state.risk,
            model=state.llm_response.get("model", ""),
            raw=(state.llm_response.get("answer") or "")[:1500],
            audit=list(state.audit),
        )


# Module-level singleton for convenience
agent_service = AIAgentService()
