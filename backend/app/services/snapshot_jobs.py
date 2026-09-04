"""무거운 전수(全數) 집계를 백그라운드 스레드에서 수행하고 진행률/캐시를 관리.

목적: 364노드처럼 큰 클러스터에서 자원 집계/노드 이미지 수집을 **동기 HTTP 요청 한 번**으로
처리하면 ingress 타임아웃(60s)을 넘겨 502 가 나거나, 일부만 나오다 만다. 이를 해결하기 위해

- 요청 스레드는 절대 블로킹하지 않는다 → 게이트웨이 타임아웃과 분리(502 방지).
- 같은 key 에 대해 동시에 1개의 계산만 수행(중복 작업 방지).
- 직전 성공 결과가 있으면 재계산 중에도 그것을 즉시 반환(stale-while-recompute).
- builder(progress) 가 progress.processed/total 를 갱신하며 진행률을 보고 → 프론트가 폴링하며
  "N% 집계중" 을 표시.
- 계산이 끝나면 **전체(무결) 결과**를 반환 → 데이터 무결성 보장.

멀티 replica(HPA 2~10) 대응: 스냅샷/진행률/락을 **Redis 에 공유**한다(`_RedisStore`). 프론트의
1.5초 폴링이 매번 다른 파드에 맞아도 같은 진행률·같은 결과를 보고, 전수 스캔은 클러스터당
1개(락 소유 replica)만 돈다. Redis 가 없거나 죽으면 종전처럼 프로세스 메모리(`_MemoryStore`)로
조용히 폴백한다(fail-safe — 화면은 계속 떠야 한다).
"""
from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


@dataclass
class Progress:
    """builder 가 갱신하는 진행 상태. total 을 모르면 None(불확정)."""
    processed: int = 0
    total: Optional[int] = None
    phase: str = ""
    # 빌더가 주기적으로 publish 하는 중간(부분) 결과 — 누적 표시용. ready 전에도 노출된다.
    partial: Any = None

    @property
    def ratio(self) -> Optional[float]:
        if self.total and self.total > 0:
            return max(0.0, min(1.0, self.processed / self.total))
        return None


@dataclass
class _Job:
    key: str
    status: str = "computing"               # computing | ready | error
    progress: Progress = field(default_factory=Progress)
    result: Any = None
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    last_result: Any = None                 # 직전 성공 결과(stale 제공용)
    last_total: Optional[int] = None         # 진행률 분모 추정용(직전 처리량)


def _view_of(*, status: str, processed: int, total: Optional[int], phase: str,
             result: Any, partial_data: Any, last_result: Any, error: Optional[str]) -> dict:
    """스토어 종류와 무관한 공통 뷰 조립. computing 중에는 부분결과 → 직전결과(stale) 순."""
    if status == "ready":
        data, is_partial, stale = result, False, False
    else:
        if partial_data is not None:
            data, is_partial, stale = partial_data, True, False
        else:
            data, is_partial, stale = last_result, False, last_result is not None
    ratio = None
    if total and total > 0:
        ratio = max(0.0, min(1.0, processed / total))
    return {
        "status": status,
        "progress": ratio,
        "processed": processed,
        "total": total,
        "phase": phase,
        "data": data,
        "partial": is_partial,
        "stale": stale,
        "error": error,
    }


# ── Redis 공유 스토어 ────────────────────────────────────────────────────────────
_OWNER = f"{socket.gethostname()}:{os.getpid()}"


