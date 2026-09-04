"""클러스터별 수집 in-flight 락 — 재획득 방지, 해제 후 재획득, Redis 불가 시 fail-open,
guard_or_mark_skipped 의 run 상태 전이."""
import time
from types import SimpleNamespace as NS

from app.services.k8s_efficiency import lock as efflock


class _FakeRedis:
    """redis-py 의 최소 하위집합(set nx ex/delete) — dict 기반, 만료는 timestamp 로 흉내."""

    def __init__(self):
        self.kv: dict[str, float | None] = {}

    def _alive(self, k):
        exp = self.kv.get(k)
        if k not in self.kv:
            return False
        if exp is not None and time.time() >= exp:
            del self.kv[k]
            return False
        return True

    def set(self, k, v, nx=False, ex=None):
        if nx and self._alive(k):
            return None
        self.kv[k] = (time.time() + ex) if ex else None
        return True

    def delete(self, k):
        self.kv.pop(k, None)


class _FakeDB:
    def commit(self):
        pass

    def rollback(self):
        pass


def _run():
    return NS(id="run1", run_state="queued", log_lines="", started_at=None, finished_at=None,
              duration_ms=0, error=None, summary=None, before=None, after=None, steps=[])


def test_try_acquire_blocks_until_release(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setattr(efflock, "_get_client", lambda: fake)
    assert efflock.try_acquire("c1", ttl_seconds=60) is True
    assert efflock.try_acquire("c1", ttl_seconds=60) is False
    efflock.release("c1")
    assert efflock.try_acquire("c1", ttl_seconds=60) is True


def test_try_acquire_scoped_per_cluster(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setattr(efflock, "_get_client", lambda: fake)
    assert efflock.try_acquire("c1", ttl_seconds=60) is True
    assert efflock.try_acquire("c2", ttl_seconds=60) is True


def test_try_acquire_fails_open_when_redis_unavailable(monkeypatch):
    monkeypatch.setattr(efflock, "_get_client", lambda: False)
    assert efflock.try_acquire("c1", ttl_seconds=60) is True
    assert efflock.try_acquire("c1", ttl_seconds=60) is True  # 매번 True — 락이 아예 안 걸림


def test_guard_or_mark_skipped_passes_when_lock_free(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setattr(efflock, "_get_client", lambda: fake)
    run = _run()
    ok = efflock.guard_or_mark_skipped(_FakeDB(), NS(id="c1", name="prod"), run, ttl_seconds=60)
    assert ok is True
    assert run.run_state == "queued"  # 아직 손대지 않음 — 호출자가 이어서 start() 한다


def test_guard_or_mark_skipped_marks_run_skipped_when_locked(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setattr(efflock, "_get_client", lambda: fake)
    efflock.try_acquire("c1", ttl_seconds=60)  # 이전 실행이 락을 쥐고 있는 상태 시뮬레이션
    run = _run()
    ok = efflock.guard_or_mark_skipped(_FakeDB(), NS(id="c1", name="prod"), run, ttl_seconds=60)
    assert ok is False
    assert run.run_state == "skipped"
    assert "건너뜀" in run.log_lines
    assert run.finished_at is not None
