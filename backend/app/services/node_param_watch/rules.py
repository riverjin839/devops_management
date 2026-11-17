"""노드 OS 파라미터 감시 — DB 없이 돌아가는 판정 로직(순수 함수, 단위 테스트 대상).

용어
- 런타임 값: 에이전트가 ``/proc/sys`` 에서 읽은 현재 커널 값. 파라미터가 없으면(모듈 미적재 등) ``None``.
- 영구 설정 값: ``/etc/sysctl.conf`` · ``sysctl.d`` 에 적힌 값(재부팅 뒤 적용될 값). 파일에 없으면 항목 자체가 없다.

규칙 적용 범위
- 클러스터 규칙(``cluster_id`` 지정)이 있는 파라미터는 그 클러스터에서 공통 규칙(``cluster_id`` NULL)을 무시한다
  — "공통 기준을 이 클러스터만 다르게" 를 규칙 하나로 표현하기 위함.
- ``node_pattern`` 은 노드 이름 glob(쉼표로 여러 개). 비우면 모든 노드.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from typing import Any, Iterable, Optional, Protocol
from uuid import UUID

OPERATORS: tuple[str, ...] = ("any", "eq", "ne", "gte", "lte", "in")
OPERATOR_LABELS: dict[str, str] = {
    "any": "변경만 추적",
    "eq": "같음",
    "ne": "다름",
    "gte": "이상",
    "lte": "이하",
    "in": "다음 중 하나",
}
SEVERITIES: tuple[str, ...] = ("info", "warning", "critical")
_SEV_RANK = {"info": 0, "warning": 1, "critical": 2}

# 파라미터 이름 — sysctl 표기(점 구분). 인터페이스 이름에 쓰이는 '-'·'@' 까지 허용한다.
PARAM_NAME_MAX = 300


class RuleLike(Protocol):
    id: Any
    cluster_id: Optional[UUID]
    param: str
    operator: str
    expected: Optional[str]
    node_pattern: Optional[str]
    severity: str
    alert_on_change: bool
    check_persistent: bool
    enabled: bool


def normalize_value(value: Any) -> Optional[str]:
    """공백 정규화 — ``tcp_rmem`` 처럼 탭으로 구분된 다중 값도 같은 문자열로 비교한다."""
    if value is None:
        return None
    return " ".join(str(value).split())


def valid_param_name(name: str) -> bool:
    if not name or len(name) > PARAM_NAME_MAX:
        return False
    if name.startswith(".") or name.endswith(".") or ".." in name:
        return False
    return all(ch.isalnum() or ch in "._-@:" for ch in name)


def worse(a: str, b: str) -> str:
    return a if _SEV_RANK.get(a, 1) >= _SEV_RANK.get(b, 1) else b


def _as_number(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    head = value.split()[0] if value.split() else ""
    try:
        return float(head)
    except ValueError:
        return None


def check_expected(operator: str, expected: Optional[str], actual: Optional[str]) -> tuple[bool, str]:
    """(통과 여부, 사유). ``any`` 는 항상 통과(변경 추적 전용)."""
    op = operator or "any"
    if op == "any":
        return True, ""
    if actual is None:
        return False, "노드에 이 파라미터가 없습니다 (커널 모듈 미적재·오타 확인)"
    exp = normalize_value(expected) or ""
    if op == "eq":
        return (actual == exp, "" if actual == exp else f"기대값 {exp}, 현재 {actual}")
    if op == "ne":
        return (actual != exp, "" if actual != exp else f"{exp} 이면 안 됩니다")
    if op in ("gte", "lte"):
        a, e = _as_number(actual), _as_number(exp)
        if a is None or e is None:
            return False, f"숫자로 비교할 수 없습니다 (기대값 {exp}, 현재 {actual})"
        ok = a >= e if op == "gte" else a <= e
        word = "이상" if op == "gte" else "이하"
        return ok, "" if ok else f"{exp} {word}이어야 합니다 (현재 {actual})"
    if op == "in":
        choices = [normalize_value(c) for c in (expected or "").split("|")]
        choices = [c for c in choices if c]
        ok = actual in choices
        return ok, "" if ok else f"{' | '.join(choices)} 중 하나여야 합니다 (현재 {actual})"
    return True, ""


def node_matches(pattern: Optional[str], node: str) -> bool:
    pats = [p.strip() for p in (pattern or "").split(",") if p.strip()]
    if not pats:
        return True
    return any(fnmatchcase(node, p) for p in pats)


def rules_for_node(rules: Iterable[RuleLike], cluster_id: UUID, node: str) -> dict[str, list[RuleLike]]:
    """이 노드에 적용되는 규칙을 파라미터별로 묶는다(클러스터 규칙이 공통 규칙을 가린다)."""
    scoped: dict[str, list[RuleLike]] = {}
    common: dict[str, list[RuleLike]] = {}
    for r in rules:
        if not r.enabled:
            continue
        if r.cluster_id is not None and r.cluster_id != cluster_id:
            continue
        if not node_matches(r.node_pattern, node):
            continue
        bucket = scoped if r.cluster_id is not None else common
        bucket.setdefault(r.param, []).append(r)
    out = dict(common)
    out.update(scoped)  # 같은 파라미터면 클러스터 규칙만 남는다
    return out


def diff_runtime(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    """두 번의 보고 사이 런타임 값 변경. 양쪽 다 감시하던 파라미터만 비교한다 —
    감시 목록이 늘거나 줄어서 생기는 추가·삭제는 실제 노드 변경이 아니므로 제외."""
    out: list[dict[str, Any]] = []
    for key in sorted(set(old) & set(new)):
        ov, nv = normalize_value(old.get(key)), normalize_value(new.get(key))
        if ov == nv:
            continue
        if ov is None:
            ctype = "added"       # 없던 파라미터가 생김(모듈 적재)
        elif nv is None:
            ctype = "removed"     # 있던 파라미터가 사라짐(모듈 해제)
        else:
            ctype = "changed"
        out.append({"param": key, "old_value": ov, "new_value": nv, "change_type": ctype})
    return out


@dataclass
class ParamStatus:
    param: str
    runtime: Optional[str]
    persistent: Optional[str]
    persistent_source: Optional[str]
    severity: str
    operator: str
    expected: Optional[str]
    ok: bool = True
    reason: str = ""
    persisted_ok: bool = True
    reported: bool = True
    rule_ids: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "param": self.param,
            "runtime": self.runtime,
            "persistent": self.persistent,
            "persistent_source": self.persistent_source,
            "severity": self.severity,
            "operator": self.operator,
            "expected": self.expected,
            "ok": self.ok,
            "reason": self.reason,
            "persisted_ok": self.persisted_ok,
            "reported": self.reported,
            "rule_ids": self.rule_ids,
        }


def evaluate_node(
    by_param: dict[str, list[RuleLike]],
    runtime: dict[str, Optional[str]],
    persistent: dict[str, dict[str, Any]],
) -> list[ParamStatus]:
    """파라미터별 판정. 한 파라미터에 규칙이 여럿이면 하나라도 어긋나면 위반, 심각도는 가장 높은 것."""
    rows: list[ParamStatus] = []
    for param in sorted(by_param):
        rules = by_param[param]
        if param not in runtime:
            # 감시 목록에 막 추가됐거나 읽기 권한이 없어 보고에서 빠진 값 — '노드에 없음'(None)과 구분해 판정하지 않는다.
            first = rules[0]
            rows.append(ParamStatus(
                param=param, runtime=None, persistent=None, persistent_source=None,
                severity=first.severity or "warning", operator=first.operator, expected=first.expected,
                reason="에이전트가 아직 이 값을 보고하지 않았습니다", reported=False,
                rule_ids=[str(r.id) for r in rules],
            ))
            continue
        actual = normalize_value(runtime.get(param))
        pinfo = persistent.get(param) or {}
        pval = normalize_value(pinfo.get("value")) if pinfo else None
        severity = "info"
        reasons: list[str] = []
        ok = True
        check_persist = False
        for r in rules:
            severity = worse(severity, r.severity or "warning")
            passed, why = check_expected(r.operator, r.expected, actual)
            if not passed:
                ok = False
                if why and why not in reasons:
                    reasons.append(why)
            check_persist = check_persist or bool(r.check_persistent)
        primary = rules[0]
        # 영구 설정에 값이 있는데 런타임과 다르면 재부팅 시 값이 바뀐다. 파일에 없으면(커널 기본값) 판정하지 않는다.
        persisted_ok = not (check_persist and pval is not None and actual is not None and pval != actual)
        rows.append(ParamStatus(
            param=param,
            runtime=actual,
            persistent=pval,
            persistent_source=pinfo.get("source") if pinfo else None,
            severity=severity,
            operator=primary.operator,
            expected=primary.expected,
            ok=ok,
            reason="; ".join(reasons),
            persisted_ok=persisted_ok,
            rule_ids=[str(r.id) for r in rules],
        ))
    return rows


def change_severity(by_param: dict[str, list[RuleLike]], changes: list[dict[str, Any]]) -> Optional[str]:
    """변경 알람 심각도 — 변경된 파라미터 중 ``alert_on_change`` 규칙이 있는 것의 최고 심각도. 없으면 None(알람 안 함)."""
    sev: Optional[str] = None
    for ch in changes:
        for r in by_param.get(ch["param"], []):
            if r.alert_on_change:
                sev = r.severity if sev is None else worse(sev, r.severity)
    return sev
