"""
Claude API analyzer — uses claude-opus-4-7 with adaptive thinking and prompt caching.
Caches the system prompt to reduce token costs on repeated K8s incident analysis calls.

테넌트 LLM 라우팅(D-114): anthropic SDK 직접 호출은 ``services/llm`` 게이트웨이 밖이다.
현재 테넌트가 ``incident_analysis`` 를 게이트웨이 프로필로 고정했으면(``tenant_route_override``)
외부 호출을 하지 않고 게이트웨이(``LocalLLMAnalyzer`` → ``chat_for_purpose``)로 우회한다.
직접 호출한 경우에도 사용량은 ``claude-direct`` 프로필 이름으로 게이트웨이 통계에 적재한다.
"""

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

import anthropic

from app.services.analyzers.base import (
    AnalysisResult,
    BaseAnalyzer,
    IncidentContext,
)
from app.services.llm import LLMResult, llm_service
from app.services.llm.service import current_llm_tenant, tenant_route_override

# 게이트웨이 사용량 통계에 남는 프로필 이름 (실제 프로필 목록에는 없다)
DIRECT_PROFILE = "claude-direct"
_PURPOSE = "incident_analysis"

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """\
You are an expert Kubernetes Site Reliability Engineer specializing in incident analysis.
Your job is to analyze Kubernetes pod incidents and provide structured, actionable insights.

When analyzing an incident you must:
1. Identify the root cause from logs, events, and describe output
2. Assess severity: critical (service down), warning (degraded), info (minor/transient)
3. Suggest concrete remediation steps ordered by priority
4. Reference relevant runbooks when applicable (OOMKilled, CrashLoopBackOff, ImagePullBackOff, etc.)
5. Provide a confidence score 0.0–1.0 reflecting how certain you are of the root cause

Always respond with valid JSON matching exactly this schema:
{
  "severity": "critical" | "warning" | "info",
  "root_cause": "<concise single sentence>",
  "suggested_actions": ["<action 1>", "<action 2>", ...],
  "related_runbooks": ["<runbook name>", ...],
  "confidence": <float 0.0–1.0>
}

Be terse. No prose outside the JSON object.\
"""


def _build_user_message(ctx: IncidentContext) -> str:
    sections: list[str] = [
        f"Pod: {ctx.pod_name}  Namespace: {ctx.namespace}  Time: {ctx.timestamp}",
    ]
    if ctx.related_workload:
        w = ctx.related_workload
        sections.append(f"Workload: {w.kind}/{w.name} status={w.status}")
    if ctx.argocd_status:
        a = ctx.argocd_status
        sections.append(f"ArgoCD app={a.app} sync={a.sync_status} last_sync={a.last_sync_at}")

    if ctx.events:
        event_lines = []
        for e in ctx.events:
            event_lines.append(f"  [{e.type}] {e.reason} (x{e.count}): {e.message}")
        sections.append("Events:\n" + "\n".join(event_lines))

    if ctx.current_logs:
        sections.append("Current logs (tail):\n```\n" + ctx.current_logs[-3000:] + "\n```")

    if ctx.previous_logs:
        sections.append("Previous container logs (tail):\n```\n" + ctx.previous_logs[-2000:] + "\n```")

    if ctx.describe_output:
        sections.append("kubectl describe (truncated):\n```\n" + ctx.describe_output[:3000] + "\n```")

    return "\n\n".join(sections)


def _parse_response(text: str) -> dict[str, Any]:
    """Extract JSON from model response, tolerating markdown code fences."""
    text = text.strip()
    # strip ```json ... ``` fences if present
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    return json.loads(text)


def _degraded_result(reason: str, *, root_cause: str, actions: list[str], confidence: float) -> AnalysisResult:
    return AnalysisResult(
        severity="info",
        root_cause=root_cause,
        suggested_actions=actions,
        confidence=confidence,
        analyzed_by="claude",
        analyzed_at=datetime.now(timezone.utc).isoformat(),
        degraded=True,
        degraded_reason=reason,
    )


