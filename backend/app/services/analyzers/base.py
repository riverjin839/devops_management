import logging
import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

logger = logging.getLogger(__name__)

SEVERITIES: frozenset[str] = frozenset({"critical", "warning", "info"})


def normalize_severity(value: Any) -> str:
    """LLM 이 돌려준 severity 를 critical|warning|info 로 정규화한다.

    대소문자·공백은 관대하게 받고, 그 밖의 값(예: "high", "error", None)은 ``info`` 로
    내리고 경고를 남긴다 — 응답 스키마(Literal) 검증 500 을 막기 위함.
    """
    sev = str(value or "").strip().lower()
    if sev in SEVERITIES:
        return sev
    logger.warning("analyzer: 알 수 없는 severity %r → 'info' 로 정규화", value)
    return "info"


def clamp_confidence(value: Any) -> float:
    """confidence 를 0.0~1.0 으로 강제한다.

    LLM 이 퍼센트(예: 85)로 답하는 경우가 흔해 ``1 < x <= 100`` 은 100 으로 나눈다.
    ``"85%"`` 같은 문자열도 받는다. 숫자로 해석 불가·NaN 은 0.0.
    """
    try:
        if isinstance(value, str) and value.strip().endswith("%"):
            x = float(value.strip()[:-1]) / 100.0
        else:
            x = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(x):
        return 0.0
    if 1.0 < x <= 100.0:
        x = x / 100.0
    return max(0.0, min(1.0, x))


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
