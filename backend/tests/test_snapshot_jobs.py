"""SnapshotManager 단위 테스트 — 감사에서 발견된 버그의 회귀 방지.

메모리 모드 테스트는 backend="memory" 를 명시한다 — 기본값 auto 는 CI 처럼 Redis 가 떠 있으면
공유 스토어를 잡아 테스트 간 키("k")가 새어 나가 서로의 상태를 본다(로컬은 Redis 가 없어 폴백).

- 부분(절단) 결과는 완전 결과보다 짧은 TTL 로 만료되어 자동 재집계된다(BE-2).
- computing 이 stuck_timeout 을 넘기면 새 계산으로 교체된다(BE-3, refresh 무력화 방지).
- 정상 케이스(짧은 시간 내 완료, force 없는 재사용)는 기존 동작을 유지한다.
"""
import threading
import time

from app.services.snapshot_jobs import Progress, SnapshotManager


def _instant_builder(result):
    def _b(progress: Progress):
        progress.processed = 1
        return result
    return _b


def test_ready_result_is_cached_within_ttl():
    mgr = SnapshotManager(backend="memory", ttl=60.0)
    calls = {"n": 0}

    def builder(progress):
        calls["n"] += 1
        return {"partial": False, "v": calls["n"]}

    v1 = mgr.get("k", builder, initial_wait=1.0)
    assert v1["status"] == "ready" and v1["data"]["v"] == 1
    v2 = mgr.get("k", builder, initial_wait=1.0)
    assert v2["data"]["v"] == 1, "TTL 내 재사용 — 빌더가 다시 호출되면 안 됨"
    assert calls["n"] == 1


def test_force_ignores_ttl_and_rebuilds():
    mgr = SnapshotManager(backend="memory", ttl=60.0)
    calls = {"n": 0}

    def builder(progress):
        calls["n"] += 1
        return {"partial": False, "v": calls["n"]}

    mgr.get("k", builder, initial_wait=1.0)
    v2 = mgr.get("k", builder, initial_wait=1.0, force=True)
    assert v2["data"]["v"] == 2
    assert calls["n"] == 2


def test_partial_result_uses_shorter_ttl():
    """절단된(partial=True) 스냅샷은 partial_ttl 이 지나면 만료되어 재집계돼야 한다 —
    안 그러면 부분 데이터가 완전한 결과인 것처럼 ttl(예: 24h) 내내 서빙된다(BE-2)."""
    mgr = SnapshotManager(backend="memory", ttl=60.0, partial_ttl=0.01)
    calls = {"n": 0}

    def builder(progress):
        calls["n"] += 1
        return {"partial": True, "v": calls["n"]}

    v1 = mgr.get("k", builder, initial_wait=1.0)
    assert v1["data"]["v"] == 1
    time.sleep(0.05)  # partial_ttl(0.01s) 경과, 완전 ttl(60s)은 아직
    v2 = mgr.get("k", builder, initial_wait=1.0)
    assert v2["data"]["v"] == 2, "partial 결과는 partial_ttl 경과 후 재계산돼야 함"
    assert calls["n"] == 2


def test_complete_result_not_affected_by_partial_ttl():
    """partial=False 결과는 짧은 partial_ttl 의 영향을 받지 않고 일반 ttl 을 따른다."""
    mgr = SnapshotManager(backend="memory", ttl=60.0, partial_ttl=0.01)
    calls = {"n": 0}

    def builder(progress):
        calls["n"] += 1
        return {"partial": False, "v": calls["n"]}

    mgr.get("k", builder, initial_wait=1.0)
    time.sleep(0.05)
    v2 = mgr.get("k", builder, initial_wait=1.0)
    assert v2["data"]["v"] == 1, "완전 결과는 partial_ttl 로 조기 만료되면 안 됨"
    assert calls["n"] == 1


def test_stuck_computing_job_is_replaced_after_stuck_timeout():
    """빌더가 영원히 안 끝나면(행업) 기존에는 force 조차 무력했다 — stuck_timeout 이 지나면
    새 계산으로 교체돼야 refresh 로 복구 가능하다(BE-3)."""
    mgr = SnapshotManager(backend="memory", ttl=60.0, stuck_timeout=0.05)
    started = threading.Event()
    release = threading.Event()

    def hung_builder(progress):
        started.set()
        release.wait(timeout=5)  # 첫 호출은 블로킹(행업 시뮬레이션)
        return {"partial": False, "v": "first"}

    v1 = mgr.get("k", hung_builder, initial_wait=0.01)
    assert v1["status"] == "computing"
    started.wait(timeout=2)
    time.sleep(0.1)  # stuck_timeout(0.05s) 경과

    def quick_builder(progress):
        return {"partial": False, "v": "second"}

    v2 = mgr.get("k", quick_builder, initial_wait=1.0)
    assert v2["status"] == "ready" and v2["data"]["v"] == "second", (
        "stuck_timeout 초과 후에는 새 빌더로 교체되어 완료돼야 함"
    )
    release.set()


def test_computing_within_stuck_timeout_is_not_replaced():
    """stuck_timeout 이내면 기존 동작(중복 작업 방지)을 유지 — 진행 중인 계산을 재시작하지 않는다."""
    mgr = SnapshotManager(backend="memory", ttl=60.0, stuck_timeout=10.0)
    started = threading.Event()
    release = threading.Event()
    calls = {"n": 0}

    def hung_builder(progress):
        calls["n"] += 1
        started.set()
        release.wait(timeout=5)
        return {"partial": False, "v": calls["n"]}

    mgr.get("k", hung_builder, initial_wait=0.01)
    started.wait(timeout=2)
    v2 = mgr.get("k", hung_builder, initial_wait=0.01)
    assert v2["status"] == "computing"
    assert calls["n"] == 1, "stuck_timeout 이내에는 빌더가 재호출되면 안 됨"
    release.set()


