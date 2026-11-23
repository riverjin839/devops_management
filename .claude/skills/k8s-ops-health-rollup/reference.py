"""Health rollup — KM(K8s Manager) 헬스 모델(healthSummary/healthChecks/entityStatus/maintenanceMode) +
외부 모니터링(Nagios 등) 매핑 패턴.

KM 상태 문자열: 요약 + 비정상 체크만 덧붙인다. 상태 → 외부 코드 매핑은 한 곳(KM_STATE_CODES 격)에서만.

계층: Cluster ← Service(워크로드/애드온) ← Role(파드/노드 인스턴스) ← HealthCheck.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class Health(IntEnum):
    """정렬 가능한 심각도. 값이 클수록 나쁨. 롤업 = max(활성 체크)."""
    DISABLED = 0  # 사용자가 끈 체크 — 롤업에서 제외
    HISTORY_NOT_AVAILABLE = 1  # 수집 직후 데이터 부족
    NOT_AVAILABLE = 2  # 수집 실패/프로브 도달 불가 — "모름" 이지 "정상" 이 아님
    GOOD = 3
    CONCERNING = 4
    BAD = 5


UNKNOWN_STATES = {Health.HISTORY_NOT_AVAILABLE, Health.NOT_AVAILABLE}


@dataclass
class HealthCheck:
    name: str  # 예: NODE_READY, POD_RESTARTS, PVC_USAGE
    summary: Health
    explanation: str = ""
    suppressed: bool = False  # 개별 체크 경고 억제(KM 경고 억제와 같은 발상)


@dataclass
class Entity:
    name: str
    kind: str  # cluster | service | role | host
    checks: list[HealthCheck] = field(default_factory=list)
    children: list["Entity"] = field(default_factory=list)
    maintenance: bool = False  # KM maintenanceMode: 상태는 계산하되 알람은 억제
    entity_status: str = ""  # 운영 상태(STARTED/STOPPED/...) — 건강과 별개 축


def rollup(e: Entity) -> Health:
    """자기 체크 + 자식 롤업 중 최악. DISABLED/suppressed 는 제외. 전부 모름이면 NOT_AVAILABLE."""
    vals = [c.summary for c in e.checks if c.summary != Health.DISABLED and not c.suppressed]
    vals += [h for h in (rollup(ch) for ch in e.children) if h != Health.DISABLED]
    if not vals:
        return Health.DISABLED if e.checks or e.children else Health.NOT_AVAILABLE
    known = [v for v in vals if v not in UNKNOWN_STATES]
    if not known:
        return max(vals)
    worst = max(known)
    # 알려진 값이 전부 GOOD 인데 일부가 "모름" 이면 GOOD 으로 덮지 않고 CONCERNING 으로 올린다
    if worst == Health.GOOD and len(known) != len(vals):
        return Health.CONCERNING
    return worst


def should_alert(e: Entity, parent_maintenance: bool = False) -> bool:
    """유지보수 모드는 상속된다(클러스터 유지보수 → 하위 전부 억제)."""
    if e.maintenance or parent_maintenance:
        return False
    return rollup(e) in (Health.CONCERNING, Health.BAD)


def bad_checks(e: Entity) -> list[HealthCheck]:
    return [c for c in e.checks if c.summary not in (Health.GOOD, Health.DISABLED) and not c.suppressed]


def status_line(e: Entity) -> str:
    """KM 상태 문자열: '<CODE>: <summary>, CHECK=summary, ...' (비정상 체크만)."""
    h = rollup(e)
    s = f"{NAGIOS[h][1]}: {h.name}"
    if h not in (Health.GOOD, Health.DISABLED):
        s += "".join(f", {c.name}={c.summary.name}" for c in bad_checks(e))
    return s


# 외부 시스템 매핑 — 한 곳에서만 정의한다
NAGIOS = {  # (exit code, label)
    Health.DISABLED: (3, "UNKNOWN"), Health.HISTORY_NOT_AVAILABLE: (3, "UNKNOWN"),
    Health.NOT_AVAILABLE: (3, "UNKNOWN"), Health.GOOD: (0, "OK"),
    Health.CONCERNING: (1, "WARNING"), Health.BAD: (2, "CRITICAL"),
}
TRAFFIC_LIGHT = {  # PEP StatusEnum 등 3색 체계
    Health.GOOD: "healthy", Health.CONCERNING: "warning", Health.BAD: "critical",
    Health.NOT_AVAILABLE: "unknown", Health.HISTORY_NOT_AVAILABLE: "pending", Health.DISABLED: "disabled",
}


# ── K8s 원천 → HealthCheck 변환 예 ──
def node_checks(conditions: dict[str, str], unschedulable: bool = False) -> list[HealthCheck]:
    """conditions: {"Ready":"True","MemoryPressure":"False",...}"""
    out = []
    ready = conditions.get("Ready")
    out.append(HealthCheck("NODE_READY", Health.GOOD if ready == "True"
                           else Health.NOT_AVAILABLE if ready in (None, "Unknown") else Health.BAD,
                           f"Ready={ready}"))
    for p in ("MemoryPressure", "DiskPressure", "PIDPressure"):
        if p in conditions:
            out.append(HealthCheck(f"NODE_{p.upper()}", Health.BAD if conditions[p] == "True" else Health.GOOD))
    if unschedulable:
        out.append(HealthCheck("NODE_SCHEDULABLE", Health.CONCERNING, "cordoned"))
    return out


def threshold_check(name: str, value: float | None, warn: float, crit: float, unit: str = "") -> HealthCheck:
    if value is None:
        return HealthCheck(name, Health.NOT_AVAILABLE, "no data")
    h = Health.BAD if value >= crit else Health.CONCERNING if value >= warn else Health.GOOD
    return HealthCheck(name, h, f"{value}{unit} (warn {warn}, crit {crit})")
