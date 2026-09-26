"""/k8s-manage 목록 — 파드 페이지(continue 토큰)·RV=0(watch cache)·오류 매핑·디스패처 지터."""
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from kubernetes.client.rest import ApiException

from app.routers import k8s_resources as kr
from app.services.k8s_concurrency import K8sConcurrencyLimited
from app.services.swr_cache import SWRCache


class _Resp:
    def __init__(self, body):
        self.data = json.dumps(body).encode()

    def release_conn(self):
        pass


def _pod(name, ns="ns-a"):
    return {"metadata": {"name": name, "namespace": ns, "creationTimestamp": "2024-01-01T00:00:00Z"},
            "spec": {"containers": [{"name": "c"}]},
            "status": {"phase": "Running", "containerStatuses": [
                {"name": "c", "ready": True, "restartCount": 0, "image": "i", "imageID": "",
                 "state": {"running": {}}}]}}


@pytest.fixture
def env(monkeypatch):
    calls = []
    pods = [_pod(f"p{i:03d}") for i in range(250)]

    class V1:
        def __init__(self, _c):
            pass

        def list_pod_for_all_namespaces(self, **kw):
            calls.append(("pods", kw))
            if kw.get("_continue") == "expired":
                raise ApiException(status=410, reason="Gone")
            start = int(kw.get("_continue") or 0)
            lim = kw["limit"]
            chunk = pods[start:start + lim]
            nxt = start + lim
            meta = {"continue": str(nxt), "remainingItemCount": len(pods) - nxt} if nxt < len(pods) else {}
            return _Resp({"metadata": meta, "items": chunk})

        def list_event_for_all_namespaces(self, **kw):
            calls.append(("events", kw))
            return _Resp({"metadata": {}, "items": []})

        def list_node(self, **kw):
            calls.append(("nodes", kw))
            return _Resp({"metadata": {}, "items": []})

    class CO:
        def __init__(self, _c):
            pass

        def list_cluster_custom_object(self, *a, **kw):
            calls.append(("metrics", kw))
            return {"items": []}

    monkeypatch.setattr(kr.k8s_client, "CoreV1Api", V1)
    monkeypatch.setattr(kr.k8s_client, "CustomObjectsApi", CO)
    monkeypatch.setattr(kr, "_list_cache", SWRCache(fresh=30, stale=60))
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda cluster: object())
    return SimpleNamespace(calls=calls)


def test_pods_pages_follow_continue_token(env):
    cid = uuid.uuid4()
    p1 = kr.list_pods_rich(cid, limit=100, cont=None, db=None)
    assert p1["count"] == 100 and p1["continue_token"] == "100" and p1["remaining_count"] == 150
    p2 = kr.list_pods_rich(cid, limit=100, cont=p1["continue_token"], db=None)
    p3 = kr.list_pods_rich(cid, limit=100, cont=p2["continue_token"], db=None)
    assert p3["count"] == 50 and p3["continue_token"] is None and p3["truncated"] is False
    names = [r.name for pg in (p1, p2, p3) for r in pg["items"]]
    assert names == [f"p{i:03d}" for i in range(250)]            # 누락·중복 없음
    # usage/Warning 맵은 페이지마다 다시 받지 않는다(캐시 공유)
    assert sum(1 for k, _ in env.calls if k == "metrics") == 1
    assert sum(1 for k, _ in env.calls if k == "events") == 1


def test_pod_page_size_is_clamped(env):
    cid = uuid.uuid4()
    kr.list_pods_rich(cid, limit=5, cont=None, db=None)
    kr.list_pods_rich(cid, limit=99999, cont=None, db=None)
    limits = [kw["limit"] for k, kw in env.calls if k == "pods"]
    assert limits == [kr._POD_PAGE_MIN, kr._LIST_LIMIT]


def test_no_limit_keeps_legacy_single_shot(env):
    out = kr.list_pods_rich(uuid.uuid4(), limit=None, cont=None, db=None)
    assert out["count"] == 250 and out["continue_token"] is None
    assert [kw["limit"] for k, kw in env.calls if k == "pods"] == [kr._LIST_LIMIT]


def test_expired_continue_token_is_410(env):
    with pytest.raises(HTTPException) as ei:
        kr.list_pods_rich(uuid.uuid4(), limit=100, cont="expired", db=None)
    assert ei.value.status_code == 410


def test_nodes_rich_reads_watch_cache(env):
    kr.list_nodes_rich(uuid.uuid4(), db=None)
    kw = [kw for k, kw in env.calls if k == "nodes"][0]
    assert kw["resource_version"] == "0"


def test_small_cluster_scoped_kinds_use_rv0_but_pods_do_not(monkeypatch):
    seen = {}

    def spec_for(kind):
        def list_all(_a, **kw):
            seen[kind] = kw
            return _Resp({"metadata": {}, "items": []})
        return {"api": lambda c: c, "list_all": list_all, "summary": lambda o: ""}

    monkeypatch.setattr(kr, "KIND_MAP", {k: spec_for(k) for k in ("namespaces", "storageclasses", "pods", "secrets")})
    monkeypatch.setattr(kr, "_list_cache", SWRCache(fresh=30, stale=60))
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda cluster: object())
    for k in ("namespaces", "storageclasses", "pods", "secrets"):
        kr.list_resources(uuid.uuid4(), k, db=None)
    assert seen["namespaces"].get("resource_version") == "0"
    assert seen["storageclasses"].get("resource_version") == "0"
    assert "resource_version" not in seen["pods"]      # RV=0 은 limit 무시 → 대형 목록엔 금지
    assert "resource_version" not in seen["secrets"]
    assert kr._WATCH_CACHE_KINDS.isdisjoint({"pods", "secrets", "configmaps", "events", "replicasets"})


def test_concurrency_limited_maps_to_503():
    e = kr._list_http_error("pods", K8sConcurrencyLimited("상한"))
    assert e.status_code == 503
    assert kr._list_http_error("pods", TimeoutError("read timed out")).status_code == 504
    assert kr._list_http_error("pods", RuntimeError("boom")).status_code == 502


def test_dispatch_jitter_env(monkeypatch):
    from app import celery_app as ca
    monkeypatch.setenv("K8S_DISPATCH_JITTER_SECONDS", "0")
    assert ca._dispatch_jitter() == 0.0
    monkeypatch.setenv("K8S_DISPATCH_JITTER_SECONDS", "5")
    assert all(0 <= ca._dispatch_jitter() <= 5 for _ in range(50))
