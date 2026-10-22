"""
LLM 기반 한국어 요약기 — ``services/llm`` 게이트웨이 경유 (purpose="trends")
- 라우팅에 따라 인클러스터 Ollama / 사내 LLM 어느 쪽으로도 요약 가능
- 실패는 대체 문구로 덮지 않는다(A-8): ``SummaryResult(text=None, error=사유)`` 를 돌려주고, 호출부가
  ``summary_ko=None`` + ``summary_status='failed'`` 로 저장해 다음 수집 때 재시도한다.
"""
import logging
from dataclasses import dataclass

from app.services.llm import llm_service

logger = logging.getLogger(__name__)

_ITEM_PROMPT = """다음은 Kubernetes/Linux/클라우드 네이티브 분야의 기술 변경사항입니다.
핵심 내용을 한국어로 3~5문장으로 간결하게 요약해주세요.
버전, 주요 변경사항, 영향도를 중심으로 작성하세요.

제목: {title}
내용:
{content}

한국어 요약:"""

_DIGEST_PROMPT = """다음은 오늘({date}) 수집된 기술 동향 목록입니다.
전체를 3~7문장으로 한국어 요약해주세요.
중요 릴리즈와 주목할 변경사항을 중심으로 작성하세요.

{items}

오늘의 종합 동향:"""


@dataclass
class SummaryResult:
    text: str | None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return bool(self.text)


async def summarize_item(title: str, content: str) -> SummaryResult:
    """단일 아이템 한국어 요약"""
    prompt = _ITEM_PROMPT.format(title=title, content=(content or "")[:1500])
    return await _call_llm(prompt)


async def summarize_digest(digest_date: str, items: list[dict]) -> SummaryResult:
    """하루 전체 동향 종합 요약"""
    lines = "\n".join(
        f"- [{(i.get('category') or '').upper()}] {i['title']}" + (f" ({i['version']})" if i.get("version") else "")
        for i in items
    )
    prompt = _DIGEST_PROMPT.format(date=digest_date, items=lines[:3000])
    return await _call_llm(prompt)


async def _call_llm(prompt: str) -> SummaryResult:
    try:
        result = await llm_service.chat_for_purpose(
            "trends", prompt, options={"temperature": 0.3, "num_predict": 512},
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("LLM 요약 실패: %s", e)
        return SummaryResult(None, f"LLM 호출 실패 — {type(e).__name__}: {str(e)[:300]}")
    if result.status == "ok" and (result.text or "").strip():
        return SummaryResult(result.text.strip())
    if result.status == "ok":
        return SummaryResult(None, "LLM 이 빈 응답을 돌려줬습니다")
    logger.warning("LLM 요약 실패 (profile=%s): %s", result.profile, result.error)
    err = str(result.error or result.status or "알 수 없는 오류")[:300]
    profile = f" (프로필 {result.profile})" if getattr(result, "profile", None) else ""
    return SummaryResult(None, f"LLM 요약 실패{profile} — {err}")
