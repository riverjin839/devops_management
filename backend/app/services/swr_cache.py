"""짧은 TTL 캐시 + single-flight + stale-while-revalidate — 화면용 K8s 목록 조회 보호.

- **fresh** 이내: 캐시 그대로 응답(apiserver 호출 0).
- **fresh~stale**: 캐시를 즉시 응답하고 백그라운드에서 1회만 갱신(SWR) — 두 번째 진입부터 체감 0초.
- **stale 초과/없음**: 동기 조회. 같은 키를 동시에 요청하면 1건만 apiserver 로 나가고 나머지는
  그 결과를 기다린다(single-flight) — 사용자·탭 N개가 같은 목록을 열어도 LIST 는 1회.
- **무효화 세대(epoch)**: 쓰기(삭제/스케일 등) 뒤 `bump(group)` 을 부르면 그 그룹의 캐시가 전부
  무효가 된다. 세대는 Redis 에 두어 **다른 replica 의 캐시도** 다음 요청에서 무효가 된다
  (Redis 가 없으면 프로세스 로컬 세대로 폴백). 쓰기 전에 시작된 조회 결과는 저장하지 않는다.
- 오류는 캐시하지 않는다. 백그라운드 갱신 실패 시 기존 값을 stale 한도까지 계속 쓴다.
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Hashable, Optional

logger = logging.getLogger(__name__)


class _Entry:
    __slots__ = ("value", "at", "epoch")

    def __init__(self, value: Any, at: float, epoch: Any) -> None:
        self.value = value
        self.at = at
        self.epoch = epoch


class SWRCache:
    def __init__(self, *, fresh: float, stale: float, max_entries: int = 256,
                 store: Any = None, workers: int = 4, name: str = "swr") -> None:
        self.fresh = fresh
        self.stale = max(stale, fresh)
        self.max_entries = max_entries
        self._store = store            # _RedisStore 호환(get_json/set_json) — 없으면 로컬 세대만
        self._name = name
        self._entries: dict[Hashable, _Entry] = {}
        self._inflight: dict[Hashable, Future] = {}
        self._local_epoch: dict[str, float] = {}
        self._lock = threading.Lock()
        self._workers = workers
        self._executor: Optional[ThreadPoolExecutor] = None

    # ── 세대(무효화) ──────────────────────────────────────────────────────────
    def _epoch(self, group: str) -> Any:
        local = self._local_epoch.get(group, 0.0)
        if self._store is None:
            return local
        remote = self._store.get_json(group, "epoch")
        return (remote if isinstance(remote, (int, float)) else 0.0, local)

    def bump(self, group: Any) -> None:
        """group(예: 클러스터 id)의 캐시 전부 무효화 — 모든 replica 에 전파(Redis)."""
        group = str(group)
        now = time.time()
        with self._lock:
            self._local_epoch[group] = max(now, self._local_epoch.get(group, 0.0) + 1e-6)
            for k in [k for k in self._entries if k[0] == group]:
                self._entries.pop(k, None)
        if self._store is not None:
            self._store.set_json(group, "epoch", now, ex=int(self.stale * 4) + 60)

    # ── 조회 ──────────────────────────────────────────────────────────────────
    def get(self, key: tuple, loader: Callable[[], Any], *, refresh: bool = False) -> tuple[Any, dict]:
        """key[0] 은 무효화 그룹(클러스터 id). 반환: (값, {"cache": hit|stale|miss, "age": 초})."""
        group = str(key[0])
        key = (group, *key[1:])
        epoch = self._epoch(group)
        now = time.monotonic()
        with self._lock:
            ent = self._entries.get(key)
            if ent is not None and ent.epoch != epoch:
                self._entries.pop(key, None)
                ent = None
            if ent is not None and not refresh:
                age = now - ent.at
                if age <= self.fresh:
                    return ent.value, {"cache": "hit", "age": round(age, 1)}
                if age <= self.stale:
                    if key not in self._inflight:
                        fut: Future = Future()
                        self._inflight[key] = fut
                        self._pool().submit(self._run, key, loader, epoch, fut, True)
                    return ent.value, {"cache": "stale", "age": round(age, 1)}
            fut = self._inflight.get(key)
            owner = fut is None
            if owner:
                fut = Future()
                self._inflight[key] = fut
        if owner:
            self._run(key, loader, epoch, fut, False)
        return fut.result(), {"cache": "miss", "age": 0.0}

    def _run(self, key: tuple, loader: Callable[[], Any], epoch: Any, fut: Future, background: bool) -> None:
        try:
            value = loader()
        except BaseException as e:  # noqa: BLE001 — 대기자에게 그대로 전달
            with self._lock:
                self._inflight.pop(key, None)
            fut.set_exception(e)
            if background:
                logger.warning("%s: 백그라운드 갱신 실패 key=%s: %s", self._name, key, str(e)[:200])
            return
        with self._lock:
            self._inflight.pop(key, None)
            # 조회 도중 쓰기(bump)가 있었으면 이전 세대 결과는 저장하지 않는다.
            if self._epoch_unchanged(str(key[0]), epoch):
                if key not in self._entries and len(self._entries) >= self.max_entries:
                    oldest = min(self._entries, key=lambda k: self._entries[k].at)
                    self._entries.pop(oldest, None)
                self._entries[key] = _Entry(value, time.monotonic(), epoch)
        fut.set_result(value)

    def _epoch_unchanged(self, group: str, epoch: Any) -> bool:
        # 로컬 세대만 비교(락 안에서 Redis 왕복 회피). 원격 bump 는 다음 get 에서 걸러진다.
        local = self._local_epoch.get(group, 0.0)
        return (epoch[1] if isinstance(epoch, tuple) else epoch) == local

    def _pool(self) -> ThreadPoolExecutor:
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=self._workers,
                                                thread_name_prefix=f"{self._name}-refresh")
        return self._executor

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._local_epoch.clear()
