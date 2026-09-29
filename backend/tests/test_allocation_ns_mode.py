"""자원 집계 namespace 모드 — NS 단위 수집이 cluster 모드와 같은 결과를 내고, 대형 클러스터에서
실사용량을 채우며, NS 실패를 격리하고, 인계 시 완료한 NS 를 이어서 쓰는지.

fixture 는 test_allocation_overview_raw 의 JSON 대역(원본/typed 페이지)을 재사용하고,
`list_namespaced_pod` 와 NS 단위 Pod metrics 를 흉내 낸다.
"""
import copy
import json
from types import SimpleNamespace as NS

import pytest

from tests import test_allocation_overview_raw as base
from app.routers import k8s_allocation as ka
from app.services import k8s_paging
from app.services.k8s_efficiency import collector as col
from app.services.snapshot_jobs import Progress

USAGE = {
    ("ns1", "api-7c9f8d4b6-a"): {"cpu": 40, "mem": 64 * 1024**2, "containers": {}},
    ("ns2", "db-0"): {"cpu": 300, "mem": 1024**3, "containers": {}},
    ("ns3", "bare"): {"cpu": 5, "mem": 1024**2, "containers": {}},
}

NS_CALLS: list[str] = []
FAIL: dict[str, Exception] = {}


class _ApiErr(Exception):
    def __init__(self, status):
        super().__init__(f"({status})")
        self.status = status


class _Core(base._Core):
    def list_namespaced_pod(self, namespace, **kw):
        NS_CALLS.append(namespace)
        if namespace in FAIL:
            raise FAIL[namespace]
        items = [p for p in base.PODS if p["metadata"]["namespace"] == namespace]
        return base._page(copy.deepcopy(items), "PodList", kw)


class _FakeCache:
    """`_RedisStore` 의 get_json/set_json 만 흉내 — JSON 왕복까지 해서 직렬화 문제를 잡는다."""

    def __init__(self):
        self.kv: dict[str, str] = {}

    def get_json(self, key, part):
        raw = self.kv.get(f"{key}:{part}")
        return json.loads(raw) if raw else None

    def set_json(self, key, part, value, ex=None):
        self.kv[f"{key}:{part}"] = json.dumps(value)
        return True


@pytest.fixture
def env(monkeypatch):
    base.CALLS.clear()
    NS_CALLS.clear()
    FAIL.clear()
    cache = _FakeCache()
    monkeypatch.setattr(ka, "_api_client", lambda cluster: object())
    monkeypatch.setattr(ka.k8s_client, "CoreV1Api", _Core)
    monkeypatch.setattr(ka, "_node_usage", lambda client: {"n1": (1200, 3 * 1024**3)})
    monkeypatch.setattr(ka, "_pod_usage", lambda client, namespace=None: {
        k: v for k, v in USAGE.items() if namespace is None or k[0] == namespace})
    monkeypatch.setattr(ka, "_RAW_LIST", True)
    monkeypatch.setattr(ka, "_ns_cache", cache)
    monkeypatch.setattr(k8s_paging, "PAGE_LIMIT", 2)   # NS 안에서도 페이지네이션
    return cache


CLUSTER = NS(id="c-1")


def _norm(ov):
    return json.loads(json.dumps(ov, sort_keys=True, default=list))


def _strip_mode(ov):
    d = _norm(ov)
    for k in ("collect_mode", "failed_namespaces", "resumed_namespaces"):
        d.pop(k, None)
    return d


def test_namespace_mode_matches_cluster_mode(env):
    cl = ka._build_overview(CLUSTER, Progress(), mode="cluster")
    ns = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    assert _strip_mode(ns) == _strip_mode(cl)
    assert ns["collect_mode"] == "namespace" and cl["collect_mode"] == "cluster"
    assert ns["failed_namespaces"] == [] and ns["partial"] is False
    # 모든 NS(파드 없는 NS 포함)를 NS 단위로 조회 — cluster-wide Pod 목록은 쓰지 않는다
    assert sorted(set(NS_CALLS)) == ["empty", "ns1", "ns2", "ns3"]


def test_namespace_mode_fills_usage_where_cluster_mode_skips(env, monkeypatch):
    """대형 클러스터(활성 Pod > K8S_ALLOC_POD_USAGE_MAX)에서 cluster 모드는 실사용량을 생략하지만
    namespace 모드는 NS 단위 metrics 로 채운다 — P1 의 핵심 효과."""
    monkeypatch.setattr(ka, "_POD_USAGE_MAX", 1)
    cl = ka._build_overview(CLUSTER, Progress(), mode="cluster")
    assert cl["metrics_available"] is False and cl["pod_usage_skipped"] is True
    ns = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    assert ns["metrics_available"] is True and ns["pod_usage_skipped"] is False
    assert ns["per_ns"]["ns2"]["uc"] == 300 and ns["per_ns"]["ns2"]["has_usage"] is True
    assert ns["summary"]["cpu_usage_m"] == 345


