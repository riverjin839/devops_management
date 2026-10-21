"""14차 감사 D-184(서버)·D-185 — 클러스터 추이 응답.

- 지표 6종 병렬 질의 + 전체 예산(≤25초), 지표별 `error`
- 최상위 `hint`(연동 꺼짐·연결 불가·라벨 불일치) · `max_nodes` · `node_label`
- 노드 라벨 = 클러스터 `trend_node_label`, 비었거나 auto 면 node→kubernetes_node→instance 자동 탐지
- 스키마 검증(라벨 이름 형식)

Prometheus 는 가짜 서비스로 대체한다 (DB·네트워크 불필요).
"""

import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import asyncio
import time
import uuid
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.models.cluster import Cluster
from app.routers import cluster_trends as ct
from app.schemas.cluster import ClusterCreate, ClusterResponse, ClusterUpdate


class FakeProm:
    """label → 시리즈 유무. `delay` 초 동안 질의마다 대기, `status` 로 전체 실패 흉내."""

    base_url = "http://prom.test:9090"

    def __init__(self, label_with_data=None, *, status="ok", delay=0.0, fail_metrics=()):
        self.label_with_data = label_with_data
        self.status = status
        self.delay = delay
        self.fail_metrics = set(fail_metrics)
        self.range_queries: list[str] = []
        self.instant_queries: list[str] = []
        self.inflight = 0
        self.max_inflight = 0

    async def _wait(self):
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
        finally:
            self.inflight -= 1

    async def query(self, promql):
        self.instant_queries.append(promql)
        await self._wait()
        if self.status != "ok":
            return {"status": self.status, "results": None, "labels": None, "error": "down"}
        lab = self.label_with_data
        if lab and f"{lab}=~" in promql:
            return {"status": "ok", "results": [{"labels": {lab: "n1"}, "value": 1}], "labels": {lab: "n1"}}
        return {"status": "ok", "results": [], "labels": None, "value": None}

    async def query_range(self, promql, start, end, step):
        self.range_queries.append(promql)
        await self._wait()
        if self.status != "ok":
            return {"status": self.status, "series": None, "error": "Prometheus is not reachable."}
        for m in self.fail_metrics:
            if m in promql:
                return {"status": "error", "series": None, "error": f"bad query {m}"}
        lab = self.label_with_data
        if lab and f"{lab}=~" in promql:
            return {"status": "ok", "series": [{"labels": {lab: "n1"}, "values": [[1700000000, "1.5"]]}]}
        return {"status": "ok", "series": []}


ALL = "cpu,memory,disk,diskio,network,networkerr"


@pytest.fixture(autouse=True)
def _clear_cache():
    ct._auto_label_cache.clear()
    yield
    ct._auto_label_cache.clear()


def _call(monkeypatch, svc, *, label=None, enabled=True, metrics=ALL, nodes="n1,n2"):
    cluster = SimpleNamespace(id=uuid.uuid4(), prometheus_enabled=enabled, trend_node_label=label)
    monkeypatch.setattr(ct, "_require_cluster", lambda cid, db: cluster)
    monkeypatch.setattr(ct, "_service_for", lambda c: svc if c.prometheus_enabled else None)
    return asyncio.run(ct.cluster_trends(cluster.id, range="1h", metrics=metrics, nodes=nodes, db=None))


def test_disabled_returns_offline_hint_naming_toggle(monkeypatch):
    out = _call(monkeypatch, FakeProm("node"), enabled=False)
    assert out["status"] == "offline"
    assert "prometheus_enabled" in out["hint"] and "클러스터 정보 수정" in out["hint"]
    assert out["max_nodes"] == 30
    assert out["node_label"] == "auto"
    assert out["metrics"] == {}


def test_explicit_label_is_used_and_metrics_have_error_field(monkeypatch):
    svc = FakeProm("kubernetes_node")
    out = _call(monkeypatch, svc, label="kubernetes_node")
    assert out["node_label"] == "kubernetes_node"
    assert svc.instant_queries == []  # 명시 라벨이면 자동 탐지 안 함
    assert set(out["metrics"]) == set(ALL.split(","))
    for m in out["metrics"].values():
        assert m["error"] is None
        assert m["series"][0]["node"] == "n1"
    assert out["hint"] is None and out["status"] == "ok"
    assert all('kubernetes_node=~"n1|n2"' in q for q in svc.range_queries)


@pytest.mark.parametrize("label", ["node", "kubernetes_node", "instance"])
def test_auto_detects_first_label_with_series(monkeypatch, label):
    svc = FakeProm(label)
    out = _call(monkeypatch, svc, label=None)
    assert out["node_label"] == label
    assert out["metrics"]["cpu"]["series"][0]["node"] == "n1"


