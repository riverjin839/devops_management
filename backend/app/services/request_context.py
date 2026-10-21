"""요청 추적 ID — 화면의 오류 한 건을 서버 로그·오류 기록·감사 로그까지 이어 보게 한다.

- 프론트(axios)가 요청마다 ``X-Request-ID`` 를 만들어 보낸다. 형식이 맞으면 그대로 쓰고, 없거나
  이상하면 서버가 새로 만든다 — 그래서 응답이 오지 않은 요청(타임아웃·끊김)도 같은 ID 로 찾을 수 있다.
- 응답 헤더 ``X-Request-ID`` 로 되돌려주고, 처리 중 남는 모든 로그 줄에 ``[req=...]`` 로 붙는다.
- 처리 안 된 예외·5xx 응답은 ``system_error_logs`` 에 같은 ID 로 남는다(services/system_error_logger.py).
"""
from __future__ import annotations

import contextvars
import logging
import re
import uuid

HEADER = "X-Request-ID"
_VALID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("pep_request_id", default=None)


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


def accept_or_new(raw: str | None) -> str:
    """클라이언트가 보낸 ID 는 형식이 맞을 때만 쓴다 — 로그 위조·과대 헤더 방지."""
    if raw and _VALID.match(raw):
        return raw
    return new_request_id()


def get_request_id() -> str | None:
    return _request_id.get()


def set_request_id(value: str | None) -> contextvars.Token:
    return _request_id.set(value)


def reset_request_id(token: contextvars.Token) -> None:
    _request_id.reset(token)


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        record.request_id = get_request_id() or "-"
        return True


def install_logging() -> None:
    """앱 로거(루트)에 요청 ID 가 붙는 핸들러를 단다 — 이미 핸들러가 있으면(테스트·celery) 필터만 붙인다.

    uvicorn 은 자기 로거(uvicorn.*)만 설정하므로, 그동안 앱 로그(k8s_monitor.* 등)는 루트에 핸들러가
    없어 WARNING 이상만 맨 메시지로 찍혔다. 이제 INFO 부터 시각·레벨·로거·요청 ID 와 함께 남는다.
    """
    root = logging.getLogger()
    flt = _RequestIdFilter()
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s [req=%(request_id)s] %(message)s"
        ))
        handler.addFilter(flt)
        root.addHandler(handler)
        if root.level == logging.WARNING:
            root.setLevel(logging.INFO)
    else:
        for h in root.handlers:
            h.addFilter(flt)