class _RedisStore:
    """스냅샷 meta/result/partial/lock 을 Redis 에 JSON 으로 보관.

    키: `snap:{key}:meta|result|partial|last|lock`. 모든 호출은 예외를 삼키고 None/False 를
    돌려준다 — 호출측(SnapshotManager)이 memory 폴백으로 처리한다.
    """

    # ping 캐시: 성공 후 5초는 재확인 없이 통과, 실패 후 30초는 memory 폴백 유지(재연결 시도 억제).
    _OK_TTL = 5.0
    _FAIL_TTL = 30.0

    def __init__(self, client=None, url: Optional[str] = None, prefix: str = "snap"):
        self._client = client
        self._url = url
        self._prefix = prefix
        self._warned = False
        self._ok_until = 0.0
        self._fail_until = 0.0

    # -- 연결 --
    def _c(self):
        """살아있는 클라이언트 또는 None. 주입된 클라이언트도 ping 으로 검증한다(장애 중
        Redis 를 계속 믿고 빈 뷰를 돌려주는 대신 memory 로 폴백하기 위함)."""
        now = time.time()
        if now < self._ok_until and self._client is not None:
            return self._client
        if now < self._fail_until:
            return None
        try:
            if self._client is None:
                import redis as _redis
                url = self._url
                if not url:
                    from app.config import settings
                    url = settings.redis_url
                self._client = _redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=2)
            self._client.ping()
            self._ok_until = now + self._OK_TTL
            self._fail_until = 0.0
            return self._client
        except Exception as e:  # noqa: BLE001
            self._fail_until = now + self._FAIL_TTL
            self._ok_until = 0.0
            if not self._warned:
                self._warned = True
                logger.warning("snapshot store: Redis 사용 불가 — 프로세스 메모리로 폴백 (%s)",
                               str(e)[:120])
            return None

    def available(self) -> bool:
        return self._c() is not None

    def _k(self, key: str, part: str) -> str:
        return f"{self._prefix}:{key}:{part}"

    # -- 원시 접근(모두 fail-safe) --
    def get_json(self, key: str, part: str) -> Any:
        c = self._c()
        if c is None:
            return None
        try:
            raw = c.get(self._k(key, part))
            return json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001
            return None

    def set_json(self, key: str, part: str, value: Any, ex: Optional[int] = None) -> bool:
        c = self._c()
        if c is None:
            return False
        try:
            payload = json.dumps(value, default=_json_default, separators=(",", ":"))
            if ex is not None and ex > 0:
                c.set(self._k(key, part), payload, ex=int(ex))
            else:
                c.set(self._k(key, part), payload)
            return True
        except Exception as e:  # noqa: BLE001
            logger.warning("snapshot store: Redis 쓰기 실패(%s:%s): %s", key, part, str(e)[:120])
            return False

    def delete(self, key: str, *parts: str) -> None:
        c = self._c()
        if c is None:
            return
        try:
            c.delete(*[self._k(key, p) for p in parts])
        except Exception:  # noqa: BLE001
            pass

    def acquire_lock(self, key: str, token: str, ttl: float) -> bool:
        c = self._c()
        if c is None:
            return False
        try:
            return bool(c.set(self._k(key, "lock"), token, nx=True, ex=max(1, int(ttl))))
        except Exception:  # noqa: BLE001
            return False

    def release_lock(self, key: str, token: str) -> None:
        """소유 토큰이 일치할 때만 삭제(다른 replica 가 stuck 교체로 새로 잡은 락 보호)."""
        c = self._c()
        if c is None:
            return
        try:
            raw = c.get(self._k(key, "lock"))
            cur = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
            if cur == token:
                c.delete(self._k(key, "lock"))
        except Exception:  # noqa: BLE001
            pass

    def force_lock(self, key: str, token: str, ttl: float) -> bool:
        """stuck 교체용 — 기존 락을 덮어쓴다."""
        c = self._c()
        if c is None:
            return False
        try:
            c.set(self._k(key, "lock"), token, ex=max(1, int(ttl)))
            return True
        except Exception:  # noqa: BLE001
            return False


def _json_default(o):
    if isinstance(o, set):
        return sorted(o)
    if isinstance(o, tuple):
        return list(o)
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