def test_auto_value_and_priority(monkeypatch):
    """'auto' 도 자동 탐지이고, 여러 후보가 맞으면 node 가 우선."""

    class Both(FakeProm):
        async def query(self, promql):
            self.instant_queries.append(promql)
            return {"status": "ok", "results": [{"labels": {}, "value": 1}], "labels": {}}

    out = _call(monkeypatch, Both("instance"), label="auto")
    assert out["node_label"] == "node"


def test_label_mismatch_hint(monkeypatch):
    out = _call(monkeypatch, FakeProm(None), label=None)
    assert out["status"] == "ok"
    assert "trend_node_label" in out["hint"] and "클러스터 정보 수정" in out["hint"]
    assert out["node_label"] == "instance"  # 아무 후보도 없으면 마지막 후보로 질의

    out = _call(monkeypatch, FakeProm(None), label="hostname")
    assert "'hostname' 라벨이 노드 이름과 맞지 않습니다" in out["hint"]


def test_unreachable_hint(monkeypatch):
    out = _call(monkeypatch, FakeProm("node", status="offline"), label="node")
    assert out["status"] == "offline"
    assert "연결할 수 없습니다" in out["hint"] and "prometheus_url" in out["hint"]
    assert all(m["error"] for m in out["metrics"].values())


def test_partial_failure_is_per_metric(monkeypatch):
    out = _call(monkeypatch, FakeProm("node", fail_metrics=("node_disk_read_bytes_total",)), label="node")
    assert out["metrics"]["diskio"]["error"] == "bad query node_disk_read_bytes_total"
    assert out["metrics"]["diskio"]["series"] == []
    assert out["metrics"]["cpu"]["error"] is None
    assert out["status"] == "error"
    assert out["hint"] is None


def test_metrics_run_in_parallel(monkeypatch):
    svc = FakeProm("node", delay=0.2)
    t0 = time.monotonic()
    _call(monkeypatch, svc, label="node")
    assert svc.max_inflight == 6
    assert time.monotonic() - t0 < 1.0


def test_overall_budget(monkeypatch):
    monkeypatch.setattr(ct, "_TRENDS_BUDGET_SECONDS", 0.3)
    svc = FakeProm("node", delay=5.0)
    t0 = time.monotonic()
    out = _call(monkeypatch, svc, label="node")
    assert time.monotonic() - t0 < 2.0
    assert all("시간 초과" in m["error"] for m in out["metrics"].values())
    assert out["status"] == "error"


def test_max_nodes_cap_reported(monkeypatch):
    monkeypatch.setattr(ct.settings, "trends_max_nodes", 2)
    out = _call(monkeypatch, FakeProm("node"), label="node", nodes="a,b,c")
    assert out["max_nodes"] == 2
    assert out["dropped"] == ["c"]


def test_env_label_is_auto_fallback(monkeypatch):
    monkeypatch.setattr(ct.settings, "prometheus_node_label", "nodename")
    assert ct._auto_candidates() == ["nodename", "node", "kubernetes_node", "instance"]
    monkeypatch.setattr(ct.settings, "prometheus_node_label", "instance")
    assert ct._auto_candidates() == ["node", "kubernetes_node", "instance"]


# ── 스키마 / 모델 ────────────────────────────────────────────────────────

def test_model_has_nullable_column():
    col = Cluster.__table__.c.trend_node_label
    assert col.nullable and col.type.length == 64


@pytest.mark.parametrize("raw,expected", [
    (None, None), ("", None), ("  ", None), ("auto", "auto"), ("AUTO", "auto"),
    ("node", "node"), (" kubernetes_node ", "kubernetes_node"), ("_x9", "_x9"),
])
def test_schema_accepts_label_names(raw, expected):
    assert ClusterUpdate(trend_node_label=raw).trend_node_label == expected
    assert ClusterCreate(name="c", trend_node_label=raw).trend_node_label == expected


@pytest.mark.parametrize("raw", ["9node", "node-name", 'x"}or{', "a" * 65, "node name"])
def test_schema_rejects_invalid_label(raw):
    with pytest.raises(ValidationError):
        ClusterUpdate(trend_node_label=raw)


def test_schema_update_unset_keeps_value():
    assert "trend_node_label" not in ClusterUpdate(name="x").model_dump(exclude_unset=True)
    assert ClusterResponse.model_fields["trend_node_label"].default is None


def test_node_names_with_dash_and_dot_are_valid_promql_strings(monkeypatch):
    # re.escape 결과(`\-`·`\.`)를 그대로 PromQL 큰따옴표 문자열에 넣으면 "unknown escape sequence" 로
    # 질의 전체가 실패한다 — 문자열 안에서는 `\\-` 로 한 번 더 escape 돼야 한다.
    svc = FakeProm("instance")
    _call(monkeypatch, svc, label="instance", nodes="worker-1.example,n2")
    assert svc.range_queries
    for q in svc.range_queries:
        assert r'instance=~"worker\\-1\\.example|n2"' in q
