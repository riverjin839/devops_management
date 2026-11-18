"""서비스 구성 — 의존 규칙 평가(순수 함수, 단위 테스트 대상).

편집 중인 서비스의 초안 값과 다른 서비스의 값(최신 버전, 없으면 현재 노드 값)을 받아 규칙마다 결과를 낸다.
- recommend : 원인·대상 중 하나라도 이번에 바뀌었고 조건이 어긋나면 제안값과 함께 보고(체크하면 같이 저장)
- require   : 조건이 어긋나면 항상 보고. 이번 편집과 관련 있고(원인·대상이 바뀜) 대상이 이 서비스면 **저장을 막는다**.
             이번 편집과 무관한 기존 위반·다른 서비스에서 고쳐야 하는 위반은 경고만(저장은 막지 않음)
- impact    : 원인이 이번에 바뀌었으면 안내
"""
from __future__ import annotations

from typing import Any, Iterable, Optional, Protocol

from app.services.service_config.current import norm


class RuleLike(Protocol):
    id: Any
    rule_key: str
    service: str
    key: str
    target_service: Optional[str]
    target_key: Optional[str]
    kind: str
    rule_type: str
    params: Any
    reason: Optional[str]
    enabled: bool


def as_number(value: Any) -> Optional[float]:
    v = norm(value)
    if not v:
        return None
    try:
        return float(v.split()[0])
    except ValueError:
        return None


def _fmt(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


def _check(rule: RuleLike, src: Optional[str], tgt: Optional[str]) -> tuple[Optional[bool], Optional[str]]:
    """(ok, suggested). ok=None 이면 값이 없어 판단할 수 없음(보고하지 않는다)."""
    p = rule.params or {}
    t = rule.rule_type
    if t == "min_of_key":
        s, v = as_number(src), as_number(tgt)
        if s is None or v is None:
            return None, None
        return v >= s, _fmt(s)
    if t == "multiple_of_key":
        s, v = as_number(src), as_number(tgt)
        if s is None or v is None:
            return None, None
        need = s * float(p.get("factor") or 1)
        return v >= need, _fmt(need)
    if t == "max_value":
        v, mx = as_number(tgt), as_number(p.get("max"))
        if v is None or mx is None:
            return None, None
        return v <= mx, _fmt(mx)
    if t == "requires_when":
        if norm(src) != norm(p.get("when")):
            return True, None
        want = norm(p.get("equals")) if p.get("equals") is not None else None
        if want is not None:
            return norm(tgt) == want, want
        return bool(norm(tgt)), None
    if t == "fixed_value":
        want = norm(p.get("value"))
        if tgt is None:
            return None, want
        return norm(tgt) == want, want
    return True, None  # impact


def evaluate(
    rules: Iterable[RuleLike],
    service: str,
    values: dict[str, dict[str, Any]],
    changed: set[str],
) -> list[dict[str, Any]]:
    """``values`` = {서비스: {키: 값}} — 편집 중인 서비스는 초안(실효) 값. ``changed`` = 이번에 바뀐 키(편집 중인 서비스)."""
    out: list[dict[str, Any]] = []
    for r in rules:
        if not r.enabled or (r.service != service and r.target_service != service):
            continue
        src_vals = values.get(r.service) or {}
        if r.key == "*":
            if not src_vals:  # 원인 서비스를 관리하지 않으면(값 없음) 거는 조건도 없다
                continue
            src = None
            src_changed = r.service == service and bool(changed)
        else:
            src = norm(src_vals.get(r.key))
            src_changed = r.service == service and r.key in changed
        tgt = norm((values.get(r.target_service) or {}).get(r.target_key)) if r.target_service and r.target_key else None
        tgt_changed = r.target_service == service and r.target_key in changed
        touched = src_changed or tgt_changed

        if r.kind == "impact":
            if src_changed:
                out.append(_row(r, src, tgt, True, None, blocking=False, touched=True, service=service))
            continue
        ok, suggested = _check(r, src, tgt)
        if ok is None or ok:
            continue
        if r.kind == "recommend":
            if touched:
                out.append(_row(r, src, tgt, False, suggested, blocking=False, touched=True, service=service))
        elif r.kind == "require":
            blocking = touched and r.target_service == service
            out.append(_row(r, src, tgt, False, suggested, blocking=blocking, touched=touched, service=service))
    order = {"require": 0, "recommend": 1, "impact": 2}
    return sorted(out, key=lambda x: (order.get(x["kind"], 9), x["target_key"] or x["source_key"]))


def _row(r: RuleLike, src, tgt, ok, suggested, *, blocking: bool, touched: bool, service: str) -> dict[str, Any]:
    return {
        "rule_id": str(r.id), "rule_key": r.rule_key, "kind": r.kind, "rule_type": r.rule_type,
        "source_service": r.service, "source_key": r.key, "source_value": src,
        "target_service": r.target_service, "target_key": r.target_key, "target_value": tgt,
        "ok": ok, "suggested": suggested, "reason": r.reason,
        "blocking": blocking, "touched": touched,
        # 이 화면(편집 중 서비스)에서 바로 고칠 수 있는가 — 제안 적용 버튼을 보일지
        "fixable_here": r.target_service == service and suggested is not None,
    }
