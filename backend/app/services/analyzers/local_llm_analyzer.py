"""
Local LLM analyzer — ``services/llm`` 게이트웨이 경유 (purpose="incident_analysis").

직접 Ollama 를 호출하던 구현은 게이트웨이로 이관됐다 — 프로필 라우팅 덕분에
사내 OpenAI-호환 LLM / 인클러스터 Ollama 어느 쪽으로도 분석을 보낼 수 있다.
시스템 프롬프트(JSON-only, 한국어 값)는 ``services/llm/prompts.py`` 가 원천이다.
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
from app.services.llm import llm_service


def _build_prompt(ctx: IncidentContext) -> str:
    parts = [f"Pod: {ctx.pod_name}  Namespace: {ctx.namespace}"]
    if ctx.events:
        parts.append("Events: " + "; ".join(f"{e.reason}: {e.message}" for e in ctx.events[:5]))
    if ctx.current_logs:
        parts.append("Logs:\n" + ctx.current_logs[-2000:])
    if ctx.describe_output:
        parts.append("Describe:\n" + ctx.describe_output[:2000])
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
        result = await llm_service.chat_for_purpose("incident_analysis", prompt)

        if result.status != "ok":
            return AnalysisResult(
                severity="info",
                root_cause=f"LLM 분석 불가 ({result.error or result.status}) — 수동 확인이 필요합니다.",
                suggested_actions=["파드 로그를 수동으로 확인하세요.",
                                   "Settings → AI/LLM 에서 LLM 연결 상태를 확인하세요."],
                confidence=0.0,
                analyzed_by=f"local_llm:{result.profile or 'unknown'}",
                analyzed_at=datetime.now(timezone.utc).isoformat(),
            )

        analyzed_by = f"local_llm:{result.profile}:{result.model}"
        try:
            parsed = _parse(result.text)
        except Exception:
            return AnalysisResult(
                severity="info",
                root_cause="LLM 이 해석 불가능한 응답을 반환했습니다.",
                suggested_actions=["파드 로그를 수동으로 확인하세요."],
                confidence=0.1,
                analyzed_by=analyzed_by,
                analyzed_at=datetime.now(timezone.utc).isoformat(),
            )

        return AnalysisResult(
            severity=parsed.get("severity", "info"),
            root_cause=parsed.get("root_cause", "Unknown"),
            suggested_actions=parsed.get("suggested_actions", []),
            related_runbooks=parsed.get("related_runbooks", []),
            confidence=float(parsed.get("confidence", 0.4)),
            analyzed_by=analyzed_by,
            analyzed_at=datetime.now(timezone.utc).isoformat(),
            citations=citations,
        )

    async def health_check(self) -> bool:
        h = await llm_service.health_for_purpose("incident_analysis")
        return h.get("status") == "online"