# ── Redis 공유 스토어 (멀티 replica) ────────────────────────────────────────────
from app.services.snapshot_jobs import _RedisStore  # noqa: E402


class FakeRedis:
    """redis-py 의 최소 하위집합(get/set nx ex/delete/ping) — dict 기반, 만료는 timestamp 로 흉내."""

    def __init__(self):
        self.kv: dict[str, tuple[bytes, float | None]] = {}
        self.fail = False

    def _alive(self, k):
        v = self.kv.get(k)
        if v is None:
            return None
        if v[1] is not None and time.time() >= v[1]:
            del self.kv[k]
            return None
        return v[0]

    def ping(self):
        if self.fail:
            raise ConnectionError("down")
        return True

    def get(self, k):
        if self.fail:
            raise ConnectionError("down")
        return self._alive(k)

    def set(self, k, v, nx=False, ex=None):
        if self.fail:
            raise ConnectionError("down")
        if nx and self._alive(k) is not None:
            return None
        self.kv[k] = (v.encode() if isinstance(v, str) else v, (time.time() + ex) if ex else None)
        return True

    def delete(self, *ks):
        if self.fail:
            raise ConnectionError("down")
        for k in ks:
            self.kv.pop(k, None)


def _shared_pair(fake: FakeRedis, **kw):
    """같은 fake Redis 를 공유하는 두 매니저(= 두 backend replica)."""
    a = SnapshotManager(ttl=60.0, store=_RedisStore(client=fake), **kw)
    b = SnapshotManager(ttl=60.0, store=_RedisStore(client=fake), **kw)
    return a, b


def test_shared_store_single_builder_across_replicas():
    fake = FakeRedis()
    a, b = _shared_pair(fake)
    calls = {"n": 0}
    started = threading.Event()
    release = threading.Event()

    def builder(progress):
        calls["n"] += 1
        progress.processed = 5
        started.set()
        release.wait(timeout=5)
        return {"partial": False, "v": "x", "node_usage": {"n1": (1000, 2048)}}

    v1 = a.get("k", builder, initial_wait=0.01)
    assert v1["status"] == "computing"
    started.wait(timeout=2)
    # 두 번째 replica 는 락을 못 잡으므로 빌더를 돌리지 않고 진행 상황만 본다
    v2 = b.get("k", builder, initial_wait=0.01)
    assert v2["status"] == "computing" and calls["n"] == 1
    release.set()
    time.sleep(0.1)
    v3 = b.get("k", builder, initial_wait=0.01)
    assert v3["status"] == "ready" and v3["data"]["v"] == "x"
    # tuple 은 JSON 왕복 후 list 가 된다 — 소비처(u[0]/u[1] 인덱싱)는 그대로 동작
    assert v3["data"]["node_usage"]["n1"] == [1000, 2048]
    assert calls["n"] == 1
    assert fake.get("snap:k:lock") is None, "완료 시 락 해제"


def test_shared_store_partial_progress_visible_to_other_replica():
    fake = FakeRedis()
    a, b = _shared_pair(fake, publish_interval=0.0)
    started = threading.Event()
    release = threading.Event()

    def builder(progress):
        progress.total = 10
        progress.processed = 3
        progress.partial = {"partial": True, "v": "part"}
        started.set()
        release.wait(timeout=5)
        return {"partial": False, "v": "done"}

    a.get("k", builder, initial_wait=0.01)
    started.wait(timeout=2)
    v = b.get("k", builder, initial_wait=0.01)
    assert v["status"] == "computing" and v["partial"] is True and v["data"]["v"] == "part"
    assert v["processed"] == 3 and v["total"] == 10
    release.set()


def test_shared_store_stuck_lock_is_replaced():
    fake = FakeRedis()
    a, b = _shared_pair(fake, stuck_timeout=0.05)
    started = threading.Event()
    release = threading.Event()

    def hung(progress):
        started.set()
        release.wait(timeout=5)
        return {"partial": False, "v": "first"}

    a.get("k", hung, initial_wait=0.01)
    started.wait(timeout=2)
    time.sleep(0.1)
    v = b.get("k", lambda p: {"partial": False, "v": "second"}, initial_wait=1.0)
    assert v["status"] == "ready" and v["data"]["v"] == "second"
    release.set()


def test_shared_store_falls_back_to_memory_when_redis_down():
    fake = FakeRedis()
    fake.fail = True
    mgr = SnapshotManager(ttl=60.0, store=_RedisStore(client=fake))
    assert mgr.is_shared is False
    v = mgr.get("k", _instant_builder({"partial": False, "v": 1}), initial_wait=1.0)
    assert v["status"] == "ready" and v["data"]["v"] == 1


def test_put_warms_shared_snapshot():
    fake = FakeRedis()
    a, b = _shared_pair(fake)
    a.put("k", {"partial": False, "v": "warm"}, processed=42)
    calls = {"n": 0}

    def builder(progress):
        calls["n"] += 1
        return {"partial": False, "v": "built"}

    v = b.get("k", builder, initial_wait=1.0)
    assert v["status"] == "ready" and v["data"]["v"] == "warm" and v["processed"] == 42
    assert calls["n"] == 0, "워밍된 스냅샷이 신선하면 재집계하지 않는다"


def test_memory_backend_ignores_store():
    mgr = SnapshotManager(backend="memory", ttl=60.0)
    assert mgr.is_shared is False
    v = mgr.get("k", _instant_builder({"partial": False, "v": 1}), initial_wait=1.0)
    assert v["status"] == "ready"