class _PublishingProgress(Progress):
    """진행률/부분결과를 Redis 에 주기적으로 밀어 넣는 Progress.

    `processed` 는 빌더가 pod 마다 += 1 하므로 매번 쓰면 Redis 왕복이 과하다 — 최소
    `publish_interval` 초 간격으로만 meta 를 갱신하고, `partial` 대입은 즉시 저장한다.
    """

    def __init__(self, store: _RedisStore, key: str, meta: dict, publish_interval: float = 1.0):
        # dataclass __init__ 이 필드 대입으로 __setattr__ 를 타므로 스토어 참조를 먼저 심는다.
        object.__setattr__(self, "_store", store)
        object.__setattr__(self, "_key", key)
        object.__setattr__(self, "_meta", meta)
        object.__setattr__(self, "_interval", publish_interval)
        object.__setattr__(self, "_last_pub", 0.0)
        object.__setattr__(self, "_armed", False)
        super().__init__()
        object.__setattr__(self, "_armed", True)

    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)
        if not self.__dict__.get("_armed"):
            return
        if name == "partial":
            self._flush(force=True)
            if value is not None:
                self._store.set_json(self._key, "partial", value, ex=120)
        elif name in ("processed", "total", "phase"):
            self._flush(force=(name == "phase"))

    def _flush(self, force: bool = False) -> None:
        now = time.time()
        if not force and (now - self._last_pub) < self._interval:
            return
        object.__setattr__(self, "_last_pub", now)
        meta = self._meta
        meta["processed"] = self.processed
        meta["total"] = self.total
        meta["phase"] = self.phase
        self._store.set_json(self._key, "meta", meta)


