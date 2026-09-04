"""ResourceQuota 탄력 판단 — raise/lower/none, min/max 클램프, sustain 창, 쿨다운, hard<used 금지."""
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

from app.services.k8s_efficiency import quota
from app.services.k8s_efficiency.settings import POLICY_DEFAULTS

QP = dict(POLICY_DEFAULTS["quota"])


def _s(minutes_ago, hard=1000, used=500, name="q"):
    return NS(sampled_at=datetime(2026, 1, 1, 12, 0) - timedelta(minutes=minutes_ago),
              quota_name=name, quota_hard_cpu_m=hard, quota_used_cpu_m=used,
              quota_hard_mem_b=None, quota_used_mem_b=None)


NOW = datetime(2026, 1, 1, 12, 0)


def _policy(**kw):
    base = dict(last_quota_adjust_at=None, quota_cpu_min_m=None, quota_cpu_max_m=None,
                quota_mem_min_b=None, quota_mem_max_b=None)
    base.update(kw)
    return NS(**base)


def test_raise_when_used_over_threshold():
    dec = quota.evaluate(_policy(), [_s(0, hard=1000, used=900)], QP, NOW)
    assert dec["cpu"]["action"] == "raise" and dec["cpu"]["to"] == 1250  # +25%


def test_raise_clamped_to_max():
    dec = quota.evaluate(_policy(quota_cpu_max_m=1100), [_s(0, hard=1000, used=900)], QP, NOW)
    assert dec["cpu"]["action"] == "raise" and dec["cpu"]["to"] == 1100
    dec = quota.evaluate(_policy(quota_cpu_max_m=1000), [_s(0, hard=1000, used=900)], QP, NOW)
    assert dec["cpu"]["action"] == "none" and dec["cpu"]["reason"] == "at_max"


def test_lower_requires_sustained_low_usage():
    qp = {**QP, "sustain_hours": 2}
    # 2시간 창 전체가 낮음(≤50%) → lower: used_max 300 × 1.3 = 390
    samples = [_s(0, used=300), _s(60, used=250), _s(120, used=300)]
    dec = quota.evaluate(_policy(), samples, qp, NOW)
    assert dec["cpu"]["action"] == "lower" and dec["cpu"]["to"] == 390
    # 창 안에 한 번이라도 높았으면 none
    samples = [_s(0, used=300), _s(60, used=700), _s(120, used=300)]
    dec = quota.evaluate(_policy(), samples, qp, NOW)
    assert dec["cpu"]["action"] == "none" and dec["cpu"]["reason"] == "not_sustained_low"
    # 관측 기간이 sustain 미만이면 none
    dec = quota.evaluate(_policy(), [_s(0, used=300), _s(30, used=300)], qp, NOW)
    assert dec["cpu"]["reason"] == "insufficient_sustain"


def test_lower_clamped_to_min_and_never_below_used():
    qp = {**QP, "sustain_hours": 1}
    samples = [_s(0, used=300), _s(30, used=300), _s(60, used=300)]
    dec = quota.evaluate(_policy(quota_cpu_min_m=800), samples, qp, NOW)
    assert dec["cpu"]["action"] == "lower" and dec["cpu"]["to"] == 800
    # min 이 hard 이상이면 이득 없음 → none
    dec = quota.evaluate(_policy(quota_cpu_min_m=1000), samples, qp, NOW)
    assert dec["cpu"]["action"] == "none"


def test_cooldown_and_missing_quota():
    p = _policy(last_quota_adjust_at=NOW - timedelta(minutes=10))
    dec = quota.evaluate(p, [_s(0, used=900)], QP, NOW)
    assert dec["skipped"] == "cooldown"
    assert quota.evaluate(_policy(), [], QP, NOW)["skipped"] == "no_samples"
    assert quota.evaluate(_policy(), [_s(0, name=None)], QP, NOW)["skipped"] == "no_quota"


def test_quantity_formatters():
    assert quota.fmt_cpu_q(250) == "250m"
    assert quota.fmt_mem_q(256 * 1024 ** 2) == "256Mi"
    assert quota.fmt_mem_q(256 * 1024 ** 2 + 1) == "257Mi"  # 올림
