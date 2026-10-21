"""요청 ID ASGI 미들웨어 — BaseHTTPMiddleware 가 아니라 순수 ASGI 라 SSE·스트리밍 응답을 건드리지 않는다.

- 요청마다 ID 를 정해(services/request_context.accept_or_new) contextvar·``scope["pep_request_id"]`` 에 둔다.
- 응답 헤더에 ``X-Request-ID`` 를 붙인다.
- 5xx 응답(라우터가 HTTPException(500) 으로 돌려준 것 포함, 응답 본문 앞부분 = 사유)은 ``system_error_logs``
  에 남긴다. 503 은 빼는데, 미설정 웹훅 토큰(fail-closed) 거부처럼 설정 상태라 매 수신마다 쌓이기 때문이다. 처리 안 된
  예외는 이 미들웨어 밖(ServerErrorMiddleware)에서 응답이 만들어지므로 main.py 의 전역 예외 핸들러가 남긴다.
"""
from __future__ import annotations

import time

import anyio

from app.services import system_error_logger
from app.services.request_context import HEADER, accept_or_new, reset_request_id, set_request_id

_HEADER_BYTES = HEADER.lower().encode()
_BODY_MAX = 2000


def _recordable(status: int) -> bool:
    return status >= 500 and status != 503


class RequestIdMiddleware:
    def __init__(self, app):  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        raw = None
        for k, v in scope.get("headers") or []:
            if k == _HEADER_BYTES:
                raw = v.decode("latin-1")
                break
        rid = accept_or_new(raw)
        scope["pep_request_id"] = rid
        token = set_request_id(rid)
        started = time.monotonic()
        status_holder: dict[str, int] = {}
        body_head = bytearray()

        async def _send(message):  # noqa: ANN001
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != _HEADER_BYTES]
                headers.append((_HEADER_BYTES, rid.encode()))
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body" and _recordable(status_holder.get("status", 0)):
                if len(body_head) < _BODY_MAX:
                    body_head.extend((message.get("body") or b"")[: _BODY_MAX - len(body_head)])
            await send(message)

        try:
            await self.app(scope, receive, _send if scope["type"] == "http" else send)
        finally:
            status = status_holder.get("status", 0)
            if scope["type"] == "http" and _recordable(status):
                headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
                app = scope.get("app")
                await anyio.to_thread.run_sync(lambda: system_error_logger.record(
                    request_id=rid, method=scope.get("method"), path=scope.get("path"),
                    status_code=status, username=system_error_logger.username_from_headers(headers),
                    app_version=getattr(app, "version", None),
                    message=body_head.decode("utf-8", "replace") or f"{status} 응답(본문 없음)",
                    duration_ms=int((time.monotonic() - started) * 1000),
                ))
            reset_request_id(token)
