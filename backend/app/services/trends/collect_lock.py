"""기술 동향 수집 동시 실행 락 — 다이제스트(날짜) 단위 Redis 락(A-9).

- 키 ``trends:collect:{YYYY-MM-DD}``, ``SET NX EX`` + 토큰 비교 해제(Lua).
- TTL 은 진행 중 ``refresh`` 로 연장한다. 프로세스가 죽으면 TTL 이 지나 풀린다.
- Redis 를 못 쓰면 프로세스 내부 락으로 폴백한다(fail-open 이지만 같은 워커 안의 중복은 막는다).
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import date
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

LOCK_TTL_SEC = 30 * 60
_PREFIX = "trends:collect:"
_RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
_REFRESH_LUA = ("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) "
                "else return 0 end")

_redis_client: Any = None


def _default_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client or None
    try:
        import redis as _redis

        from app.config import settings

        _redis_client = _redis.Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=2)
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client or None


class CollectLock:
    def __init__(self, redis_getter: Callable[[], Any] = _default_redis) -> None:
        self._get = redis_getter
        self._local: dict[str, tuple[str, float]] = {}
        self._mu = threading.Lock()

    @staticmethod
    def key(digest_date: date) -> str:
        return f"{_PREFIX}{digest_date.isoformat()}"

    def _r(self):
        try:
            return self._get()
        except Exception:  # noqa: BLE001
            return None

    # ── 로컬 폴백 ────────────────────────────────────────────────────────
    def _local_acquire(self, k: str, token: str, ttl: int) -> bool:
        now = time.monotonic()
        with self._mu:
            cur = self._local.get(k)
            if cur and cur[1] > now:
                return False
            self._local[k] = (token, now + ttl)
            return True

    def _local_held(self, k: str) -> bool:
        with self._mu:
            cur = self._local.get(k)
            return bool(cur and cur[1] > time.monotonic())

    # ── API ──────────────────────────────────────────────────────────────
    def acquire(self, digest_date: date, ttl: int = LOCK_TTL_SEC) -> Optional[str]:
        """획득하면 토큰, 이미 수집 중이면 None."""
        k = self.key(digest_date)
        token = uuid.uuid4().hex
        r = self._r()
        if r is not None:
            try:
                return token if r.set(k, token, nx=True, ex=ttl) else None
            except Exception as e:  # noqa: BLE001
                logger.warning("trends 수집 락: Redis 사용 불가 — 프로세스 내부 락으로 폴백: %s", e)
        return token if self._local_acquire(k, token, ttl) else None

    def refresh(self, digest_date: date, token: str, ttl: int = LOCK_TTL_SEC) -> None:
        k = self.key(digest_date)
        r = self._r()
        if r is not None:
            try:
                r.eval(_REFRESH_LUA, 1, k, token, ttl)
                return
            except Exception:  # noqa: BLE001
                pass
        with self._mu:
            cur = self._local.get(k)
            if cur and cur[0] == token:
                self._local[k] = (token, time.monotonic() + ttl)

    def release(self, digest_date: date, token: Optional[str]) -> None:
        if not token:
            return
        k = self.key(digest_date)
        r = self._r()
        if r is not None:
            try:
                r.eval(_RELEASE_LUA, 1, k, token)
            except Exception as e:  # noqa: BLE001
                logger.warning("trends 수집 락 해제 실패(%s) — TTL 로 풀린다: %s", k, e)
        with self._mu:
            cur = self._local.get(k)
            if cur and cur[0] == token:
                self._local.pop(k, None)

    def is_held(self, digest_date: date) -> bool:
        k = self.key(digest_date)
        r = self._r()
        if r is not None:
            try:
                return bool(r.exists(k))
            except Exception:  # noqa: BLE001
                pass
        return self._local_held(k)


collect_lock = CollectLock()
