"""k8s_list_cache — 쓰기 시 목록 캐시 자동 무효화 · 객체 이벤트 캐시 · kubectl 쓰기 무효화."""
import asyncio
import json
import subprocess as sp
import uuid
from types import SimpleNamespace

import pytest
from kubernetes import client as k8s_client

from app.services import k8s_client_pool as pool
from app.services import k8s_list_cache as lc
from app.services.swr_cache import SWRCache

_KUBECONFIG = """apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {server: 'https://lc.example:6443'}
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
users:
- name: u
  user: {token: t}
"""
HOST = "https://lc.example:6443"


@pytest.fixture
def fresh_cache(monkeypatch):
    cache = SWRCache(fresh=60, stale=120)
    monkeypatch.setattr(lc, "list_cache", cache)
    return cache


@pytest.fixture
def kc(tmp_path):
    p = tmp_path / "kc.yaml"
    p.write_text(_KUBECONFIG, encoding="utf-8")
    pool.invalidate()
    yield str(p)
    pool.invalidate()


def _counter():
    n = {"calls": 0}

    def load():
        n["calls"] += 1
        return n["calls"]
    return n, load


@pytest.mark.parametrize("method,url,expected", [
    ("GET", "/api/v1/pods", False),
    ("POST", "/api/v1/namespaces/a/pods", True),
    ("PATCH", "/apis/apps/v1/namespaces/a/deployments/x?fieldManager=pep", True),
    ("PUT", "/api/v1/nodes/n1", True),
    ("DELETE", "/apis/batch/v1/namespaces/a/jobs/j", True),
    ("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", False),
    ("POST", "/apis/authorization.k8s.io/v1/subjectaccessreviews", False),
    ("POST", "/api/v1/namespaces/a/serviceaccounts/sa/token", False),
    ("POST", "/api/v1/namespaces/a/pods/p/eviction", True),     # drain — 목록이 바뀐다
])
def test_is_mutating(method, url, expected):
    assert lc.is_mutating(method, url) is expected


def test_cache_group_prefers_apiserver_host():
    assert lc.cache_group(SimpleNamespace(configuration=SimpleNamespace(host=HOST)), "cid") == HOST
    assert lc.cache_group(object(), "cid") == "cid"


def test_pool_write_invalidates_list_cache(kc, fresh_cache, monkeypatch):
    """효율화 적용·노드 라벨 편집처럼 탐색기 밖에서 일어난 쓰기도 목록 캐시를 무효화한다."""
    monkeypatch.setattr(k8s_client.ApiClient, "request", lambda self, m, u, **kw: "ok")
    c = pool.get_api_client_for_path(kc)
    n, load = _counter()
    fresh_cache.get((HOST, "list", "deployments", ""), load)

    c.request("GET", "/apis/apps/v1/deployments")                    # 읽기는 무효화 안 함
    assert fresh_cache.get((HOST, "list", "deployments", ""), load)[1]["cache"] == "hit"

    c.request("PATCH", "/apis/apps/v1/namespaces/a/deployments/x")   # 쓰기 → 무효화
    v, meta = fresh_cache.get((HOST, "list", "deployments", ""), load)
    assert meta["cache"] == "miss" and n["calls"] == 2


def test_failed_write_still_invalidates(kc, fresh_cache, monkeypatch):
    """타임아웃 난 쓰기도 서버엔 반영됐을 수 있다 → 실패해도 무효화."""
    def boom(self, m, u, **kw):
        raise TimeoutError("read timed out")

    monkeypatch.setattr(k8s_client.ApiClient, "request", boom)
    c = pool.get_api_client_for_path(kc)
    n, load = _counter()
    fresh_cache.get((HOST, "list", "pods", ""), load)
    with pytest.raises(TimeoutError):
        c.request("DELETE", "/api/v1/namespaces/a/pods/p")
    assert fresh_cache.get((HOST, "list", "pods", ""), load)[1]["cache"] == "miss"


def test_review_post_does_not_invalidate(kc, fresh_cache, monkeypatch):
    monkeypatch.setattr(k8s_client.ApiClient, "request", lambda self, m, u, **kw: "ok")
    c = pool.get_api_client_for_path(kc)
    n, load = _counter()
    fresh_cache.get((HOST, "list", "pods", ""), load)
    c.request("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews")
    assert fresh_cache.get((HOST, "list", "pods", ""), load)[1]["cache"] == "hit"


