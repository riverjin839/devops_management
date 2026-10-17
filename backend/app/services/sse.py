"""SSE(Server-Sent Events) 실행 로그 공용 헬퍼 — 실행 버튼의 실시간 로그(D-089·D-135).

이벤트 규약(프론트 `lib/sse.ts` `postSse` + `hooks/useRunLog.ts` `applyRunEvent` 가 소비):
  - ``log``    {level: info|warn|error, ts, message}
  - ``step``   {name, label, status: running|done|failed}
  - ``result`` {result: <동기 엔드포인트와 같은 응답 본문>}   ← 마지막 이벤트(성공)
  - ``error``  {message}                                       ← 마지막 이벤트(실패, 빈 500 금지)
본문 JSON 은 snake_case 원문이다(axios 인터셉터를 거치지 않는다 — 프론트가 camelizeKeys).

규칙:
  - 검증 실패(404/403/422)는 스트림을 열기 **전에** 일반 HTTP 오류로 낸다.
  - FastAPI 0.106+ 는 yield 의존성(get_db)을 스트리밍 전에 닫으므로 작업은 자기 세션을 연다.
  - 클라이언트가 끊어도 작업은 끝까지 돈다(DB·감사 로그 정합성).
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import SessionLocal

logger = logging.getLogger(__name__)

Emit = Callable[[dict], None]

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}
# 이벤트 없이 이 시간이 지나면 SSE 주석(ping)을 보내 프록시 유휴 타임아웃을 피한다.
SSE_PING_SEC = 15.0

# 끊긴 클라이언트의 작업이 GC 로 사라지지 않게 참조를 잡아 둔다.
_BACKGROUND: set[asyncio.Task] = set()


def noop_emit(_evt: dict) -> None:
    return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sse_line(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def log_evt(emit: Emit, level: str, message: str) -> None:
    emit({"type": "log", "level": level, "ts": now_iso(), "message": message})


def step_evt(emit: Emit, name: str, label: str, status_: str) -> None:
    emit({"type": "step", "name": name, "label": label, "status": status_})


def _result_payload(result: Any) -> Any:
    if isinstance(result, BaseModel):
        return result.model_dump(mode="json")
    return result


def stream_async_job(job: Callable[[Session, Emit], Awaitable[Any]], *, name: str = "sse-job") -> StreamingResponse:
    """``job(sdb, emit)`` 를 백그라운드 태스크로 돌리고 emit 된 이벤트를 SSE 로 흘린다.

    - ``emit`` 은 스레드 안전하다(작업 스레드·executor 안에서 불러도 된다).
    - job 의 반환값이 마지막 ``result`` 이벤트가 된다(BaseModel 이면 model_dump).
    - ``HTTPException`` 은 detail 을, 그 밖의 예외는 요약을 ``error`` 이벤트로 바꾼다.
    """
    loop = asyncio.get_running_loop()
    q: asyncio.Queue[object] = asyncio.Queue()
    done = object()

    def emit(evt: dict) -> None:
        loop.call_soon_threadsafe(q.put_nowait, evt)

    async def runner() -> None:
        # 결과·오류·종료 표시도 emit 과 같은 경로(call_soon_threadsafe)로 넣어야 순서가 보장된다
        # — 직전에 예약된 log 보다 result 가 먼저 큐에 들어가 "마지막 이벤트 = result" 가 깨지지 않게.
        sdb = SessionLocal()
        try:
            result = await job(sdb, emit)
            emit({"type": "result", "result": _result_payload(result)})
        except HTTPException as e:
            sdb.rollback()
            emit({"type": "error", "message": str(e.detail)})
        except Exception as e:  # noqa: BLE001
            sdb.rollback()
            logger.exception("%s stream job failed", name)
            emit({"type": "error", "message": f"실행 중 오류: {str(e)[:300]}"})
        finally:
            sdb.close()
            loop.call_soon_threadsafe(q.put_nowait, done)

    task = loop.create_task(runner(), name=name)
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)

    async def gen():
        while True:
            try:
                evt = await asyncio.wait_for(q.get(), timeout=SSE_PING_SEC)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            if evt is done:
                return
            yield sse_line(evt)  # type: ignore[arg-type]

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
