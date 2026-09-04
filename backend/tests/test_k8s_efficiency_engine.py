"""추천 엔진 순수 로직 — target 계산/임계/제외 규칙/정책 병합."""
from types import SimpleNamespace as NS

from app.services.k8s_efficiency import engine
from app.services.k8s_efficiency.settings import POLICY_DEFAULTS, merge_defaults


def test_recommend_target_basic_headroom_and_threshold():
    # p95 100m, headroom 30% → target 130m. current 1000m > 130×1.25 이고 절감 870 ≥ 100 → 추천
    assert engine.recommend_target(1000, 100, headroom_pct=30, floor=50, threshold_ratio=1.25, min_savings=100) == 130
    # current 가 target×threshold 이하이면 추천 없음
    assert engine.recommend_target(160, 100, headroom_pct=30, floor=50, threshold_ratio=1.25, min_savings=10) is None


def test_recommend_target_floor_and_min_savings():
    # p95 가 아주 작아도 floor(50m) 밑으로는 내리지 않는다
    assert engine.recommend_target(1000, 5, headroom_pct=30, floor=50, threshold_ratio=1.25, min_savings=100) == 50
    # 절감이 min_savings 미만이면 추천 없음
    assert engine.recommend_target(200, 100, headroom_pct=30, floor=50, threshold_ratio=1.25, min_savings=100) is None
    # p95 없음 / current 0 → None
    assert engine.recommend_target(1000, None, headroom_pct=30, floor=50, threshold_ratio=1.25, min_savings=1) is None
    assert engine.recommend_target(0, 100, headroom_pct=30, floor=50, threshold_ratio=1.25, min_savings=1) is None


def _sample(ns="app", kind="Deployment", optout=False):
    return NS(namespace=ns, kind=kind, optout=optout)


def test_exclusion_rules():
    pol = merge_defaults({})
    assert engine.exclusion_reason(_sample(ns="kube-system"), pol) == "system_namespace"
    assert engine.exclusion_reason(_sample(optout=True), pol) == "opt_out_annotation"
    assert engine.exclusion_reason(_sample(kind="DaemonSet"), pol) == "daemonset_excluded"
    assert engine.exclusion_reason(_sample(kind="DaemonSet"), {**pol, "include_daemonsets": True}) is None
    assert engine.exclusion_reason(_sample(kind="Job"), pol) == "unsupported_kind"
    assert engine.exclusion_reason(_sample(), pol) is None


def test_merge_policy_ns_override_only_known_keys():
    defaults = merge_defaults({"headroom_pct": 30})
    ns_policy = NS(rightsize_params={"headroom_pct": 50, "bogus": 1, "max_step_pct": None})
    merged = engine.merge_policy(defaults, ns_policy)
    assert merged["headroom_pct"] == 50
    assert "bogus" not in merged
    assert merged["max_step_pct"] == POLICY_DEFAULTS["max_step_pct"]  # None 은 오버라이드 안 함


def test_merge_defaults_quota_nested():
    d = merge_defaults({"quota": {"up_threshold": 0.9}, "automation_enabled": True})
    assert d["quota"]["up_threshold"] == 0.9
    assert d["quota"]["low_threshold"] == POLICY_DEFAULTS["quota"]["low_threshold"]
    assert d["automation_enabled"] is True