class SnapshotManager:
    def __init__(self, ttl: float = 30.0, partial_ttl: Optional[float] = None,
                 stuck_timeout: float = 1800.0, backend: str = "auto",
                 store: Optional[_RedisStore] = None,
                 publish_interval: float = 1.0) -> None:
        """ttl: 완전한 결과의 캐시 수명. partial_ttl: 결과가 부분(절단) 집계일 때 적용할
        더 짧은 수명(None 이면 ttl 과 동일) — 절단된 스냅샷이 ttl 내내 확정 데이터처럼
        서빙되는 것을 막고 자동 재집계되게 한다. stuck_timeout: computing 이 이 시간(초)을
        넘기면 행업으로 간주하고 새 계산으로 교체(영구 wedge 방지).

        backend: "auto"(Redis 가능하면 공유, 아니면 memory) | "redis" | "memory".
        store: 테스트 주입용 `_RedisStore`(fake 클라이언트 포함)."""
        self._ttl = ttl
        self._partial_ttl = partial_ttl
        self._stuck_timeout = stuck_timeout
        self._publish_interval = publish_interval
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()
        self._backend = (backend or "auto").lower()
        self._store: Optional[_RedisStore] = None
        if store is not None:
            self._store = store
        elif self._backend in ("auto", "redis"):
            self._store = _RedisStore()

    # ── 공통 ────────────────────────────────────────────────────────────────────
    @property
    def is_shared(self) -> bool:
        """Redis 공유 스토어가 실제로 동작 중인지(빌더가 publish 주기를 늘리는 데 참고)."""
        return self._backend != "memory" and self._store is not None and self._store.available()

    def _effective_ttl_for(self, result: Any) -> float:
        """부분(절단) 결과면 partial_ttl 로 단축된 TTL 반환(duck-check: dict 의 partial 키)."""
        if (self._partial_ttl is not None and isinstance(result, dict) and result.get("partial")):
            return min(self._ttl, self._partial_ttl)
        return self._ttl

    def _effective_ttl(self, job: _Job) -> float:
        return self._effective_ttl_for(job.result)

    def get(self, key: str, builder: Callable[[Progress], Any],
            initial_wait: float = 2.0, force: bool = False) -> dict:
        """현재 스냅샷 뷰를 반환. 신선한 캐시가 없으면 백그라운드 계산을 1개 기동한다.

        소규모 클러스터 효율: 보여줄 직전 데이터가 없을 때만, 새 계산을 최대 `initial_wait`
        초까지 기다려 **첫 응답에 완성 결과를 실어** 폴링 없이 끝낸다. 대규모 클러스터는
        그 시간 내에 못 끝내므로 즉시 진행률(computing)을 반환하고 프론트가 폴링한다.
        """
        if self.is_shared:
            return self._get_shared(key, builder, initial_wait, force)
        return self._get_local(key, builder, initial_wait, force)

    def put(self, key: str, result: Any, processed: Optional[int] = None) -> None:
        """외부(예: Celery 수집 워커)가 만든 완성 결과를 스냅샷으로 등록(워밍).
        공유 스토어면 모든 replica 가 즉시 본다. 진행 중인 계산이 있으면 덮어쓰지 않는다."""
        now = time.time()
        if self.is_shared:
            meta = self._store.get_json(key, "meta") or {}
            if meta.get("status") == "computing" and (now - float(meta.get("started_at") or 0)) < self._stuck_timeout:
                return
            self._store.set_json(key, "result", result, ex=int(self._effective_ttl_for(result)) + 60)
            self._store.set_json(key, "last", result)
            self._store.set_json(key, "meta", {
                "status": "ready", "started_at": now, "finished_at": now,
                "processed": processed or 0, "total": processed, "phase": "", "error": None,
                "last_total": processed, "owner": _OWNER,
            })
            self._store.delete(key, "partial")
            return
        with self._lock:
            job = self._jobs.get(key)
            if job and job.status == "computing" and (now - job.started_at) < self._stuck_timeout:
                return
            new = _Job(key=key, status="ready", result=result, last_result=result,
                       finished_at=now, last_total=processed)
            new.progress.processed = processed or 0
            new.progress.total = processed
            self._jobs[key] = new

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._jobs.pop(key, None)
        if self._store is not None and self._backend != "memory":
            self._store.delete(key, "meta", "result", "partial", "last")

    # ── 프로세스 로컬(memory) ────────────────────────────────────────────────────
    def _get_local(self, key: str, builder, initial_wait: float, force: bool) -> dict:
        now = time.time()
        thread: Optional[threading.Thread] = None
        had_prev_data = False
        new: Optional[_Job] = None
        with self._lock:
            job = self._jobs.get(key)
            # 이미 계산 중 → 진행 상황(또는 stale 데이터) 반환 (force 라도 재시작 안 함 — 폭주 방지).
            # 단, stuck_timeout 을 넘긴 잡은 행업(끊긴 apiserver 등)으로 간주하고 새 계산으로
            # 교체한다 — 그렇지 않으면 refresh 가 영원히 no-op 이 되어 재기동 외엔 복구 불가.
            if job and job.status == "computing":
                if (now - job.started_at) < self._stuck_timeout:
                    return self._view(job)
                logger.warning("snapshot job stuck > %.0fs — replacing (key=%s)",
                               self._stuck_timeout, key)
            # 신선한 완료 결과 → 그대로 반환 (force 면 무시하고 재계산)
            if (not force and job and job.status == "ready" and job.finished_at is not None
                    and (now - job.finished_at) < self._effective_ttl(job)):
                return self._view(job)
            # 새 계산 시작(직전 결과/추정 total 은 보존해 stale 제공 + 진행률 분모로 사용)
            new = _Job(key=key)
            if job is not None:
                new.last_result = job.result if job.status == "ready" else job.last_result
                new.last_total = job.last_total
                had_prev_data = new.last_result is not None
            self._jobs[key] = new
            thread = threading.Thread(
                target=self._run_local, args=(key, builder),
                name=f"snap-{key[:24]}", daemon=True,
            )
            thread.start()
        # 소규모: 보여줄 직전 데이터가 없을 때만 잠깐 기다려 첫 응답에 결과 포함
        if thread is not None and initial_wait > 0 and not had_prev_data:
            thread.join(timeout=initial_wait)
        with self._lock:
            return self._view(self._jobs.get(key) or new)

    def _run_local(self, key: str, builder: Callable[[Progress], Any]) -> None:
        job = self._jobs.get(key)
        if job is None:
            return
        if job.last_total:                  # 직전 처리량을 진행률 분모 추정치로 미리 세팅
            job.progress.total = job.last_total
        # finished_at 을 status 보다 먼저 기록 — 리더가 status=="ready" 인데 finished_at 이
        # None 인 순간을 관측해 불필요한 전체 재계산을 시작하는 것을 방지(GIL 상 필드 단위
        # 쓰기는 원자적이므로 이 순서만 보장하면 충분).
        try:
            result = builder(job.progress)
            job.result = result
            job.last_result = result
            if job.progress.processed:
                job.last_total = job.progress.processed
            job.finished_at = time.time()
            job.status = "ready"
        except Exception as e:  # noqa: BLE001
            logger.exception("snapshot build failed (key=%s)", key)
            job.error = str(e)[:300]
            job.finished_at = time.time()
            job.status = "error"

    def _view(self, job: _Job) -> dict:
        return _view_of(
            status=job.status, processed=job.progress.processed, total=job.progress.total,
            phase=job.progress.phase, result=job.result, partial_data=job.progress.partial,
            last_result=job.last_result, error=job.error,
        )

    # ── Redis 공유 ───────────────────────────────────────────────────────────────
    def _shared_view(self, key: str, meta: Optional[dict]) -> dict:
        meta = meta or {}
        status = meta.get("status") or "computing"
        result = self._store.get_json(key, "result") if status == "ready" else None
        if status == "ready" and result is None:
            # result 키가 TTL 로 먼저 사라진 경우 — 직전 결과라도 보여주고 재계산은 get() 이 결정
            status = "expired"
        partial_data = self._store.get_json(key, "partial") if status == "computing" else None
        last_result = self._store.get_json(key, "last") if status != "ready" else None
        v = _view_of(
            status=("computing" if status == "computing" else ("ready" if status == "ready" else status)),
            processed=int(meta.get("processed") or 0), total=meta.get("total"),
            phase=meta.get("phase") or "", result=result, partial_data=partial_data,
            last_result=last_result, error=meta.get("error"),
        )
        if status == "expired":
            v["status"] = "computing" if last_result is not None else "error"
            v["stale"] = last_result is not None
            if last_result is None and not v["error"]:
                v["error"] = "snapshot expired"
        return v

    def _get_shared(self, key: str, builder, initial_wait: float, force: bool) -> dict:
        now = time.time()
        store = self._store
        meta = store.get_json(key, "meta")
        if meta:
            st = meta.get("status")
            started = float(meta.get("started_at") or 0)
            finished = meta.get("finished_at")
            if st == "computing":
                if (now - started) < self._stuck_timeout:
                    return self._shared_view(key, meta)
                logger.warning("snapshot job stuck > %.0fs — replacing (key=%s, owner=%s)",
                               self._stuck_timeout, key, meta.get("owner"))
                store.delete(key, "lock")
            elif st == "ready" and not force and finished is not None:
                result = store.get_json(key, "result")
                if result is not None and (now - float(finished)) < self._effective_ttl_for(result):
                    return self._shared_view(key, meta)
        # 새 계산 — 리더 선출(락). 실패하면 다른 replica 가 이미 돌리는 중.
        token = f"{_OWNER}:{uuid.uuid4().hex[:8]}"
        if not store.acquire_lock(key, token, self._stuck_timeout):
            m2 = store.get_json(key, "meta") or meta
            return self._shared_view(key, m2)
        had_prev = (store.get_json(key, "last") is not None)
        last_total = (meta or {}).get("last_total")
        new_meta = {
            "status": "computing", "started_at": now, "finished_at": None,
            "processed": 0, "total": last_total, "phase": "", "error": None,
            "last_total": last_total, "owner": token,
        }
        store.set_json(key, "meta", new_meta)
        store.delete(key, "partial")
        thread = threading.Thread(
            target=self._run_shared, args=(key, builder, new_meta, token),
            name=f"snap-{key[:24]}", daemon=True,
        )
        thread.start()
        if initial_wait > 0 and not had_prev:
            thread.join(timeout=initial_wait)
        return self._shared_view(key, store.get_json(key, "meta") or new_meta)

    def _run_shared(self, key: str, builder, meta: dict, token: str) -> None:
        store = self._store
        prog = _PublishingProgress(store, key, meta, publish_interval=self._publish_interval)
        if meta.get("last_total"):
            prog.total = meta["last_total"]
        try:
            result = builder(prog)
            processed = prog.processed
            ttl = int(self._effective_ttl_for(result))
            store.set_json(key, "result", result, ex=ttl + 60)
            store.set_json(key, "last", result)
            meta.update({
                "status": "ready", "finished_at": time.time(), "processed": processed,
                "total": prog.total, "phase": prog.phase, "error": None,
                "last_total": processed or meta.get("last_total"),
            })
            store.set_json(key, "meta", meta)
            store.delete(key, "partial")
        except Exception as e:  # noqa: BLE001
            logger.exception("snapshot build failed (key=%s)", key)
            meta.update({"status": "error", "finished_at": time.time(), "error": str(e)[:300]})
            store.set_json(key, "meta", meta)
            store.delete(key, "partial")
        finally:
            store.release_lock(key, token)
