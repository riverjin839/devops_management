"""backend 파드 heartbeat — 파드마다 버전·부팅 결과·메모리를 Redis 에 30초마다 남긴다(TTL 90초).

시스템 진단은 응답한 파드 하나만 직접 볼 수 있다. 롤링 배포 중이거나 새 파드가 기동하지 못해 구버전
파드가 남아 있으면(1.59 장애 때 `local-prefs` 404 의 원인) 화면에서 그걸 알 방법이 없었다. 이제
heartbeat 키를 모아 "지금 살아 있는 backend 파드와 각 버전"을 보여 주고, 버전이 섞이면 경고한다.
Redis 가 없거나 죽어도 조용히 건너뛴다(fail-safe).
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.services import boot_state

_log = logging.getLogger("k8s_monitor.heartbeat")

KEY_PREFIX = "pep:backend-pod:"
INTERVAL_SECONDS = 30
TTL_SECONDS = 90

_started = False
_client = None


def redis_client():
    global _client
    if _client is None:
        import redis as _redis
        _client = _redis.Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=2)
    return _client


def payload(version: str | None) -> dict[str, Any]:
    from app.services.memory_watch import current_rss

    boot = boot_state.snapshot()
    rss = current_rss()
    return {
        "pod": boot_state.POD_NAME,
        "version": version,
        "process_started_at": boot_state.PROCESS_STARTED_AT.isoformat(),
        "boot_finished_at": boot["finished_at"],
        "boot_duration_ms": boot["duration_ms"],
        "failed_steps": [s["name"] for s in boot["failed_steps"]],
        "pending_ddl": boot["pending_ddl"],
        "rss_mb": round(rss / 1048576, 1) if rss else None,
        "ts": datetime.now(timezone.utc).isoformat(),
    }


def beat(version: str | None) -> bool:
    try:
        redis_client().set(KEY_PREFIX + boot_state.POD_NAME, json.dumps(payload(version)), ex=TTL_SECONDS)
        return True
    except Exception as e:  # noqa: BLE001
        _log.debug("heartbeat 실패: %s", e)
        return False


def _loop(version: str | None) -> None:
    while True:
        beat(version)
        time.sleep(INTERVAL_SECONDS)


def start(version: str | None) -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, args=(version,), name="pod-heartbeat", daemon=True).start()


def list_pods() -> list[dict[str, Any]]:
    """살아 있는 backend 파드(TTL 안에 heartbeat 를 남긴 것). Redis 오류는 호출부로 올린다."""
    r = redis_client()
    out: list[dict[str, Any]] = []
    for key in r.scan_iter(match=KEY_PREFIX + "*", count=100):
        raw = r.get(key)
        if not raw:
            continue
        try:
            out.append(json.loads(raw))
        except ValueError:
            continue
    return sorted(out, key=lambda p: p.get("pod") or "")
