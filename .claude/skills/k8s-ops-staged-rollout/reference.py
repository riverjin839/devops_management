"""Staged distribution — cm_api Parcel 라이프사이클(download → distribute → activate) 패턴.

원본: parcels.py `ApiParcel{product, version, stage, state{progress,totalProgress,count,totalCount,warnings,errors}}`,
start_download/cancel_download/remove_download/start_distribution/cancel_distribution/
start_removal_of_distribution/activate/deactivate.

핵심: "받기(중앙)" / "뿌리기(노드)" / "켜기(전환)" 를 분리해 각 단계가 독립 취소·재시도·진행률을 가진다.
켜기 직전까지는 서비스 영향이 0 이고, 켜기는 원자적 전환(하나의 버전만 ACTIVATED).

K8s 매핑 (폐쇄망 애드온/이미지 업그레이드)
- DOWNLOAD     : 번들(이미지 tar/Helm chart) → 내부 레지스트리(Harbor/Nexus) push
- DISTRIBUTE   : 노드 사전 pull (pre-pull DaemonSet / crictl pull) — count/totalCount = 완료 노드/전체 노드
- ACTIVATE     : 워크로드 이미지 태그 전환(rolling-ops 로 롤링) / Helm upgrade
- DEACTIVATE   : 직전 ACTIVATED 버전으로 되돌림(이미지가 노드에 남아 있어 빠르다)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Stage(str, Enum):
    AVAILABLE_REMOTELY = "AVAILABLE_REMOTELY"
    DOWNLOADING = "DOWNLOADING"
    DOWNLOADED = "DOWNLOADED"
    DISTRIBUTING = "DISTRIBUTING"
    DISTRIBUTED = "DISTRIBUTED"
    UNDISTRIBUTING = "UNDISTRIBUTING"
    ACTIVATING = "ACTIVATING"
    ACTIVATED = "ACTIVATED"


# action -> (허용 시작 stage, 진입 stage, 완료 stage)
ACTIONS: dict[str, tuple[set[Stage], Stage, Stage]] = {
    "start_download": ({Stage.AVAILABLE_REMOTELY}, Stage.DOWNLOADING, Stage.DOWNLOADED),
    "cancel_download": ({Stage.DOWNLOADING}, Stage.AVAILABLE_REMOTELY, Stage.AVAILABLE_REMOTELY),
    "remove_download": ({Stage.DOWNLOADED}, Stage.AVAILABLE_REMOTELY, Stage.AVAILABLE_REMOTELY),
    "start_distribution": ({Stage.DOWNLOADED}, Stage.DISTRIBUTING, Stage.DISTRIBUTED),
    "cancel_distribution": ({Stage.DISTRIBUTING}, Stage.DOWNLOADED, Stage.DOWNLOADED),
    "start_removal_of_distribution": ({Stage.DISTRIBUTED}, Stage.UNDISTRIBUTING, Stage.DOWNLOADED),
    "activate": ({Stage.DISTRIBUTED}, Stage.ACTIVATING, Stage.ACTIVATED),
    "deactivate": ({Stage.ACTIVATED}, Stage.DISTRIBUTED, Stage.DISTRIBUTED),
}


@dataclass
class Progress:
    progress: int = 0  # 현재 단계 바이트/단위
    total_progress: int = 0
    count: int = 0  # 완료 노드 수
    total_count: int = 0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def percent(self) -> float:
        if self.total_count:
            return round(100 * self.count / self.total_count, 1)
        if self.total_progress:
            return round(100 * self.progress / self.total_progress, 1)
        return 0.0


@dataclass
class Package:
    product: str  # 예: "cilium", "ingress-nginx", "pep-backend"
    version: str
    cluster: str
    stage: Stage = Stage.AVAILABLE_REMOTELY
    state: Progress = field(default_factory=Progress)

    def allowed_actions(self) -> list[str]:
        return [a for a, (src, _, _) in ACTIONS.items() if self.stage in src]


class TransitionError(Exception):
    pass


def begin(pkg: Package, action: str, siblings: list[Package] = ()) -> Package:
    """액션 시작. activate 는 같은 product 의 다른 ACTIVATED 버전을 DISTRIBUTED 로 내린다(원자 전환)."""
    if action not in ACTIONS:
        raise TransitionError(f"unknown action {action}")
    src, entering, _ = ACTIONS[action]
    if pkg.stage not in src:
        raise TransitionError(f"{action} not allowed in {pkg.stage.value}; allowed={pkg.allowed_actions()}")
    if action == "activate":
        for s in siblings:
            if s.product == pkg.product and s.cluster == pkg.cluster and s.stage == Stage.ACTIVATED and s is not pkg:
                s.stage = Stage.DISTRIBUTED
    pkg.stage, pkg.state = entering, Progress()
    if action in ("cancel_download", "remove_download", "cancel_distribution", "deactivate"):
        pkg.stage = ACTIONS[action][2]
    return pkg


def report(pkg: Package, *, count: int | None = None, total_count: int | None = None,
           progress: int | None = None, total_progress: int | None = None,
           warning: str | None = None, error: str | None = None) -> None:
    for k, v in (("count", count), ("total_count", total_count), ("progress", progress), ("total_progress", total_progress)):
        if v is not None:
            setattr(pkg.state, k, v)
    if warning:
        pkg.state.warnings.append(warning)
    if error:
        pkg.state.errors.append(error)


def complete(pkg: Package, action: str, *, min_ratio: float = 1.0) -> Package:
    """진행 단계 완료 처리. 분배는 min_ratio(예: 0.95) 이상 노드 성공이어야 DISTRIBUTED."""
    _, entering, done = ACTIONS[action]
    if pkg.stage != entering:
        raise TransitionError(f"{action} not in progress (stage={pkg.stage.value})")
    st = pkg.state
    if action == "start_distribution" and st.total_count and st.count / st.total_count < min_ratio:
        raise TransitionError(f"distributed {st.count}/{st.total_count} < {min_ratio:.0%}; errors={st.errors[:5]}")
    if st.errors and action != "start_distribution":
        raise TransitionError(f"errors: {st.errors[:5]}")
    pkg.stage = done
    return pkg


def fail(pkg: Package, action: str) -> Package:
    """진행 중 실패 → 시작 이전 stage 로 롤백(재시도 가능)."""
    src, entering, _ = ACTIONS[action]
    if pkg.stage == entering:
        pkg.stage = next(iter(src))
    return pkg
