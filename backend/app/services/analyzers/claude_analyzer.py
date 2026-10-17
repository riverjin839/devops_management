"""
Claude API analyzer — uses claude-opus-4-7 with adaptive thinking and prompt caching.
Caches the system prompt to reduce token costs on repeated K8s incident analysis calls.
"""

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

import anthropic

from app.services.llm import llm_service
from app.services.llm.base import LLMResult
from app.services.analyzers.base import (
    AnalysisResult,
    BaseAnalyzer,
    IncidentContext,
)

logger = logging.getLogger(__name__)

CLAUDE_MODEL = "claude-opus-4-7"

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


def _record_usage(started: float, *, status: str, prompt_tokens=None, completion_tokens=None,
                  error: str | None = None) -> None:
    """Claude 직접 호출도 LLM 사용량 대시보드·테넌트별 사용량에 남긴다(프로필명 ``claude``, fail-open)."""
    try:
        llm_service.record_external_usage("claude", "incident_analysis", LLMResult(
            status=status, model=CLAUDE_MODEL, profile="claude",
            latency_ms=int((time.monotonic() - started) * 1000),
            prompt_tokens=prompt_tokens, completion_tokens=completion_tokens, error=error,
        ))
    except Exception:  # noqa: BLE001 — 통계 기록이 분석을 막지 않는다
        logger.debug("claude analyzer: 사용량 기록 실패", exc_info=True)


class ClaudeAnalyzer(BaseAnalyzer):
    def __init__(self, api_key: str | None = None) -> None:
        # api_key=None lets the SDK pick up ANTHROPIC_API_KEY from env
        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    async def analyze(self, context: IncidentContext) -> AnalysisResult:
        user_msg = _build_user_message(context)

        started = time.monotonic()
        try:
            response = await self._create(user_msg)
        except Exception as exc:  # noqa: BLE001 — API 미가용·HTTP 오류는 degraded 결과로
            logger.warning("claude analyzer: API 호출 실패 — %s", exc)
            _record_usage(started, status="error", error=f"{type(exc).__name__}: {exc}")
            return _degraded_result(
                f"Claude API 호출 실패: {type(exc).__name__}: {str(exc)[:200]}",
                root_cause="Claude 분석을 수행하지 못했습니다 — 수동 확인이 필요합니다.",
                actions=["파드 로그를 수동으로 확인하세요.",
                         "Settings → AI/LLM 에서 분석기 설정과 Claude API 키를 확인하세요."],
                confidence=0.0,
            )

        usage = getattr(response, "usage", None)
        _record_usage(started, status="ok",
                      prompt_tokens=getattr(usage, "input_tokens", None),
                      completion_tokens=getattr(usage, "output_tokens", None))

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

    async def _create(self, user_msg: str):
        return await self._client.messages.create(
            model=CLAUDE_MODEL,
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
            await self._client.models.retrieve(CLAUDE_MODEL)
            return True
        except Exception:
            return False
