"""
Analyzer factory — 백엔드 선택의 원천은 AppSetting ``llm_settings.analyzer_backend``
(Settings → AI/LLM 탭). env ``ANALYZER_BACKEND`` 는 레거시/bootstrap 폴백이다
(``config.Settings.analyzer_backend`` 로 흡수 — raw os.getenv 제거).

Supported values: "claude" | "local_llm" | "rule_based"  (default: "rule_based")
"""

import logging

from app.services.analyzers.base import BaseAnalyzer
from app.services.llm import llm_service
from app.services.llm.service import current_llm_tenant

logger = logging.getLogger(__name__)

PURPOSE = "incident_analysis"


def tenant_pins_incident_llm(db=None) -> bool:
    """현재 LLM 테넌트 컨텍스트가 incident_analysis 용도의 프로필을 지정했는지(존재하는 프로필만).

    지정했으면 테넌트가 정한 LLM(예: 사내 전용)을 지켜야 하므로, 게이트웨이를 거치지 않는
    Claude 직접 호출 대신 게이트웨이 경유 분석기를 쓴다(D-114). 판정 규칙은
    ``services/llm/service.py`` ``effective_route`` 와 같다 — 없는 프로필을 가리키면 무시.
    """
    tenant = current_llm_tenant()
    if not tenant:
        return False
    ov = (tenant.get("routing") or {}).get(PURPOSE)
    if not isinstance(ov, dict) or not ov.get("primary"):
        return False
    try:
        names = {p["name"] for p in llm_service.resolve_settings(db)["profiles"]}
    except Exception:  # noqa: BLE001 — 설정 조회 실패 시 지정이 있다고 보고 보수적으로 게이트웨이를 쓴다
        return True
    return ov["primary"] in names


def get_analyzer_backend(db=None) -> str:
    """현재 유효한 analyzer 백엔드 이름 (UI 설정 → env → rule_based 순)."""
    try:
        cfg = llm_service.resolve_settings(db)
        return str(cfg.get("analyzer_backend") or "rule_based").lower().strip()
    except Exception:  # noqa: BLE001  (설정 조회 실패가 분석 자체를 막지 않게)
        return "rule_based"


def get_analyzer(db=None) -> BaseAnalyzer:
    backend = get_analyzer_backend(db)

    if backend == "claude":
        if tenant_pins_incident_llm(db):
            logger.info("analyzer: 테넌트가 incident_analysis LLM 을 지정 — Claude 대신 게이트웨이(local_llm) 사용")
            from app.services.analyzers.local_llm_analyzer import LocalLLMAnalyzer
            return LocalLLMAnalyzer(db=db)
        from app.services.analyzers.claude_analyzer import ClaudeAnalyzer
        return ClaudeAnalyzer()

    if backend == "local_llm":
        from app.services.analyzers.local_llm_analyzer import LocalLLMAnalyzer
        return LocalLLMAnalyzer(db=db)   # db 가 있으면 RAG 근거 인용 활성

    from app.services.analyzers.rule_based_analyzer import RuleBasedAnalyzer
    return RuleBasedAnalyzer()
