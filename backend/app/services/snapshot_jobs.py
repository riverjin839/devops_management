"""무거운 전수(全數) 집계를 백그라운드 스레드에서 수행하고 진행률/캐시를 관리.

목적: 364노드처럼 큰 클러스터에서 자원 집계/노드 이미지 수집을 **동기 HTTP 요청 한 번**으로
처리하면 ingress 타임아웃(60s)을 넘겨 502 가 나거나, 일부만 나오다 만다. 이를 해결하기 위해

- 요청 스레드는 절대 블로킹하지 않는다 → 게이트웨이 타임아웃과 분리(502 방지).
- 같은 key 에 대해 동시에 1개의 계산만 수행(중복 작업 방지).
- 직전 성공 결과가 있으면 재계산 중에도 그것을 즉시 반환(stale-while-recompute).
- builder(progress) 가 progress.processed/total 를 갱신하며 진행률을 보고 → 프론트가 폴링하며
  "N% 집계중" 을 표시.
- 계산이 끝나면 **전체(무결) 결과**를 반환 → 데이터 무결성 보장.
"""
from __future__ import annotations

import logging
import threading
import time
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
    started_at: float = field(default_factory=time.monotonic)
    finished_at: Optional[float] = None
    last_result: Any = None                 # 직전 성공 결과(stale 제공용)
    last_total: Optional[int] = None         # 진행률 분모 추정용(직전 처리량)


class SnapshotManager:
    def __init__(self, ttl: float = 30.0) -> None:
        self._ttl = ttl
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()

    def get(self, key: str, builder: Callable[[Progress], Any],
            initial_wait: float = 2.0) -> dict:
        """현재 스냅샷 뷰를 반환. 신선한 캐시가 없으면 백그라운드 계산을 1개 기동한다.

        소규모 클러스터 효율: 보여줄 직전 데이터가 없을 때만, 새 계산을 최대 `initial_wait`
        초까지 기다려 **첫 응답에 완성 결과를 실어** 폴링 없이 끝낸다. 대규모 클러스터는
        그 시간 내에 못 끝내므로 즉시 진행률(computing)을 반환하고 프론트가 폴링한다.
        """
        now = time.monotonic()
        thread: Optional[threading.Thread] = None
        had_prev_data = False
        new: Optional[_Job] = None
        with self._lock:
            job = self._jobs.get(key)
            # 신선한 완료 결과 → 그대로 반환
            if (job and job.status == "ready" and job.finished_at is not None
                    and (now - job.finished_at) < self._ttl):
                return self._view(job)
            # 이미 계산 중 → 진행 상황(또는 stale 데이터) 반환
            if job and job.status == "computing":
                return self._view(job)
            # 새 계산 시작(직전 결과/추정 total 은 보존해 stale 제공 + 진행률 분모로 사용)
            new = _Job(key=key)
            if job is not None:
                new.last_result = job.result if job.status == "ready" else job.last_result
                new.last_total = job.last_total
                had_prev_data = new.last_result is not None
            self._jobs[key] = new
            thread = threading.Thread(
                target=self._run, args=(key, builder),
                name=f"snap-{key[:24]}", daemon=True,
            )
            thread.start()
        # 소규모: 보여줄 직전 데이터가 없을 때만 잠깐 기다려 첫 응답에 결과 포함
        if thread is not None and initial_wait > 0 and not had_prev_data:
            thread.join(timeout=initial_wait)
        with self._lock:
            return self._view(self._jobs.get(key) or new)

    def _run(self, key: str, builder: Callable[[Progress], Any]) -> None:
        job = self._jobs.get(key)
        if job is None:
            return
        if job.last_total:                  # 직전 처리량을 진행률 분모 추정치로 미리 세팅
            job.progress.total = job.last_total
        try:
            result = builder(job.progress)
            job.result = result
            job.last_result = result
            if job.progress.processed:
                job.last_total = job.progress.processed
            job.status = "ready"
        except Exception as e:  # noqa: BLE001
            logger.exception("snapshot build failed (key=%s)", key)
            job.error = str(e)[:300]
            job.status = "error"
        finally:
            job.finished_at = time.monotonic()

    def _view(self, job: _Job) -> dict:
        # computing 중에는 빌더가 publish 한 부분결과(progress.partial)를 우선 노출하고,
        # 없으면 직전 성공 결과(stale)를 보여준다. ready 면 최종 결과.
        if job.status == "ready":
            data = job.result
            is_partial = False
            stale = False
        else:
            partial = job.progress.partial
            if partial is not None:
                data = partial
                is_partial = True
                stale = False
            else:
                data = job.last_result
                is_partial = False
                stale = data is not None
        return {
            "status": job.status,
            "progress": job.progress.ratio,
            "processed": job.progress.processed,
            "total": job.progress.total,
            "phase": job.progress.phase,
            "data": data,
            "partial": is_partial,
            "stale": stale,
            "error": job.error,
        }

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._jobs.pop(key, None)
