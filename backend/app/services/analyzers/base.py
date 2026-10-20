import logging
import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

logger = logging.getLogger(__name__)

SEVERITIES: frozenset[str] = frozenset({"critical", "warning", "info"})


_SEVERITY_SYNONYMS = {
    "high": "critical", "error": "critical", "severe": "critical", "major": "critical",
    "fatal": "critical", "emergency": "critical",
    "medium": "warning", "moderate": "warning", "warn": "warning", "minor": "warning",
    "low": "info", "informational": "info", "notice": "info",
}


def normalize_severity(value: Any) -> str:
    """LLM 이 돌려준 severity 를 critical|warning|info 로 정규화한다.

    대소문자·공백은 관대하게 받고, 그 밖의 값(예: "high", "error", None)은 ``info`` 로
    내리고 경고를 남긴다 — 응답 스키마(Literal) 검증 500 을 막기 위함.
    """
    sev = str(value or "").strip().lower()
    if sev in SEVERITIES:
        return sev
    # LLM 이 흔히 쓰는 동의어 — 위험도를 낮춰 버리지 않게 가까운 등급으로 올린다.
    if sev in _SEVERITY_SYNONYMS:
        return _SEVERITY_SYNONYMS[sev]
    logger.warning("analyzer: 알 수 없는 severity %r → 'info' 로 정규화", value)
    return "info"


_CONFIDENCE_WORDS = {
    "very high": 0.9, "high": 0.8, "medium": 0.5, "moderate": 0.5, "low": 0.2, "very low": 0.1,
}
# 해석할 수 없는 값의 중립값 — 0.0 은 "분석기가 결과를 못 냈다"(degraded) 표식과 겹치므로 쓰지 않는다.
_CONFIDENCE_UNKNOWN = 0.5


def _unit(x: float) -> float:
    """0~1 로 자른다. NaN·±inf 는 0.0 — 해석 불가 값을 최고 신뢰도로 올리지 않는다."""
    if not math.isfinite(x):
        return 0.0
    return max(0.0, min(1.0, x))


def clamp_confidence(value: Any) -> float:
    """confidence 를 0.0~1.0 으로 강제한다.

    프롬프트는 0.0~1.0 을 요구하지만 LLM 이 다른 척도로 답하는 경우를 받아 준다:
    1 보다 큰 숫자는 퍼센트(/100), ``"85%"`` 는 퍼센트, ``"8/10"`` 은 분수, ``"high"`` 같은
    단어는 고정값으로 바꾼다. 1~10 의 맨 숫자는 10점 척도인지 퍼센트인지 모호하므로 **낮게 읽는
    쪽(퍼센트)** 을 택한다 — 5%를 50%로 부풀려 신뢰도를 과대 표시하지 않기 위해서다.
    10점 척도는 ``"8/10"`` 처럼 분모가 있을 때만 인정한다.
    해석 불가(None·bool·알 수 없는 문자열)는 중립값 0.5, NaN·±inf·음수는 0.0.
    """
    x: float
    if isinstance(value, bool):
        return _CONFIDENCE_UNKNOWN
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _CONFIDENCE_WORDS:
            return _CONFIDENCE_WORDS[text]
        try:
            if text.endswith("%"):
                return _unit(float(text[:-1]) / 100.0)
            if "/" in text:
                num, _, den = text.partition("/")
                d = float(den)
                if not math.isfinite(d) or d <= 0:
                    return _CONFIDENCE_UNKNOWN
                return _unit(float(num) / d)
            x = float(text)
        except ValueError:
            return _CONFIDENCE_UNKNOWN
    else:
        try:
            x = float(value)
        except (TypeError, ValueError):
            return _CONFIDENCE_UNKNOWN
    if math.isfinite(x) and x > 1.0:
        x = x / 100.0
    return _unit(x)


def _str_list(value: Any) -> list[str]:
    """LLM 이 문자열 하나로 답한 목록 필드도 list[str] 로 맞춘다(응답 검증 500 방지)."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if v is not None]
    return [str(value)] if str(value).strip() else []


@dataclass
class KubeEvent:
    reason: str
    message: str
    count: int
    first_time: str
    last_time: str
    type: str = "Normal"  # Normal | Warning


@dataclass
class RelatedWorkload:
    kind: str
    name: str
    status: str


@dataclass
class ArgocdStatus:
    app: str
    sync_status: str
    last_sync_at: str


@dataclass
class IncidentContext:
    pod_name: str
    namespace: str
    timestamp: str
    events: list[KubeEvent]
    current_logs: str
    describe_output: str
    previous_logs: Optional[str] = None
    related_workload: Optional[RelatedWorkload] = None
    argocd_status: Optional[ArgocdStatus] = None


@dataclass
class AnalysisResult:
    severity: Literal["critical", "warning", "info"]
    root_cause: str
    suggested_actions: list[str]
    confidence: float
    # "rule_based" | "claude" | "local_llm[:<profile>:<model>]" — 어느 백엔드/프로필이
    # 분석했는지 UI 에 투명하게 표기하기 위한 자유 문자열.
    analyzed_by: str
    analyzed_at: str
    related_runbooks: list[str] = field(default_factory=list)
    # RAG 근거 인용 — {"title","source_type","ref_id","route","snippet","similarity"}[]
    # (rag_service.retrieve 가 공급, 프론트가 딥링크로 렌더)
    citations: list[dict] = field(default_factory=list)
    # 분석기 실패(LLM 미가용·HTTP 오류)·응답 파싱 실패로 "대체 결과"를 돌려준 경우 True.
    # UI 는 이 값으로 결과를 신뢰 가능한 분석과 구분해 표시한다.
    degraded: bool = False
    degraded_reason: Optional[str] = None

    def __post_init__(self) -> None:
        # 어느 분석기(·Celery 자동 분석 경로)든 같은 규칙으로 정규화 — 라우터 응답 검증
        # (severity Literal)에서 500 이 나지 않게 하고 confidence 를 0~1 로 맞춘다.
        self.severity = normalize_severity(self.severity)  # type: ignore[assignment]
        self.confidence = clamp_confidence(self.confidence)
        self.suggested_actions = _str_list(self.suggested_actions)
        self.related_runbooks = _str_list(self.related_runbooks)
        if not isinstance(self.root_cause, str):
            self.root_cause = "" if self.root_cause is None else str(self.root_cause)


class BaseAnalyzer(ABC):
    @abstractmethod
    async def analyze(self, context: IncidentContext) -> AnalysisResult:
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        ...
