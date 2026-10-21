"""서버 오류 기록 — 처리 안 된 예외와 5xx 응답을 ``system_error_logs`` 에 요청 ID 와 함께 남긴다.

기록은 요청과 별개 세션으로 짧게 한다(statement_timeout) — 오류 기록이 느린 DB 때문에 응답을
붙잡거나, 기록 실패가 원래 응답을 바꾸면 안 된다. 실패는 로그 한 줄로만 남긴다(fail-safe).
"""
from __future__ import annotations

import logging
import os
import traceback as _tb
from typing import Any

from sqlalchemy import text

from app.auth.security import decode_access_token

_log = logging.getLogger("k8s_monitor.system_error")

_TRACE_MAX = 8000
_MSG_MAX = 2000
POD_NAME = os.getenv("HOSTNAME") or None


def username_from_headers(headers: Any) -> str | None:
    """Authorization 헤더의 JWT sub — 인증 의존성을 거치지 않은 예외에서도 누가 겪었는지 남긴다."""
    try:
        auth = headers.get("authorization") or ""
        if not auth.lower().startswith("bearer "):
            return None
        payload = decode_access_token(auth[7:].strip()) or {}
        sub = payload.get("sub")
        return str(sub)[:64] if sub else None
    except Exception:  # noqa: BLE001
        return None


def format_traceback(exc: BaseException) -> str:
    text_ = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
    # 원인은 대개 끝에 있다 — 길면 앞을 자르고 끝을 남긴다.
    return text_ if len(text_) <= _TRACE_MAX else "…(앞부분 생략)\n" + text_[-_TRACE_MAX:]


def record(
    *,
    request_id: str | None,
    method: str | None,
    path: str | None,
    status_code: int,
    username: str | None = None,
    app_version: str | None = None,
    exc: BaseException | None = None,
    message: str | None = None,
    duration_ms: int | None = None,
) -> None:
    """한 행 기록. 예외를 올리지 않는다 — 동기 함수라 async 경로에서는 스레드로 넘겨 부른다."""
    from app.database import SessionLocal
    from app.models.system_error_log import SystemErrorLog

    db = SessionLocal()
    try:
        db.execute(text("SET LOCAL statement_timeout = 3000"))
        db.add(SystemErrorLog(
            request_id=(request_id or None) and request_id[:64],
            method=(method or None) and method[:10],
            path=(path or None) and path[:512],
            status_code=int(status_code),
            username=username,
            pod=POD_NAME and POD_NAME[:128],
            app_version=(app_version or None) and str(app_version)[:32],
            error_type=type(exc).__name__[:128] if exc is not None else None,
            message=((message if message is not None else (str(exc) if exc is not None else None)) or None)
            and (message if message is not None else str(exc))[:_MSG_MAX],
            traceback=format_traceback(exc) if exc is not None else None,
            duration_ms=duration_ms,
        ))
        db.commit()
    except Exception as e:  # noqa: BLE001 — 기록 실패가 응답을 바꾸면 안 된다
        db.rollback()
        _log.warning("system error log 기록 실패 req=%s path=%s: %s", request_id, path, e)
    finally:
        db.close()
