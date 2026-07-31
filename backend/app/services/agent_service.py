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

from app.config import settings
from app.services.llm import llm_service

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models import Cluster

logger = logging.getLogger(__name__)


class AIAgentService:
    """LLM 게이트웨이(``services/llm``) 위의 fail-safe 파사드.

    직접 Ollama 를 호출하던 구현은 ``services/llm/ollama_provider.py`` 로 이관됐다.
    이 클래스는 기존 호출부(라우터·review_service·cluster_item_service)의 공개
    시그니처를 유지하면서, 실제 호출을 프로필 × 용도 라우팅 게이트웨이에 위임한다.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
        # 레거시 호환 필드 — 게이트웨이 도입 후에는 표시용으로만 쓰인다.
        self.base_url = (base_url or settings.ollama_url).rstrip("/")
        self.model = model or settings.ollama_model
        self.timeout = timeout or settings.ollama_timeout

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def health_check(self) -> dict:
        """Quick probe — chat 용도의 primary 프로필 health (기존 응답 형태 유지)."""
        h = await llm_service.health_for_purpose("chat")
        return {
            "status": h.get("status", "offline"),
            "model": h.get("model", self.model),
            **({"detail": h["detail"]} if h.get("detail") else {}),
        }

    async def ask_agent(
        self, query: str, context: Optional[dict] = None, *, purpose: str = "chat"
    ) -> dict:
        """
        Send a question to the routed LLM with optional K8s context.

        Returns
        -------
        dict  with keys:
            status  : "ok" | "offline"
            answer  : str   (LLM response or fallback message)
            model   : str   (model name, empty when offline)
        """
        prompt = self._build_prompt(query, context)
        return await self._call_llm(prompt, purpose=purpose)

    async def pull_model(self, model: Optional[str] = None) -> dict:
        """Trigger model pull — 첫 enabled Ollama 프로필에 위임 (Ollama 전용 기능)."""
        profile = llm_service.first_ollama_profile()
        if profile is None:
            return {"status": "error", "message": "활성화된 Ollama 프로필이 없습니다. Settings → AI/LLM 에서 확인하세요."}
        from app.services.llm.ollama_provider import OllamaProvider
        return await OllamaProvider(profile).pull_model(model=model)

    async def list_models(self) -> dict:
        """List models — 첫 enabled Ollama 프로필의 모델 목록 (기존 API 호환)."""
        profile = llm_service.first_ollama_profile()
        if profile is None:
            return {"status": "offline", "models": []}
        models = await llm_service.list_profile_models(profile.name)
        return {"status": "ok" if models else "offline", "models": models}

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
        await LLMCallerNode(self, purpose="review_summary").safe_run(state)

        if state.llm_response.get("status") == "ok":
            RiskParserNode().safe_run(state)
        CardRendererNode().safe_run(state)
        return state.card

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _call_llm(self, prompt: str, *, purpose: str = "chat") -> dict:
        """Raw call — 게이트웨이(``llm_service.chat_for_purpose``)에 위임한다.

        기존 반환 계약({status: "ok"|"offline", answer, model})을 유지한다.
        게이트웨이가 primary→fallback 을 이미 처리하므로 여기 도달한 실패는
        모든 프로필이 실패한 경우다 — 한국어 안내문으로 폴백한다.
        """
        try:
            result = await llm_service.chat_for_purpose(purpose, prompt)
        except Exception as exc:  # noqa: BLE001  (방어 — 게이트웨이는 원래 raise 하지 않음)
            logger.exception("Unexpected error calling LLM gateway: %s", exc)
            return self._fallback("AI 어시스턴트에 일시적인 오류가 발생했습니다.")

        if result.status == "ok":
            return {"status": "ok", "answer": result.text, "model": result.model}

        error = result.error or ""
        if error.startswith("timeout"):
            msg = "AI 응답이 시간 내에 도착하지 않았습니다. 모델 로딩 중이거나 서버가 과부하 상태일 수 있습니다."
        elif error.startswith("model_not_found"):
            msg = (
                f"모델 '{result.model}' 을 사용할 수 없습니다. 아직 다운로드 중일 수 있습니다 — "
                "Settings → AI/LLM 에서 모델 상태를 확인하세요."
            )
        elif error.startswith("auth_failed"):
            msg = "LLM 서비스 인증에 실패했습니다. Settings → AI/LLM 에서 API 키를 확인하세요."
        else:
            msg = "AI 어시스턴트에 연결할 수 없습니다. Settings → AI/LLM 에서 LLM 연결 상태를 확인하세요."
        return self._fallback(msg)

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
    """LLM 호출 노드 — ``services/llm`` 게이트웨이 경유 (프로필 × 용도 라우팅).

    ``AgentNode`` 의 다른 노드들과 달리 비동기 호출이라 별도 ``safe_run`` 을 갖는다.
    """

    name = "llm_caller"

    def __init__(self, agent: AIAgentService, purpose: str = "chat"):
        self.agent = agent
        self.purpose = purpose

    async def run(self, state: AgentState) -> None:
        state.llm_response = await self.agent._call_llm(state.prompt, purpose=self.purpose)

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
            state.llm_response = {"status": "offline", "answer": "AI 어시스턴트에 일시적인 오류가 발생했습니다.", "model": ""}
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
