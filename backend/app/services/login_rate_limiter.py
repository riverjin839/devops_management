"""로그인 무차별 대입(brute-force) 방어 — Redis 기반 카운터.

bcrypt 해시 비용만으로는 온라인 무차별 대입(초당 수 회 시도)을 막기에 부족하다.
IP 단위 + 계정(username) 단위로 각각 실패 횟수를 세어, 임계 초과 시 남은 윈도우
동안 429 로 거부한다. 계정 단위 카운터는 IP 를 돌려가며 시도하는 분산 공격에도
동작하고, IP 단위 카운터는 여러 계정을 순회하는 스프레이 공격을 막는다.

Redis 는 Celery 브로커로 이미 필수 인프라이므로 새 의존성 없이 재사용한다. 다중
backend replica 에서도 카운터가 공유되어야 의미가 있으므로 in-memory 대신 Redis를
쓴다. Redis 가 응답하지 않으면 로그인 자체를 막지 않고 통과시킨다(fail-open) —
이 앱의 다른 외부 서비스(Prometheus/Ollama)와 동일한 fail-safe 컨벤션이며, 로그인은
가용성이 중요한 critical path 라 레이트리밋 자체가 새로운 장애점이 되면 안 된다.
"""
from __future__ import annotations

import logging

from app.config import settings

logger = logging.getLogger("k8s_monitor.login_rate_limiter")

# IP 단위: 창(window) 내 실패 허용치. 스프레이 공격(여러 계정 순회) 방어용이라 여유 있게.
IP_MAX_FAILURES = 20
IP_WINDOW_SECONDS = 5 * 60

# 계정 단위: IP 를 돌려가며 시도해도 걸리게, 더 엄격하게.
ACCOUNT_MAX_FAILURES = 5
ACCOUNT_WINDOW_SECONDS = 15 * 60

_redis_client = None
_redis_unavailable_logged = False


def _get_client():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as _redis
        _redis_client = _redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=1,
        )
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client


def _incr_and_check(key: str, max_count: int, window_seconds: int) -> tuple[bool, int]:
    """카운터를 1 증가시키고 (허용여부, 현재값) 반환. Redis 불가 시 (True, 0) — fail-open."""
    client = _get_client()
    if not client:
        global _redis_unavailable_logged
        if not _redis_unavailable_logged:
            logger.warning("login rate limiter: Redis unavailable — failing open")
            _redis_unavailable_logged = True
        return True, 0
    try:
        pipe = client.pipeline()
        pipe.incr(key)
        pipe.expire(key, window_seconds, nx=True)  # 첫 증가일 때만 TTL 설정(창 리셋 방지)
        count, _ = pipe.execute()
        return int(count) <= max_count, int(count)
    except Exception:  # noqa: BLE001
        return True, 0


def check_login_allowed(ip: str, username: str) -> tuple[bool, str | None]:
    """로그인 시도 전 호출. (허용여부, 거부 사유) 반환 — 카운터는 실패 시에만 증가하므로
    여기서는 현재 카운터 값만 조회(증가 없이)한다."""
    client = _get_client()
    if not client:
        return True, None
    try:
        ip_count = client.get(f"login_fail:ip:{ip}")
        if ip_count and int(ip_count) >= IP_MAX_FAILURES:
            return False, "너무 많은 로그인 시도가 감지됐습니다. 잠시 후 다시 시도하세요."
        acct_count = client.get(f"login_fail:acct:{username.lower()}")
        if acct_count and int(acct_count) >= ACCOUNT_MAX_FAILURES:
            return False, "너무 많은 로그인 실패로 이 계정은 잠시 잠겼습니다. 잠시 후 다시 시도하세요."
    except Exception:  # noqa: BLE001
        return True, None
    return True, None


def record_failure(ip: str, username: str) -> None:
    _incr_and_check(f"login_fail:ip:{ip}", IP_MAX_FAILURES, IP_WINDOW_SECONDS)
    _incr_and_check(f"login_fail:acct:{username.lower()}", ACCOUNT_MAX_FAILURES, ACCOUNT_WINDOW_SECONDS)


def record_success(ip: str, username: str) -> None:
    """로그인 성공 시 해당 계정의 실패 카운터를 초기화 — 정상 사용자가 창이 끝날
    때까지 불필요하게 대기하지 않도록. IP 카운터는 다른 계정 대상 공격 이력일 수
    있으니 그대로 둔다."""
    client = _get_client()
    if not client:
        return
    try:
        client.delete(f"login_fail:acct:{username.lower()}")
    except Exception:  # noqa: BLE001
        pass


def client_ip(request) -> str:
    """nginx 뒤에서 실제 클라이언트 IP — X-Forwarded-For 첫 hop 우선."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
