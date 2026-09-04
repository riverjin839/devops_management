"""클러스터별 수집 in-flight 락 — 대형 클러스터에서 한 사이클(cron)이 다음 사이클 전에 끝나지
않으면 dispatcher 가 계속 새 태스크를 얹어 Celery 워커를 그 클러스터 하나로 독점시키는 문제
(300노드급 실측: 워커 pod 풀가동 + 온디맨드 집계 지연)를 막는다.

Redis `SET NX EX` — `services/login_rate_limiter.py`/`services/observability/analysis_hook.py`
의 디바운스와 동일한 fail-open 패턴. Redis 는 이미 Celery 브로커라 새 인프라 의존성이 없고,
Redis 가 죽어도 락 없이 그냥 통과시킨다(현재 동작과 동일 — 새로운 장애점을 만들지 않는다).
"""
from __future__ import annotations

import logging

from app.services.k8s_efficiency.runs import RunLogger

logger = logging.getLogger(__name__)

_redis_client = None
_redis_unavailable_logged = False


def _get_client():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as _redis
        from app.config import settings
        _redis_client = _redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=1,
        )
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client


def _key(cluster_id: str) -> str:
    return f"k8s_eff:inflight:{cluster_id}"


def try_acquire(cluster_id: str, ttl_seconds: int) -> bool:
    """이전 실행이 아직 끝나지 않았으면 False(스킵해야 함). Redis 불가 시 True(fail-open)."""
    client = _get_client()
    if not client:
        global _redis_unavailable_logged
        if not _redis_unavailable_logged:
            logger.warning("k8s efficiency inflight lock: Redis unavailable — failing open")
            _redis_unavailable_logged = True
        return True
    try:
        return bool(client.set(_key(cluster_id), "1", nx=True, ex=ttl_seconds))
    except Exception:  # noqa: BLE001
        return True


def release(cluster_id: str) -> None:
    client = _get_client()
    if not client:
        return
    try:
        client.delete(_key(cluster_id))
    except Exception:  # noqa: BLE001
        pass


def guard_or_mark_skipped(db, cluster, run, ttl_seconds: int) -> bool:
    """락 획득을 시도한다. 실패하면(이전 실행이 진행 중) run 을 "skipped" 로 기록하고 False 를
    반환한다 — 호출자는 무거운 작업을 전혀 하지 않고 즉시 리턴해야 한다."""
    if try_acquire(str(cluster.id), ttl_seconds):
        return True
    rl = RunLogger(db, run)
    rl.log(f"클러스터 {cluster.name} 수집 건너뜀 — 이전 실행이 아직 진행 중(중복 방지 락)")
    rl.finish("skipped")
    return False
