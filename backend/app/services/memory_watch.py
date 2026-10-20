"""워커 메모리 진단 — 요청 하나가 RSS 를 크게 늘렸거나 새 최고치를 찍으면 그 요청을 로그에 남긴다.

OOMKilled 는 커널이 프로세스를 바로 죽이므로 앱이 남기는 로그가 없다. 그래서 "무슨 요청이 메모리를 키웠나"를
알 수 없었다. 이 미들웨어는 요청 전후 RSS(`/proc/self/statm`, 시스템콜 1회)를 비교해
`kubectl logs --previous` 에 단서를 남긴다:

- 한 요청 동안 RSS 가 ``MEM_WATCH_DELTA_MB`` 이상 늘면 경고.
- RSS 가 ``MEM_WATCH_RSS_MB`` 를 넘은 상태에서 이 워커의 **새 최고치**를 찍으면 경고(직전 경고보다 10MiB 이상 높을 때만).

경로(쿼리 문자열 제외 — 토큰 노출 방지)와 처리한 엔드포인트 함수 이름을 남긴다.
같은 워커에서 동시에 처리 중인 요청이 있으면 증가분이 섞일 수 있어 동시 처리 수(`inflight`)를 함께 적는다.
스트리밍 응답은 본문 전송이 끝난 시점에 잰다. 0 으로 두면 해당 조건을 끈다. Linux 가 아니면 아무것도 하지 않는다.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger("k8s_monitor.memory")

_PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
_MB = 1024 * 1024
_PEAK_STEP = 10 * _MB


def current_rss() -> Optional[int]:
    """현재 프로세스 RSS(바이트). 읽을 수 없으면 None."""
    try:
        with open("/proc/self/statm", "rb") as f:
            return int(f.read().split()[1]) * _PAGE
    except Exception:  # noqa: BLE001 — 진단은 절대 요청을 막지 않는다
        return None


class MemoryWatchMiddleware:
    def __init__(self, app: Callable, *, delta_mb: int, rss_mb: int,
                 rss_reader: Callable[[], Optional[int]] = current_rss) -> None:
        self.app = app
        self.delta = max(0, delta_mb) * _MB
        self.rss_floor = max(0, rss_mb) * _MB
        self._read = rss_reader
        self._logged_peak = 0  # 마지막으로 경고한 최고치 — 이보다 _PEAK_STEP 이상 높아야 다시 경고(소음 방지)
        self._inflight = 0
        self.enabled = (self.delta > 0 or self.rss_floor > 0) and rss_reader() is not None

    async def __call__(self, scope: dict, receive: Callable, send: Callable[[dict], Awaitable[None]]) -> None:
        if not self.enabled or scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        before = self._read() or 0
        start = time.monotonic()
        self._inflight += 1
        done = False

        def _finish(status: Any) -> None:
            nonlocal done
            if done:
                return
            done = True
            self._inflight -= 1
            self._check(scope, before, start, status)

        status_holder: dict = {}

        async def _send(message: dict) -> None:
            if message.get("type") == "http.response.start":
                status_holder["status"] = message.get("status")
            await send(message)
            if message.get("type") == "http.response.body" and not message.get("more_body", False):
                _finish(status_holder.get("status"))

        try:
            await self.app(scope, receive, _send)
        finally:
            _finish(status_holder.get("status", "error"))

    def _check(self, scope: dict, before: int, start: float, status: Any) -> None:
        after = self._read()
        if after is None:
            return
        grew = after - before
        reasons = []
        if self.delta and grew >= self.delta:
            reasons.append(f"+{grew // _MB}MiB")
        if self.rss_floor and after >= self.rss_floor and after >= self._logged_peak + _PEAK_STEP:
            reasons.append("new peak")
            self._logged_peak = after
        if not reasons:
            return
        ep = scope.get("endpoint")
        endpoint = f"{getattr(ep, '__module__', '?')}.{getattr(ep, '__name__', '?')}" if ep else "-"
        logger.warning(
            "memory-watch %s: %s %s endpoint=%s status=%s rss=%dMiB (before %dMiB) took=%.1fs inflight=%d pid=%d",
            ",".join(reasons), scope.get("method", "?"), scope.get("path", "?"), endpoint, status,
            after // _MB, before // _MB, time.monotonic() - start, self._inflight, os.getpid(),
        )
