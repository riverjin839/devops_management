"""대상 apiserver 별 동시 호출 상한 — PEP 전체(API replica + Celery 워커)가 한 클러스터를 동시에
두드리는 요청 수를 제한한다.

왜 필요한가: 화면 요청·점검 매트릭스·효율화 수집·리소스 카운트가 같은 분에 같은 클러스터로 몰리면
PEP 한 곳에서 수십 개 LIST 가 동시에 나간다. 클러스터가 이미 힘든 순간일수록(=응답이 느릴수록)
동시 요청이 쌓여 부하를 키운다. 여기서 클러스터당 in-flight 요청 수를 `K8S_CLUSTER_MAX_INFLIGHT`
로 묶어, 초과분은 PEP 쪽에서 잠시 기다리게 한다(대상 apiserver 가 아니라 PEP 가 줄을 선다).

구현:
  - Redis ZSET 세마포어(`k8sslot:{host}`): 멤버=요청 토큰, 점수=만료 시각. 획득은 Lua 로 원자 처리
    (만료분 정리 → 수 < 상한이면 추가). 프로세스가 죽어 반납하지 못한 슬롯은 만료 시각에 자동 회수.
  - Redis 가 없으면 프로세스 로컬 세마포어로 폴백(replica 합산 보장은 없어짐 — 로그 1회).
  - 상한 0 이하면 비활성(no-op).
  - `K8S_CLUSTER_SLOT_WAIT` 초 안에 슬롯을 못 얻으면 `K8sConcurrencyLimited` — 무한 대기로
    PEP 스레드를 붙잡지 않는다.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Iterator, Optional

logger = logging.getLogger(__name__)


def _envf(name: str, default: float) -> float:
    try:
        v = os.getenv(name)
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


MAX_INFLIGHT = int(_envf("K8S_CLUSTER_MAX_INFLIGHT", 8))
SLOT_WAIT = _envf("K8S_CLUSTER_SLOT_WAIT", 20.0)

_ACQUIRE_LUA = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('EXPIRE', KEYS[1], 900)
  return 1
end
return 0
"""


class K8sConcurrencyLimited(Exception):
    """클러스터 동시 호출 상한 대기 시간 초과 — 사용자/로그에 사유 그대로 노출."""


class ClusterSlots:
    def __init__(self, *, limit: int, wait: float, store=None) -> None:
        self.limit = limit
        self.wait = wait
        self._store = store  # _RedisStore 호환(_c() 로 redis 클라이언트) — None 이면 로컬 전용
        self._script = None
        self._local: dict[str, threading.BoundedSemaphore] = {}
        self._local_lock = threading.Lock()
        self._warned = False

    # ── 저장소 ────────────────────────────────────────────────────────────────
    def _redis(self):
        if self._store is None:
            return None
        try:
            return self._store._c()
        except Exception:  # noqa: BLE001
            return None

    def _local_sem(self, key: str) -> threading.BoundedSemaphore:
        with self._local_lock:
            sem = self._local.get(key)
            if sem is None:
                sem = threading.BoundedSemaphore(self.limit)
                self._local[key] = sem
            return sem

    # ── 획득/반납 ──────────────────────────────────────────────────────────────
    @contextmanager
    def slot(self, key: str, hold: float = 60.0) -> Iterator[None]:
        """key(apiserver host) 슬롯 1개를 잡고 블록을 실행한다. hold = 슬롯 최대 보유(만료) 초."""
        if self.limit <= 0 or not key:
            yield
            return
        r = self._redis()
        if r is not None:
            token = self._acquire_redis(r, key, hold)
            if token is not None:
                try:
                    yield
                finally:
                    try:
                        r.zrem(self._zkey(key), token)
                    except Exception:  # noqa: BLE001 — 반납 실패는 만료로 회수된다
                        pass
                return
            # Redis 오류(연결 끊김 등)면 로컬로 폴백
        if not self._warned:
            self._warned = True
            logger.warning("k8s 동시 호출 상한: Redis 사용 불가 — 프로세스 로컬 상한(%d)으로 폴백", self.limit)
        sem = self._local_sem(key)
        if not sem.acquire(timeout=max(0.0, self.wait)):
            raise K8sConcurrencyLimited(self._msg(key))
        try:
            yield
        finally:
            sem.release()

    def _zkey(self, key: str) -> str:
        return f"k8sslot:{key}"

    def _msg(self, key: str) -> str:
        return (f"대상 클러스터({key}) 동시 호출 상한 {self.limit}건을 {self.wait:.0f}초 안에 얻지 못했습니다 "
                "— 클러스터 응답이 느리거나 PEP 요청이 몰린 상태입니다(K8S_CLUSTER_MAX_INFLIGHT).")

    def _acquire_redis(self, r, key: str, hold: float) -> Optional[str]:
        """성공 시 토큰, Redis 오류 시 None(로컬 폴백). 대기 초과 시 K8sConcurrencyLimited."""
        token = uuid.uuid4().hex
        deadline = time.monotonic() + max(0.0, self.wait)
        delay = 0.02
        while True:
            now = time.time()
            try:
                if self._script is None:
                    self._script = r.register_script(_ACQUIRE_LUA)
                ok = self._script(keys=[self._zkey(key)], args=[now, now + max(1.0, hold), self.limit, token])
            except Exception as e:  # noqa: BLE001
                logger.debug("k8s slot redis 오류 — 로컬 폴백: %s", e)
                self._script = None
                return None
            if int(ok) == 1:
                return token
            if time.monotonic() >= deadline:
                raise K8sConcurrencyLimited(self._msg(key))
            time.sleep(delay)
            delay = min(delay * 2, 0.25)

    def inflight(self, key: str) -> Optional[int]:
        """현재 점유 수(관측·테스트용). Redis 없으면 None."""
        r = self._redis()
        if r is None:
            return None
        try:
            r.zremrangebyscore(self._zkey(key), "-inf", time.time())
            return int(r.zcard(self._zkey(key)))
        except Exception:  # noqa: BLE001
            return None


def _default_store():
    try:
        from app.services.snapshot_jobs import _RedisStore
        return _RedisStore(prefix="k8sslot")
    except Exception:  # noqa: BLE001
        return None


cluster_slots = ClusterSlots(limit=MAX_INFLIGHT, wait=SLOT_WAIT, store=_default_store())
