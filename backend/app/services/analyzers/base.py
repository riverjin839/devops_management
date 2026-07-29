from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal, Optional


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


class BaseAnalyzer(ABC):
    @abstractmethod
    async def analyze(self, context: IncidentContext) -> AnalysisResult:
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        ...
