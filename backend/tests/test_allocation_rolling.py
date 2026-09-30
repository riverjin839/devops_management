"""자원 집계 NS 롤링 갱신(P2) — Celery 가 오래된 NS 부터 다시 모아 캐시를 유지하고, 전 NS 가 모이면
개요 스냅샷을 게시하며, 웹 새로고침은 재사용 창 이내 NS 를 다시 조회하지 않는지.

fixture 는 test_allocation_ns_mode 의 fake(NS 단위 Pod 목록·metrics, JSON 왕복 캐시)를 재사용한다.
"""
import json

import pytest

from tests import test_allocation_ns_mode as nsm
from tests import test_allocation_overview_raw as base
from app.routers import k8s_allocation as ka
from app.services import k8s_alloc_rolling as rolling
from app.services.snapshot_jobs import Progress

env = nsm.env   # fixture 재사용
CLUSTER = nsm.CLUSTER
ALL_NS = ["empty", "ns1", "ns2", "ns3"]


@pytest.fixture
def published(monkeypatch):
    """게시된 스냅샷 캡처 + 롤링은 namespace 모드 클러스터만 대상이라 모드를 강제한다."""
    monkeypatch.setattr(ka, "_COLLECT_MODE", "namespace")
    got: list = []
    monkeypatch.setattr(ka, "warm_overview_snapshot",
                        lambda cid, ov, processed=None: got.append((cid, ov, processed)))
    return got


def _set_age(cache, ns, collected_at):
    k = f"c-1:{ns}:acc"
    d = json.loads(cache.kv[k])
    d["collected_at"] = collected_at
    cache.kv[k] = json.dumps(d)


def test_rolling_fills_cache_and_publishes_same_overview(env, published):
    full = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    env.kv.clear()
    nsm.NS_CALLS.clear()
    out = rolling.refresh_cluster(CLUSTER, budget_s=60, min_age_s=60)
    assert out["refreshed"] == 4 and out["missing"] == 0 and out["published"] is True
    assert sorted(set(nsm.NS_CALLS)) == ALL_NS
    (cid, ov, processed), = published
    assert cid == "c-1" and processed == len(base.PODS)
    assert ov["rolling"] is True and ov["ns_oldest_at"] and ov["partial"] is False
    assert nsm._strip_mode(ov) == nsm._strip_mode(full)


def test_rolling_refreshes_only_stale_namespaces_oldest_first(env, published, monkeypatch):
    rolling.refresh_cluster(CLUSTER, budget_s=60, min_age_s=60)
    import time
    now = time.time()
    _set_age(env, "ns2", now - 500)      # 가장 오래됨
    _set_age(env, "ns3", now - 200)
    monkeypatch.setattr(ka, "_NS_WORKERS", 1)   # 순서를 관찰하려고 직렬
    nsm.NS_CALLS.clear()
    out = rolling.refresh_cluster(CLUSTER, budget_s=60, min_age_s=60)
    assert out["due"] == 2 and out["refreshed"] == 2
    assert [n for i, n in enumerate(nsm.NS_CALLS) if n not in nsm.NS_CALLS[:i]] == ["ns2", "ns3"]


def test_rolling_budget_stops_new_namespaces(env, published):
    out = rolling.refresh_cluster(CLUSTER, budget_s=0, min_age_s=60)
    # 예산 0 — 새 NS 를 시작하지 않으므로 캐시가 비어 있으면 게시하지 않는다(부분 개요 게시 금지)
    assert out["refreshed"] == 0 and out["missing"] == 4 and out["published"] is False
    assert published == []


def test_rolling_failure_keeps_previous_namespace_value(env, published):
    rolling.refresh_cluster(CLUSTER, budget_s=60, min_age_s=60)
    before = published[-1][1]
    for n in ALL_NS:
        _set_age(env, n, 0.0)
    nsm.FAIL["ns2"] = nsm._ApiErr(403)
    out = rolling.refresh_cluster(CLUSTER, budget_s=60, min_age_s=60)
    assert out["failed"] == ["ns2"] and out["published"] is True
    after = published[-1][1]
    assert after["per_ns"]["ns2"] == before["per_ns"]["ns2"]   # 직전 누적기 유지
    assert after["ns_oldest_at"] == 0.0                          # 오래된 NS 가 나이로 드러난다


def test_rolling_skips_small_cluster(env, published, monkeypatch):
    monkeypatch.setattr(ka, "_COLLECT_MODE", "auto")
    monkeypatch.setattr(ka, "_NS_MODE_MIN_NODES", 50)
    out = rolling.refresh_cluster(CLUSTER, budget_s=60, min_age_s=60)
    assert out == {"skipped": "cluster_mode", "nodes": 2} and published == []


def test_compose_drops_departed_nodes(env):
    rolling_entries = {}
    ka._build_overview(CLUSTER, Progress(), mode="namespace")
    for n in ALL_NS:
        rolling_entries[n] = json.loads(env.kv[f"c-1:{n}:acc"])
    ov, _ = ka.compose_overview_from_entries(ALL_NS, rolling_entries, {}, {})
    assert ov["per_node"] == {} and ov["summary"]["pod_count"] > 0


def test_web_refresh_reuses_recent_namespaces_when_rolling(env, monkeypatch):
    monkeypatch.setattr(ka, "_ROLLING_MODE", "viewed")
    monkeypatch.setattr(ka, "_NS_REUSE_MAX_AGE", 300.0)
    full = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    import time
    _set_age(env, "ns3", time.time() - 1000)   # 재사용 창 밖
    nsm.NS_CALLS.clear()
    ov = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    assert sorted(set(nsm.NS_CALLS)) == ["ns3"] and ov["resumed_namespaces"] == 3
    assert ov["rolling"] is True
    assert nsm._strip_mode(ov) == nsm._strip_mode(full)


def test_viewed_marker(env, monkeypatch):
    monkeypatch.setattr(ka, "_ROLLING_MODE", "viewed")
    assert ka.recently_viewed("c-9") is False
    ka.mark_viewed("c-9")
    assert ka.recently_viewed("c-9") is True
