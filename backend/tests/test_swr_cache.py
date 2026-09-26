"""SWRCache — fresh/stale/miss, single-flight, 세대 무효화(replica 간 포함), 오류 비캐시."""
import threading
import time

import pytest

from app.services.swr_cache import SWRCache


class _FakeStore:
    """replica 간 공유 Redis 흉내 — 두 캐시 인스턴스가 같은 store 를 본다."""

    def __init__(self):
        self.d = {}

    def get_json(self, key, part):
        return self.d.get((key, part))

    def set_json(self, key, part, value, ex=None):
        self.d[(key, part)] = value
        return True


def _counter(value="v"):
    n = {"calls": 0}

    def load():
        n["calls"] += 1
        return f"{value}{n['calls']}"
    return n, load


def test_hit_within_fresh():
    c = SWRCache(fresh=10, stale=20)
    n, load = _counter()
    assert c.get(("c1", "pods"), load)[0] == "v1"
    v, meta = c.get(("c1", "pods"), load)
    assert v == "v1" and meta["cache"] == "hit" and n["calls"] == 1


def test_stale_serves_old_and_refreshes_in_background():
    c = SWRCache(fresh=0.05, stale=10)
    n, load = _counter()
    c.get(("c1", "k"), load)
    time.sleep(0.1)
    v, meta = c.get(("c1", "k"), load)
    assert v == "v1" and meta["cache"] == "stale"          # 기다리지 않고 이전 값
    for _ in range(50):
        if c.get(("c1", "k"), load)[0] == "v2":
            break
        time.sleep(0.02)
    assert c.get(("c1", "k"), load)[0] == "v2" and n["calls"] == 2


def test_expired_beyond_stale_is_a_miss():
    c = SWRCache(fresh=0.01, stale=0.02)
    n, load = _counter()
    c.get(("c1", "k"), load)
    time.sleep(0.05)
    v, meta = c.get(("c1", "k"), load)
    assert v == "v2" and meta["cache"] == "miss"


def test_single_flight_concurrent_misses():
    c = SWRCache(fresh=10, stale=20)
    calls = {"n": 0}
    gate = threading.Event()

    def slow():
        calls["n"] += 1
        gate.wait(2)
        return "x"

    results = []
    threads = [threading.Thread(target=lambda: results.append(c.get(("c1", "k"), slow)[0])) for _ in range(8)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    gate.set()
    for t in threads:
        t.join(2)
    assert results == ["x"] * 8 and calls["n"] == 1        # apiserver 호출 1회


def test_errors_are_not_cached_and_propagate_to_waiters():
    c = SWRCache(fresh=10, stale=20)

    def boom():
        raise RuntimeError("apiserver down")

    with pytest.raises(RuntimeError):
        c.get(("c1", "k"), boom)
    n, load = _counter()
    assert c.get(("c1", "k"), load)[0] == "v1"


def test_refresh_bypasses_cache():
    c = SWRCache(fresh=10, stale=20)
    n, load = _counter()
    c.get(("c1", "k"), load)
    assert c.get(("c1", "k"), load, refresh=True)[0] == "v2"


def test_bump_invalidates_group_only():
    c = SWRCache(fresh=10, stale=20)
    n1, l1 = _counter("a")
    n2, l2 = _counter("b")
    c.get(("c1", "k"), l1)
    c.get(("c2", "k"), l2)
    c.bump("c1")
    assert c.get(("c1", "k"), l1)[0] == "a2"
    assert c.get(("c2", "k"), l2)[0] == "b1"


def test_bump_propagates_across_replicas_via_store():
    store = _FakeStore()
    r1 = SWRCache(fresh=10, stale=20, store=store)
    r2 = SWRCache(fresh=10, stale=20, store=store)
    n, load = _counter()
    r2.get(("c1", "k"), load)                 # replica 2 가 캐시
    time.sleep(0.01)
    r1.bump("c1")                             # replica 1 에서 삭제/스케일
    v, meta = r2.get(("c1", "k"), load)
    assert v == "v2" and meta["cache"] == "miss"


def test_result_loaded_across_a_write_is_not_stored():
    c = SWRCache(fresh=10, stale=20)
    started = threading.Event()
    release = threading.Event()

    def slow():
        started.set()
        release.wait(2)
        return "before-write"

    t = threading.Thread(target=lambda: c.get(("c1", "k"), slow))
    t.start()
    started.wait(2)
    c.bump("c1")                              # 조회 도중 쓰기 발생
    release.set()
    t.join(2)
    n, load = _counter()
    assert c.get(("c1", "k"), load)[0] == "v1"   # 쓰기 이전 결과는 캐시되지 않음


def test_uuid_and_str_group_are_same():
    import uuid
    cid = uuid.uuid4()
    c = SWRCache(fresh=10, stale=20)
    n, load = _counter()
    c.get((cid, "k"), load)
    c.bump(str(cid))
    assert c.get((cid, "k"), load)[0] == "v2"