def test_one_failing_namespace_is_isolated(env):
    FAIL["ns2"] = _ApiErr(403)
    ov = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    assert ov["failed_namespaces"] == ["ns2"] and ov["partial"] is True
    assert "ns2" not in ov["per_ns"]
    assert ov["per_ns"]["ns1"]["pods"] == 3          # api×2 + pend
    assert ov["summary"]["pod_count"] == 5            # 7 활성 − ns2 의 db-0·kata-x


def test_timeout_truncated_namespace_marked_failed(env):
    """첫 페이지 타임아웃은 k8s_paging 이 graceful partial(빈 결과)로 삼키므로, 절단 보고로 그 NS 를
    실패로 표시해야 한다 — 빈 NS 로 조용히 섞이면 안 된다."""
    FAIL["ns3"] = _ApiErr(504)
    ov = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    assert ov["failed_namespaces"] == ["ns3"] and ov["partial"] is True


def test_all_namespaces_failing_raises(env):
    for n in ("ns1", "ns2", "ns3", "empty"):
        FAIL[n] = _ApiErr(403)
    with pytest.raises(_ApiErr):
        ka._build_overview(CLUSTER, Progress(), mode="namespace")


def test_progress_reports_namespace_phases(env):
    class _Log(Progress):
        def __setattr__(self, name, value):
            super().__setattr__(name, value)
            if name == "phase" and value:
                self.__dict__.setdefault("phases", []).append(value)

    prog = _Log()
    ka._build_overview(CLUSTER, prog, mode="namespace")
    assert prog.phases[0] == "nodes"
    assert prog.phases[1] == "ns:0/4" and prog.phases[-1] == "ns:4/4"
    assert prog.processed == len(base.PODS)


def test_resume_reuses_namespaces_collected_by_interrupted_run(env):
    """인계(resume_since) 시 그 이후에 저장된 NS 는 다시 조회하지 않고 결과는 전체 수집과 같다."""
    full = ka._build_overview(CLUSTER, Progress(), mode="namespace")   # 캐시 채움(collected_at 기록)
    assert env.kv, "완료한 NS 누적기가 저장돼야 한다"
    # ns1 은 인계 전 계산이 저장한 것으로 두고, 나머지는 인계 전(오래된) 것으로 만든다
    since = 1_000.0
    for k in list(env.kv):
        d = json.loads(env.kv[k])
        d["collected_at"] = since + 1 if ":ns1:" in k else since - 1
        env.kv[k] = json.dumps(d)
    NS_CALLS.clear()
    prog = Progress(resume_since=since)
    resumed = ka._build_overview(CLUSTER, prog, mode="namespace")
    assert "ns1" not in NS_CALLS and sorted(set(NS_CALLS)) == ["empty", "ns2", "ns3"]
    assert resumed["resumed_namespaces"] == 1
    assert _strip_mode(resumed) == _strip_mode(full)


def test_no_resume_without_takeover(env):
    """일반 새로고침(resume_since 없음)은 저장된 NS 가 있어도 전부 새로 조회한다 — 신선도 보장."""
    ka._build_overview(CLUSTER, Progress(), mode="namespace")
    NS_CALLS.clear()
    ov = ka._build_overview(CLUSTER, Progress(), mode="namespace")
    assert sorted(set(NS_CALLS)) == ["empty", "ns1", "ns2", "ns3"] and ov["resumed_namespaces"] == 0


def test_collector_hook_sees_every_pod_and_skips_cache(env):
    """효율화 수집기(on_pod)는 모든 활성 파드를 봐야 하므로 캐시를 읽지도 쓰지도 않고, 워크로드
    누적이 cluster 모드와 같다(훅은 메인 스레드에서 호출 — 수집기 누적기는 스레드 안전하지 않다)."""
    def run(mode):
        acc = col._WorkloadAcc()
        seen = []

        def hook(p, res, owner):
            seen.append((p.metadata.namespace, p.metadata.name, res, owner))
            acc.add(p, res, owner)

        ka._build_overview(CLUSTER, Progress(resume_since=0.0), on_pod=hook, mode=mode)
        return sorted(seen), acc.wl

    cl_seen, cl_wl = run("cluster")
    env.kv.clear()
    ns_seen, ns_wl = run("namespace")
    assert ns_seen == cl_seen and ns_wl == cl_wl
    assert env.kv == {}


def test_auto_mode_uses_node_count(monkeypatch):
    monkeypatch.setattr(ka, "_COLLECT_MODE", "auto")
    monkeypatch.setattr(ka, "_NS_MODE_MIN_NODES", 50)
    assert ka._use_namespace_mode(None, 376) is True
    assert ka._use_namespace_mode(None, 12) is False
    assert ka._use_namespace_mode("cluster", 376) is False
    monkeypatch.setattr(ka, "_COLLECT_MODE", "namespace")
    assert ka._use_namespace_mode(None, 3) is True
