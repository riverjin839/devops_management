"""이 backend 프로세스의 부팅 기록 — 시스템 진단(Settings ▸ 시스템 진단)이 보여준다.

부팅 마이그레이션 실패·lock 경합으로 미룬 DDL 은 지금까지 파드 로그에만 남아, 재시작하면 사라지고
화면에서는 알 수 없었다(1.59 CrashLoopBackOff 때 원인 추적이 어려웠던 이유). lifespan 이 단계마다
여기에 결과를 적고, 진단 API·파드 heartbeat 가 읽는다.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any, Callable

PROCESS_STARTED_AT = datetime.now(timezone.utc)
POD_NAME = os.getenv("HOSTNAME") or "local"

_state: dict[str, Any] = {
    "started_at": None,
    "finished_at": None,
    "duration_ms": None,
    "advisory_lock": None,  # acquired | timeout | failed
    "steps": [],  # [{name, ok, error, duration_ms}]
}
# main._pending_ddl 을 직접 import 하면 순환이라 lifespan 이 조회 함수를 넣어 둔다.
pending_ddl_provider: Callable[[], list[str]] = lambda: []


def begin() -> None:
    _state.update(started_at=datetime.now(timezone.utc).isoformat(), finished_at=None,
                  duration_ms=None, steps=[], advisory_lock=None)
    _state["_t0"] = time.monotonic()


def set_advisory_lock(result: str) -> None:
    _state["advisory_lock"] = result


def record_step(name: str, started: float, error: BaseException | None = None) -> None:
    _state["steps"].append({
        "name": name,
        "ok": error is None,
        "error": None if error is None else f"{type(error).__name__}: {str(error)[:300]}",
        "duration_ms": int((time.monotonic() - started) * 1000),
    })


def finish() -> None:
    _state["finished_at"] = datetime.now(timezone.utc).isoformat()
    t0 = _state.pop("_t0", None)
    if t0 is not None:
        _state["duration_ms"] = int((time.monotonic() - t0) * 1000)


def snapshot() -> dict[str, Any]:
    steps = list(_state["steps"])
    try:
        pending = list(pending_ddl_provider())
    except Exception:  # noqa: BLE001
        pending = []
    return {
        "started_at": _state["started_at"],
        "finished_at": _state["finished_at"],
        "duration_ms": _state["duration_ms"],
        "advisory_lock": _state["advisory_lock"],
        "step_count": len(steps),
        "failed_steps": [s for s in steps if not s["ok"]],
        "slow_steps": sorted(steps, key=lambda s: s["duration_ms"], reverse=True)[:5],
        "pending_ddl": pending,
    }
