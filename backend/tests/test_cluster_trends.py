"""Unit tests for Cluster Trends helpers (pure logic — no DB/Prometheus needed)."""

import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.routers.cluster_trends import (
    _METRICS,
    _RANGE_MAP,
    _build_promql,
    _to_float,
)


def test_range_map_bounds_datapoints():
    """모든 시간창의 datapoint/series 가 ~340 이하인지 (과수집 방지)."""
    unit_secs = {"s": 1, "m": 60, "h": 3600}
    for rng, (duration, step, _window) in _RANGE_MAP.items():
        step_secs = int(step[:-1]) * unit_secs[step[-1]]
        points = duration / step_secs
        assert points <= 345, f"{rng}: {points} datapoints (step={step}) 너무 많음"


def test_metrics_cover_required_set():
    """요청된 6개 지표가 모두 정의돼 있어야 한다."""
    assert set(_METRICS) == {"cpu", "memory", "disk", "diskio", "network", "networkerr"}


def test_build_promql_substitutes_label_nodes_window():
    template = 'rate(node_cpu_seconds_total{mode="idle",<L>=~"$n"}[$w])'
    out = _build_promql(template, "instance", "node-a|node-b", "2m")
    assert "<L>" not in out and "$n" not in out and "$w" not in out
    assert 'instance=~"node-a|node-b"' in out
    assert "[2m]" in out


def test_build_promql_respects_custom_label():
    _unit, template = _METRICS["memory"]
    out = _build_promql(template, "node", "n1", "4m")
    assert 'node=~"n1"' in out
    assert "instance" not in out


@pytest.mark.parametrize(
    "val,expected",
    [("1.5", 1.5), ("0", 0.0), ("NaN", None), ("", None), (None, None), ("abc", None)],
)
def test_to_float(val, expected):
    assert _to_float(val) == expected
