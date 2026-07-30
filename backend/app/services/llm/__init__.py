"""LLM provider 게이트웨이 패키지.

폐쇄망에서 두 가지 LLM 백엔드(인클러스터 Ollama / 사내 OpenAI-호환 서비스)를
"엔드포인트 프로필 × 용도(purpose)별 라우팅"으로 병행 운용하기 위한 단일 진입점.
모든 LLM 호출(챗봇·장애분석·리뷰요약·아키텍처 문서·트렌드·임베딩)은
``llm_service`` 를 경유한다 — 라우팅·fallback·동시성 제한·사용량 통계·fail-safe 를
여기서 일괄 처리한다. 설계: docs/AIRGAP_LLM_ARCHITECTURE.md.
"""

from app.services.llm.base import LLMResult, BaseLLMProvider
from app.services.llm.service import llm_service, LLMService, PURPOSES, LLM_SETTINGS_KEY

__all__ = [
    "LLMResult",
    "BaseLLMProvider",
    "llm_service",
    "LLMService",
    "PURPOSES",
    "LLM_SETTINGS_KEY",
]
