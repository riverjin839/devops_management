"""
Analyzer factory — 백엔드 선택의 원천은 AppSetting ``llm_settings.analyzer_backend``
(Settings → AI/LLM 탭). env ``ANALYZER_BACKEND`` 는 레거시/bootstrap 폴백이다
(``config.Settings.analyzer_backend`` 로 흡수 — raw os.getenv 제거).

Supported values: "claude" | "local_llm" | "rule_based"  (default: "rule_based")
"""

from app.services.analyzers.base import BaseAnalyzer
from app.services.llm import llm_service


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
        from app.services.analyzers.claude_analyzer import ClaudeAnalyzer
        return ClaudeAnalyzer()

    if backend == "local_llm":
        from app.services.analyzers.local_llm_analyzer import LocalLLMAnalyzer
        return LocalLLMAnalyzer()

    from app.services.analyzers.rule_based_analyzer import RuleBasedAnalyzer
    return RuleBasedAnalyzer()