class ClaudeAnalyzer(BaseAnalyzer):
    def __init__(self, api_key: str | None = None, db=None) -> None:
        # api_key=None lets the SDK pick up ANTHROPIC_API_KEY from env
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        # 게이트웨이 우회 시 설정 조회·RAG 에 쓴다 (없으면 캐시/기본값)
        self._db = db

    def _tenant_pins_gateway(self) -> bool:
        if current_llm_tenant() is None:
            return False
        try:
            cfg = llm_service.resolve_settings(self._db)
            return tenant_route_override(cfg, _PURPOSE) is not None
        except Exception:  # noqa: BLE001 — 판정 실패 시 데이터 반출 쪽으로 열지 않는다
            logger.warning("claude analyzer: LLM 설정 조회 실패 — 게이트웨이로 우회", exc_info=True)
            return True

    async def analyze(self, context: IncidentContext) -> AnalysisResult:
        if self._tenant_pins_gateway():
            logger.info("claude analyzer: 테넌트 LLM 라우팅 고정 — 게이트웨이(%s)로 우회", _PURPOSE)
            from app.services.analyzers.local_llm_analyzer import LocalLLMAnalyzer
            return await LocalLLMAnalyzer(db=self._db).analyze(context)

        user_msg = _build_user_message(context)

        started = time.monotonic()
        try:
            response = await self._create(user_msg)
        except Exception as exc:  # noqa: BLE001 — API 미가용·HTTP 오류는 degraded 결과로
            logger.warning("claude analyzer: API 호출 실패 — %s", exc)
            self._record_usage(started, None, error=f"{type(exc).__name__}: {str(exc)[:200]}")
            return _degraded_result(
                f"Claude API 호출 실패: {type(exc).__name__}: {str(exc)[:200]}",
                root_cause="Claude 분석을 수행하지 못했습니다 — 수동 확인이 필요합니다.",
                actions=["파드 로그를 수동으로 확인하세요.",
                         "Settings → AI/LLM 에서 분석기 설정과 Claude API 키를 확인하세요."],
                confidence=0.0,
            )
        self._record_usage(started, response)

        try:
            raw = ""
            for block in response.content or []:
                if getattr(block, "type", None) == "text":
                    raw = block.text
                    break
            parsed = _parse_response(raw)
            if not isinstance(parsed, dict):
                raise ValueError(f"JSON 객체가 아닙니다: {type(parsed).__name__}")
        except Exception as exc:  # noqa: BLE001 — 해석 불가 응답도 degraded 결과로
            logger.warning("claude analyzer: 응답 파싱 실패 — %s", exc)
            return _degraded_result(
                f"Claude 응답 파싱 실패: {str(exc)[:200]}",
                root_cause="Claude 가 해석 불가능한 응답을 반환했습니다.",
                actions=["파드 로그를 수동으로 확인하세요."],
                confidence=0.1,
            )

        return AnalysisResult(
            severity=parsed.get("severity", "info"),
            root_cause=parsed.get("root_cause", "Unknown"),
            suggested_actions=parsed.get("suggested_actions", []),
            related_runbooks=parsed.get("related_runbooks", []),
            confidence=parsed.get("confidence", 0.5),
            analyzed_by="claude",
            analyzed_at=datetime.now(timezone.utc).isoformat(),
        )

    @staticmethod
    def _record_usage(started: float, response: Any, *, error: str | None = None) -> None:
        """직접 호출도 게이트웨이 사용량 통계·테넌트 귀속에 남긴다 (fail-open)."""
        try:
            usage = getattr(response, "usage", None)
            llm_service.record_usage(DIRECT_PROFILE, _PURPOSE, LLMResult(
                status="error" if error else "ok",
                model=str(getattr(response, "model", "") or ""),
                profile=DIRECT_PROFILE,
                latency_ms=int((time.monotonic() - started) * 1000),
                prompt_tokens=getattr(usage, "input_tokens", None),
                completion_tokens=getattr(usage, "output_tokens", None),
                error=error,
            ))
        except Exception:  # noqa: BLE001
            logger.debug("claude analyzer: 사용량 적재 실패", exc_info=True)

    async def _create(self, user_msg: str):
        return await self._client.messages.create(
            model="claude-opus-4-7",
            max_tokens=1024,
            thinking={"type": "adaptive"},
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_msg}],
        )

    async def health_check(self) -> bool:
        try:
            await self._client.models.retrieve("claude-opus-4-7")
            return True
        except Exception:
            return False
