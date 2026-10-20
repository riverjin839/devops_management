"""워커 메모리 진단 미들웨어 — 요청 중 RSS 급증·새 최고치를 경로·엔드포인트와 함께 로그로 남긴다."""
import logging

import pytest

from app.services.memory_watch import MemoryWatchMiddleware

MB = 1024 * 1024


def _app(body_chunks=1):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        for i in range(body_chunks):
            await send({"type": "http.response.body", "body": b"x", "more_body": i < body_chunks - 1})
    return app


def _reader(values):
    it = iter(values)
    last = {"v": values[0]}

    def read():
        try:
            last["v"] = next(it)
        except StopIteration:
            pass
        return last["v"]
    return read


async def _call(mw, path="/api/v1/x", query=b"token=secret"):
    sent = []

    async def send(m):
        sent.append(m)

    async def receive():
        return {"type": "http.request"}

    await mw({"type": "http", "method": "GET", "path": path, "query_string": query}, receive, send)
    return sent


@pytest.mark.asyncio
async def test_logs_large_growth_without_query_string(caplog):
    # 생성자 1회 + 요청 전/후 = 300MiB → 450MiB
    mw = MemoryWatchMiddleware(_app(), delta_mb=100, rss_mb=0,
                               rss_reader=_reader([300 * MB, 300 * MB, 450 * MB]))
    with caplog.at_level(logging.WARNING, logger="k8s_monitor.memory"):
        await _call(mw, path="/api/v1/backup/export")
    msg = caplog.text
    assert "+150MiB" in msg and "/api/v1/backup/export" in msg and "status=200" in msg
    assert "secret" not in msg


@pytest.mark.asyncio
async def test_new_peak_logged_once(caplog):
    mw = MemoryWatchMiddleware(_app(), delta_mb=0, rss_mb=400,
                               rss_reader=_reader([100 * MB, 500 * MB, 500 * MB, 500 * MB, 500 * MB]))
    with caplog.at_level(logging.WARNING, logger="k8s_monitor.memory"):
        await _call(mw)
        await _call(mw)
    assert caplog.text.count("new peak") == 1


@pytest.mark.asyncio
async def test_streaming_measured_after_last_chunk_and_quiet_when_small(caplog):
    mw = MemoryWatchMiddleware(_app(body_chunks=3), delta_mb=100, rss_mb=0,
                               rss_reader=_reader([100 * MB, 100 * MB, 120 * MB]))
    with caplog.at_level(logging.WARNING, logger="k8s_monitor.memory"):
        sent = await _call(mw)
    assert len(sent) == 4 and caplog.text == ""


@pytest.mark.asyncio
async def test_disabled_when_rss_unreadable():
    mw = MemoryWatchMiddleware(_app(), delta_mb=100, rss_mb=400, rss_reader=lambda: None)
    assert mw.enabled is False
    assert len(await _call(mw)) == 2


@pytest.mark.asyncio
async def test_new_peak_needs_meaningful_step(caplog):
    vals = [100 * MB, 500 * MB, 500 * MB, 500 * MB, 503 * MB, 503 * MB, 520 * MB]
    mw = MemoryWatchMiddleware(_app(), delta_mb=0, rss_mb=400, rss_reader=_reader(vals))
    with caplog.at_level(logging.WARNING, logger="k8s_monitor.memory"):
        for _ in range(3):
            await _call(mw)
    assert caplog.text.count("new peak") == 2  # 500(첫 경고) → 503 은 조용히 → 520 은 경고
