"""k8s_concurrency — 대상 apiserver 별 동시 호출 상한 (Redis 분산 세마포어 + 로컬 폴백)."""
import os
import threading
import time
import uuid

import pytest

from app.services import k8s_concurrency as kc


def _redis_store():
    """CI(REDIS_URL) 또는 로컬 Redis 가 있으면 실제 Redis 로, 없으면 None."""
    from app.services.snapshot_jobs import _RedisStore
    st = _RedisStore(url=os.getenv("REDIS_URL", "redis://localhost:6379/0"), prefix="k8sslot-test")
    return st if st.available() else None


def _run_concurrently(slots, key, n, hold_s):
    peak = {"now": 0, "max": 0}
    lock = threading.Lock()
    errors = []

    def work():
        try:
            with slots.slot(key, hold=30):
                with lock:
                    peak["now"] += 1
                    peak["max"] = max(peak["max"], peak["now"])
                time.sleep(hold_s)
                with lock:
                    peak["now"] -= 1
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=work) for _ in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    return peak["max"], errors


def test_local_fallback_caps_inflight():
    slots = kc.ClusterSlots(limit=3, wait=5, store=None)
    peak, errors = _run_concurrently(slots, "https://a:6443", 10, 0.05)
    assert errors == [] and peak == 3


def test_local_wait_timeout_raises():
    slots = kc.ClusterSlots(limit=1, wait=0.1, store=None)
    with slots.slot("https://a:6443"):
        with pytest.raises(kc.K8sConcurrencyLimited) as ei:
            with slots.slot("https://a:6443"):
                pass
    assert "동시 호출 상한" in str(ei.value)


def test_keys_are_independent():
    slots = kc.ClusterSlots(limit=1, wait=0.1, store=None)
    with slots.slot("https://a:6443"):
        with slots.slot("https://b:6443"):   # 다른 클러스터는 막히지 않는다
            pass


def test_disabled_when_limit_zero():
    slots = kc.ClusterSlots(limit=0, wait=0.01, store=None)
    peak, errors = _run_concurrently(slots, "https://a:6443", 5, 0.05)
    assert errors == [] and peak == 5


def test_slot_released_on_exception():
    slots = kc.ClusterSlots(limit=1, wait=0.2, store=None)
    with pytest.raises(RuntimeError):
        with slots.slot("k"):
            raise RuntimeError("boom")
    with slots.slot("k"):
        pass


@pytest.fixture
def redis_store():
    st = _redis_store()
    if st is None:
        pytest.skip("Redis 없음")
    return st


def test_redis_caps_across_instances(redis_store):
    """replica 두 개(=ClusterSlots 인스턴스 두 개)가 같은 Redis 를 보면 합산 상한이 지켜진다."""
    key = f"https://c-{uuid.uuid4().hex[:6]}:6443"
    a = kc.ClusterSlots(limit=2, wait=5, store=redis_store)
    b = kc.ClusterSlots(limit=2, wait=5, store=redis_store)
    peak = {"now": 0, "max": 0}
    lock = threading.Lock()

    def work(slots):
        with slots.slot(key, hold=30):
            with lock:
                peak["now"] += 1
                peak["max"] = max(peak["max"], peak["now"])
            time.sleep(0.05)
            with lock:
                peak["now"] -= 1

    ts = [threading.Thread(target=work, args=(a if i % 2 else b,)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    assert peak["max"] == 2
    assert a.inflight(key) == 0


def test_redis_expired_slot_is_reclaimed(redis_store):
    """반납 못 한 슬롯(프로세스 사망)은 만료 시각이 지나면 자동 회수된다."""
    key = f"https://d-{uuid.uuid4().hex[:6]}:6443"
    slots = kc.ClusterSlots(limit=1, wait=3, store=redis_store)
    r = redis_store._c()
    r.zadd(f"k8sslot:{key}", {"dead-token": time.time() + 0.3})   # 죽은 프로세스의 슬롯
    t0 = time.monotonic()
    with slots.slot(key, hold=5):
        pass
    assert 0.2 <= time.monotonic() - t0 < 3


def test_redis_wait_timeout(redis_store):
    key = f"https://e-{uuid.uuid4().hex[:6]}:6443"
    slots = kc.ClusterSlots(limit=1, wait=0.2, store=redis_store)
    with slots.slot(key, hold=30):
        with pytest.raises(kc.K8sConcurrencyLimited):
            with slots.slot(key, hold=30):
                pass


def test_pool_client_requests_take_a_slot(tmp_path, monkeypatch):
    """HardenedApiClient 의 모든 요청이 apiserver host 키로 슬롯을 잡는다."""
    from kubernetes import client as k8s_client

    from app.services import k8s_client_pool as pool

    kc_file = tmp_path / "kc.yaml"
    kc_file.write_text(
        "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: 'https://slot.example:6443'}\n"
        "contexts:\n- name: c\n  context: {cluster: c, user: u}\ncurrent-context: c\n"
        "users:\n- name: u\n  user: {token: t}\n", encoding="utf-8")
    seen = []

    class _Slots:
        from contextlib import contextmanager

        @contextmanager
        def slot(self, key, hold=60.0):
            seen.append((key, hold))
            yield

    monkeypatch.setattr(pool, "cluster_slots", _Slots())
    monkeypatch.setattr(k8s_client.ApiClient, "request", lambda self, m, u, **kw: "ok")
    pool.invalidate()
    c = pool.get_api_client_for_path(str(kc_file))
    assert c.request("GET", "/api/v1/nodes", _request_timeout=(3, 10)) == "ok"
    assert seen == [("https://slot.example:6443", 28.0)]
    pool.invalidate()


def test_paging_treats_limit_as_transient():
    from app.services.k8s_paging import is_timeout_error
    assert is_timeout_error(kc.K8sConcurrencyLimited("x")) is True