def test_invalidate_kubeconfig_resolves_host(kc, fresh_cache):
    n, load = _counter()
    fresh_cache.get((HOST, "list", "jobs", ""), load)
    lc.invalidate_kubeconfig(kc)
    assert fresh_cache.get((HOST, "list", "jobs", ""), load)[1]["cache"] == "miss"
    lc.invalidate_kubeconfig(None)            # 없으면 조용히 무시
    lc.invalidate_kubeconfig("/no/such/file")  # 실패도 삼킨다


# ── 객체 이벤트(상세 drawer) ─────────────────────────────────────────────────────
class _Resp:
    def __init__(self, body):
        self.data = json.dumps(body).encode()

    def release_conn(self):
        pass


def test_object_events_cached_and_invalidated(monkeypatch):
    from app.routers import k8s_resources as kr

    calls = []

    class V1:
        def __init__(self, _c):
            pass

        def list_namespaced_event(self, ns, **kw):
            calls.append((ns, kw["field_selector"]))
            return _Resp({"metadata": {}, "items": [
                {"metadata": {"name": "e1"}, "type": "Warning", "reason": "BackOff", "message": "m",
                 "count": 3, "source": {"component": "kubelet"},
                 "firstTimestamp": "2024-01-01T00:00:00Z", "lastTimestamp": "2024-01-01T00:05:00Z"},
            ]})

    cache = SWRCache(fresh=60, stale=120)
    monkeypatch.setattr(kr, "_list_cache", cache)
    monkeypatch.setattr(kr.k8s_client, "CoreV1Api", V1)
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda cluster: object())
    cid = uuid.uuid4()

    a = kr.get_resource_events(cid, "pods", "ns-a", "p1", db=None)
    b = kr.get_resource_events(cid, "pods", "ns-a", "p1", db=None)   # 다른 사용자/탭의 폴링
    assert len(calls) == 1 and b["cache"] == "hit"
    assert a["items"][0] == {
        "type": "Warning", "reason": "BackOff", "message": "m", "count": 3, "source": "kubelet",
        "first_timestamp": "2024-01-01T00:00:00+00:00", "last_timestamp": "2024-01-01T00:05:00+00:00",
    }
    assert calls[0] == ("ns-a", "involvedObject.name=p1,involvedObject.kind=Pod")

    kr.get_resource_events(cid, "pods", "ns-a", "p1", refresh=True, db=None)
    assert len(calls) == 2

    cache.bump(str(cid))                       # 쓰기(재시작 등) 후 → 새로 조회
    kr.get_resource_events(cid, "pods", "ns-a", "p1", db=None)
    assert len(calls) == 3


def test_kubectl_job_delete_invalidates(monkeypatch):
    """배치잡의 kubectl delete job(풀 우회 쓰기)도 목록 캐시를 무효화한다."""
    from app.services.batch_jobs import ExecutionContext, get_executor
    from app.services.batch_jobs import k8s_job_cleanup as mod

    job = {"metadata": {"name": "old", "namespace": "ns-a", "creationTimestamp": "2020-01-01T00:00:00Z"},
           "status": {"completionTime": "2020-01-01T00:00:00Z",
                      "conditions": [{"type": "Complete", "status": "True",
                                      "lastTransitionTime": "2020-01-01T00:00:00Z"}]}}

    def fake_kubectl(args, timeout, cancel_token=None):
        if "delete" in args:
            return sp.CompletedProcess(["kubectl", *args], 0, 'job.batch "old" deleted', "")
        return sp.CompletedProcess(["kubectl", *args], 0, json.dumps({"items": [job]}), "")

    seen = []
    monkeypatch.setattr(mod, "_run_kubectl", fake_kubectl)
    monkeypatch.setattr(mod, "invalidate_kubeconfig", lambda p: seen.append(p))
    ex = get_executor("k8s_job_cleanup")
    ctx = ExecutionContext(params={"dry_run": False, "delete_succeeded": True}, timeout=5,
                           kubeconfig_path="/tmp/kc.yaml")
    r = asyncio.run(ex.run(ctx))
    assert r.status == "ok", (r.status, r.error)
    assert seen == ["/tmp/kc.yaml"]
