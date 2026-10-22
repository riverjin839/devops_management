"""
Local LLM analyzer — ``services/llm`` 게이트웨이 경유 (purpose="incident_analysis").

직접 Ollama 를 호출하던 구현은 게이트웨이로 이관됐다 — 프로필 라우팅 덕분에
사내 OpenAI-호환 LLM / 인클러스터 Ollama 어느 쪽으로도 분석을 보낼 수 있다.
시스템 프롬프트(JSON-only, 한국어 값)는 ``services/llm/prompts.py`` 가 원천이다.

- 출력 형식은 ``INCIDENT_ANALYSIS_SCHEMA`` 로 생성 단계에서 강제한다(Ollama ``format`` /
  OpenAI-호환 ``response_format``) — 서버가 미지원이면 provider 가 스키마 없이 재시도하고
  기존 파서(``_parse``)가 그대로 받는다.
- 수집 데이터(로그·이벤트·describe)는 ``wrap_untrusted`` 경계 안에 넣는다(로그 속 지시문 방어).
- LLM 호출·파싱이 실패하면 규칙 기반 분석 결과로 대체한다(``degraded=True`` 유지 —
  자동 분석 행은 failed 로 남지만 원인 후보·조치 가이드는 비지 않는다).
"""

import json
import re
from datetime import datetime, timezone
from typing import Any

from app.services.analyzers.base import (
    AnalysisResult,
    BaseAnalyzer,
    IncidentContext,
)
from app.services.analyzers.rule_based_analyzer import RuleBasedAnalyzer
from app.services.llm import llm_service
from app.services.llm.prompts import wrap_untrusted

# 시스템 프롬프트(prompts.py incident_analysis)가 요구하는 키와 같다.
INCIDENT_ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "severity": {"type": "string", "enum": ["critical", "warning", "info"]},
        "root_cause": {"type": "string"},
        "suggested_actions": {"type": "array", "items": {"type": "string"}},
        "related_runbooks": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["severity", "root_cause", "suggested_actions", "confidence"],
}


def _build_prompt(ctx: IncidentContext) -> str:
    parts = [f"Pod: {ctx.pod_name}  Namespace: {ctx.namespace}"]
    if ctx.events:
        parts.append("Events:\n" + wrap_untrusted(
            "이벤트", "\n".join(f"{e.reason}: {e.message}" for e in ctx.events[:5])))
    if ctx.current_logs:
        parts.append("Logs:\n" + wrap_untrusted("로그", ctx.current_logs[-2000:]))
    if ctx.describe_output:
        parts.append("Describe:\n" + wrap_untrusted("describe", ctx.describe_output[:2000]))
    return "\n\n".join(parts)


def _parse(text: str) -> dict[str, Any]:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    # find first { ... }
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        text = m.group(0)
    return json.loads(text)


class LocalLLMAnalyzer(BaseAnalyzer):
    def __init__(self, db=None) -> None:
        # db 를 주면 RAG(사내 문서 근거 인용)를 프롬프트에 주입한다 (없으면 생략).
        self._db = db

    async def _retrieve_citations(self, prompt: str) -> list[dict]:
        if self._db is None:
            return []
        try:
            from app.services import rag_service
            # 사용자 맥락이 없는 자동 분석 — cluster_scope/tenant_scope 를 넘기지 않으므로 rag_service 의
            # fail-closed 기본(공유 행·바인딩 없는 클러스터만)이 적용된다. 의도된 동작.
            return await rag_service.retrieve(self._db, prompt, k=4)
        except Exception:  # noqa: BLE001  (RAG 실패가 분석을 막지 않게)
            return []

    async def analyze(self, context: IncidentContext) -> AnalysisResult:
        prompt = _build_prompt(context)
        citations = await self._retrieve_citations(prompt)
        if citations:
            from app.services.rag_service import build_reference_block
            prompt = (
                build_reference_block(citations)
                + "\n\n위 참고자료에 근거한 판단에는 related_runbooks 또는 root_cause 에 "
                  "[번호] 를 붙여 출처를 밝혀라. 참고자료에 없는 내용은 '(추정)' 을 명시하라.\n\n"
                + prompt
            )
        result = await llm_service.chat_for_purpose(
            "incident_analysis", prompt, options={"json_schema": INCIDENT_ANALYSIS_SCHEMA},
        )

        if result.status != "ok":
            return await self._rule_based_fallback(
                context,
                source=f"local_llm:{result.profile or 'unknown'}",
                reason=f"LLM 호출 실패 ({result.status}): {(result.error or '')[:200]}".rstrip(": "),
                citations=citations,
            )

        analyzed_by = f"local_llm:{result.profile}:{result.model}"
        try:
            parsed = _parse(result.text)
            if not isinstance(parsed, dict):
                raise ValueError(f"JSON 객체가 아닙니다: {type(parsed).__name__}")
        except Exception as exc:  # noqa: BLE001
            return await self._rule_based_fallback(
                context,
                source=analyzed_by,
                reason=f"LLM 응답 파싱 실패: {str(exc)[:200]}",
                citations=citations,
            )

        return AnalysisResult(
            severity=parsed.get("severity", "info"),
            root_cause=parsed.get("root_cause", "Unknown"),
            suggested_actions=parsed.get("suggested_actions", []),
            related_runbooks=parsed.get("related_runbooks", []),
            confidence=parsed.get("confidence", 0.4),
            analyzed_by=analyzed_by,
            analyzed_at=datetime.now(timezone.utc).isoformat(),
            citations=citations,
        )

    @staticmethod
    async def _rule_based_fallback(
        context: IncidentContext, *, source: str, reason: str, citations: list[dict],
    ) -> AnalysisResult:
        """LLM 이 답하지 못할 때 규칙 기반 결과로 채운다 — 원인 후보·조치 가이드가 비지 않게.

        ``degraded=True`` 는 유지한다(신뢰 가능한 LLM 분석과 구분 — D-115). ``analyzed_by`` 는
        ``rule_based:fallback:<원래 분석기>`` 라 UI 가 "규칙 기반 (LLM 대체)" 로 표시한다.
        """
        try:
            rb = await RuleBasedAnalyzer().analyze(context)
        except Exception:  # noqa: BLE001  (규칙 분석은 순수 정규식이지만 방어)
            rb = AnalysisResult(
                severity="info", root_cause="자동 분석 불가 — 수동 확인이 필요합니다.",
                suggested_actions=["파드 로그를 수동으로 확인하세요."], confidence=0.0,
                analyzed_by="rule_based", analyzed_at=datetime.now(timezone.utc).isoformat(),
            )
        actions = list(rb.suggested_actions)
        actions.append("Settings → AI/LLM 에서 LLM 연결 상태를 확인하세요.")
        return AnalysisResult(
            severity=rb.severity,
            root_cause=rb.root_cause,
            suggested_actions=actions,
            related_runbooks=rb.related_runbooks,
            confidence=rb.confidence,
            analyzed_by=f"rule_based:fallback:{source}",
            analyzed_at=datetime.now(timezone.utc).isoformat(),
            citations=citations,
            degraded=True,
            degraded_reason=reason,
        )

    async def health_check(self) -> bool:
        h = await llm_service.health_for_purpose("incident_analysis")
        return h.get("status") == "online"
