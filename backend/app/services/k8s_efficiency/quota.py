"""ResourceQuota 탄력 조정 판단 — 순수 함수(테스트 대상).

- used/hard ≥ up_threshold → raise: new = min(max, hard × (1 + step_pct/100))
- sustain_hours 동안 모든 샘플이 used/hard ≤ low_threshold → lower: new = max(min, used_max × lower_factor)
- new 가 현재 used 보다 작아지는 조정은 금지(hard < used → 파드 생성 즉시 거부되는 사고 방지)
- 쿨다운 이내면 none
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Optional


def merge_quota_params(defaults: dict[str, Any], overrides: Optional[dict[str, Any]]) -> dict[str, Any]:
    out = dict(defaults.get("quota") or {})
    for k, v in (overrides or {}).items():
        if v is not None and k in out:
            out[k] = v
    return out


def _decide(resource: str, hard: Optional[int], used_latest: Optional[int], used_window: list[Optional[int]],
            covered_hours: float, qp: dict[str, Any], lo: Optional[int], hi: Optional[int]) -> dict[str, Any]:
    if not hard or hard <= 0 or used_latest is None:
        return {"action": "none", "reason": "no_quota_or_usage"}
    ratio = used_latest / hard
    if ratio >= float(qp["up_threshold"]):
        new = int(math.ceil(hard * (1 + float(qp["step_pct"]) / 100.0)))
        if hi is not None:
            new = min(new, int(hi))
        if new <= hard:
            return {"action": "none", "reason": "at_max", "ratio": ratio}
        return {"action": "raise", "resource": resource, "from": hard, "to": new, "ratio": ratio,
                "reason": f"used/hard {ratio:.0%} ≥ {float(qp['up_threshold']):.0%}"}
    if covered_hours + 1e-9 < float(qp["sustain_hours"]):
        return {"action": "none", "reason": "insufficient_sustain", "ratio": ratio}
    vals = [v for v in used_window if v is not None]
    if not vals:
        return {"action": "none", "reason": "no_window_usage", "ratio": ratio}
    if max(vals) / hard > float(qp["low_threshold"]):
        return {"action": "none", "reason": "not_sustained_low", "ratio": ratio}
    new = int(math.ceil(max(vals) * float(qp["lower_factor"])))
    if lo is not None:
        new = max(new, int(lo))
    new = max(new, used_latest)  # hard < used 금지
    if new >= hard:
        return {"action": "none", "reason": "at_min_or_no_gain", "ratio": ratio}
    return {"action": "lower", "resource": resource, "from": hard, "to": new, "ratio": ratio,
            "reason": f"{float(qp['sustain_hours']):.0f}h 동안 used/hard ≤ {float(qp['low_threshold']):.0%}"}


def evaluate(policy, samples_desc: list, qp: dict[str, Any], now: Optional[datetime] = None) -> dict[str, Any]:
    """policy(K8sNamespacePolicy) + 최신순 NS 샘플 → {"cpu": decision, "memory": decision, "quota_name", "skipped"}."""
    now = now or datetime.utcnow()
    if not samples_desc:
        return {"skipped": "no_samples"}
    latest = samples_desc[0]
    if not latest.quota_name:
        return {"skipped": "no_quota"}
    last = getattr(policy, "last_quota_adjust_at", None)
    cd = timedelta(minutes=float(qp.get("cooldown_minutes") or 0))
    if last and now - last < cd:
        return {"skipped": "cooldown", "until": (last + cd).isoformat()}
    window_h = float(qp["sustain_hours"])
    win = [s for s in samples_desc if (now - s.sampled_at) <= timedelta(hours=window_h)]
    covered = (win[0].sampled_at - win[-1].sampled_at).total_seconds() / 3600.0 if len(win) > 1 else 0.0
    return {
        "quota_name": latest.quota_name,
        "cpu": _decide("cpu", latest.quota_hard_cpu_m, latest.quota_used_cpu_m,
                       [s.quota_used_cpu_m for s in win], covered, qp,
                       getattr(policy, "quota_cpu_min_m", None), getattr(policy, "quota_cpu_max_m", None)),
        "memory": _decide("memory", latest.quota_hard_mem_b, latest.quota_used_mem_b,
                          [s.quota_used_mem_b for s in win], covered, qp,
                          getattr(policy, "quota_mem_min_b", None), getattr(policy, "quota_mem_max_b", None)),
    }


def fmt_cpu_q(m: int) -> str:
    return f"{int(m)}m"


def fmt_mem_q(b: int) -> str:
    mi = int(math.ceil(b / (1024 ** 2)))
    return f"{mi}Mi"
