"""/k8s/{id}/kind-availability — limit=1 프로브 · 예산 준수 · 캐시 (클러스터 연결 없이)."""
import time
import uuid
from types import SimpleNamespace

import pytest
from kubernetes.client.rest import ApiException

from app.routers import k8s_resources as kr


def _resp(n_items: int, cont: bool = False, remaining=None):
    return SimpleNamespace(
        items=[object()] * n_items,
        metadata=SimpleNamespace(_continue="tok" if cont else None, remaining_item_count=remaining),
    )


class _MemStore:
    def __init__(self):
        self.data = {}
        self.ttl = {}

    def get_json(self, key, part):
        return self.data.get((key, part))

    def set_json(self, key, part, value, ex=None):
        self.data[(key, part)] = value
        self.ttl[(key, part)] = ex
        return True


@pytest.fixture
def env(monkeypatch):
    calls: list[tuple[str, dict]] = []

    def spec(kind, fn):
        def list_all(_api, **kw):
            calls.append((kind, kw))
            return fn()
        return {"api": lambda c: c, "list_all": list_all}

    def forbidden():
        raise ApiException(status=404)

    kinds = {
        "pods": spec("pods", lambda: _resp(1, cont=True, remaining=4999)),
        "secrets": spec("secrets", lambda: _resp(1, cont=True, remaining=None)),
        "leases": spec("leases", lambda: _resp(0)),
        "validatingadmissionpolicies": spec("validatingadmissionpolicies", forbidden),
    }
    store = _MemStore()
    monkeypatch.setattr(kr, "KIND_MAP", kinds)
    monkeypatch.setattr(kr, "_avail_store", store)
    monkeypatch.setattr(kr, "_avail_mem", {})
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda cluster: object())
    return SimpleNamespace(calls=calls, kinds=kinds, store=store)


def test_probes_use_limit_1_with_timeout(env):
    out = kr.kind_availability(uuid.uuid4(), db=None)["kinds"]
    assert {kw["limit"] for _, kw in env.calls} == {1}
    assert all("_request_timeout" in kw for _, kw in env.calls)
    # remainingItemCount 로 정확한 개수, 없으면 None(배지 숨김) — "1+" 같은 오표시 없음
    assert out["pods"] == {"available": True, "present": True, "count": 5000, "truncated": False}
    assert out["secrets"]["present"] is True and out["secrets"]["count"] is None
    assert out["leases"] == {"available": True, "present": False, "count": 0, "truncated": False}
    assert out["validatingadmissionpolicies"]["available"] is False


def test_result_is_cached_until_refresh(env):
    cid = uuid.uuid4()
    kr.kind_availability(cid, db=None)
    n = len(env.calls)
    kr.kind_availability(cid, db=None)
    assert len(env.calls) == n                  # 캐시 적중 — apiserver 재호출 없음
    kr.kind_availability(cid, refresh=True, db=None)
    assert len(env.calls) == 2 * n
    # secrets 개수를 모르는(부분) 결과라 짧은 TTL
    assert env.store.ttl[(str(cid), "result")] == kr._AVAIL_PARTIAL_TTL


def test_all_unknown_result_is_not_cached(env, monkeypatch):
    def boom():
        raise TimeoutError("read timed out")

    for k in list(env.kinds):
        env.kinds[k]["list_all"] = lambda _a, **kw: boom()
    cid = uuid.uuid4()
    out = kr.kind_availability(cid, db=None)["kinds"]
    assert all(v["count"] is None and v["present"] for v in out.values())
    assert (str(cid), "result") not in env.store.data


def test_budget_is_enforced_without_waiting_for_slow_probes(env, monkeypatch):
    monkeypatch.setattr(kr, "_AVAIL_BUDGET", 0.3)
    env.kinds["pods"]["list_all"] = lambda _a, **kw: (time.sleep(3), _resp(1))[1]
    t0 = time.monotonic()
    out = kr.kind_availability(uuid.uuid4(), db=None)["kinds"]
    elapsed = time.monotonic() - t0
    assert elapsed < 1.5, elapsed               # 느린 프로브(3s)를 기다리지 않는다
    assert out["pods"] == {"available": True, "present": True, "count": None, "truncated": False}
    assert out["leases"]["present"] is False
