"""Password hashing + JWT issue/verify utilities."""
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import bcrypt
import jwt
from jwt import PyJWTError

from app.config import settings

# bcrypt 알고리즘 자체가 72바이트를 넘는 입력은 무시한다(원 스펙 동작). bcrypt 패키지
# >=4.0 은 72바이트 초과 시 조용히 자르는 대신 ValueError 를 던지므로, schemas/auth.py
# 의 password(UTF-8 최대 128자 = 한글이면 최대 384바이트) 가 넘어오는 경우를 대비해
# 여기서 직접 잘라 원래의 "초과분 무시" 동작을 유지한다.
_BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    raw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        raw = plain.encode("utf-8")[:_BCRYPT_MAX_BYTES]
        return bcrypt.checkpw(raw, hashed.encode("utf-8"))
    except Exception:
        return False


def token_ttl_seconds() -> int:
    """액세스 토큰 1개의 수명(초) — 유휴 타임아웃과 같다(``ACCESS_TOKEN_EXPIRE_MINUTES``)."""
    return max(60, int(settings.access_token_expire_minutes) * 60)


def session_max_seconds() -> int:
    """로그인 1회로 재발급(refresh)을 이어 갈 수 있는 절대 상한(초) — ``SESSION_MAX_HOURS``."""
    return max(1, int(settings.session_max_hours)) * 3600


def create_access_token(
    subject: str,
    *,
    role: str,
    extra: dict | None = None,
    auth_time: int | None = None,
) -> str:
    """Issue a JWT for `subject` (username). Encodes role and any extra claims.

    클레임: ``iat``(발급 시각) · ``jti``(토큰 고유 id) · ``auth_time``(비밀번호로 로그인한
    시각, epoch 초). ``auth_time`` 을 넘기지 않으면 지금(=새 로그인)으로 기록하고, refresh 는
    원래 값을 넘겨 유지한다. 만료는 ``min(지금 + TTL, auth_time + SESSION_MAX_HOURS)`` —
    재발급을 이어 가도 로그인 후 상한을 넘지 못한다.
    """
    now = int(time.time())
    at = now if auth_time is None else int(auth_time)
    exp = min(now + token_ttl_seconds(), at + session_max_seconds())
    payload: dict[str, Any] = {
        "sub": subject,
        "role": role,
        "iat": now,
        "jti": uuid.uuid4().hex,
        "auth_time": at,
        "exp": exp,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def _epoch(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    return None


def token_auth_time(payload: dict[str, Any], *, now: int | None = None) -> int | None:
    """토큰의 로그인 시각(epoch 초) — ``auth_time`` → ``iat`` 순으로 쓴다.

    둘 다 없는 레거시 토큰(이 기능 이전 발급, ``exp`` 만 있음)은 ``exp - max(TTL, 세션 상한)``
    으로 추정한다. 구버전 기본 TTL 이 24h(=세션 상한 기본값)라 기본 설정에서는 실제 로그인
    시각과 같고, 설정이 달라도 실제보다 이르게(=엄격하게) 잡혀 상한을 늘리지 않는다.
    추정값이 미래면 ``now`` 로 자른다.
    """
    at = _epoch(payload.get("auth_time"))
    if at is not None:
        return at
    iat = _epoch(payload.get("iat"))
    if iat is not None:
        return iat
    exp = _epoch(payload.get("exp"))
    if exp is None:
        return None
    est = exp - max(token_ttl_seconds(), session_max_seconds())
    current = int(time.time()) if now is None else now
    return min(est, current)


def _to_epoch_seconds(dt: datetime) -> int:
    # users.* 시각 컬럼은 naive UTC(datetime.utcnow 계열)로 저장된다.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def is_token_revoked(payload: dict[str, Any], password_changed_at: datetime | None) -> bool:
    """비밀번호 변경(본인·관리자 재설정) 이전에 로그인한 토큰이면 True.

    비교는 초 단위 — 변경 직후 다시 로그인한 토큰은 ``auth_time = now >= password_changed_at``
    이라 통과한다. ``auth_time``·``iat`` 가 모두 없는 레거시 토큰은 이 컬럼이 생기기 전에
    발급된 것이므로, 변경 기록이 있으면 무조건 그 이전 로그인이다(추정 없이 거부).
    """
    if password_changed_at is None:
        return False
    changed = _to_epoch_seconds(password_changed_at)
    at = _epoch(payload.get("auth_time"))
    if at is None:
        at = _epoch(payload.get("iat"))
    if at is None:
        return True
    return at < changed


def utcnow_naive() -> datetime:
    """``users.password_changed_at`` 기록용 — 다른 users 시각 컬럼과 같은 naive UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def decode_access_token(token: str) -> dict[str, Any] | None:
    """Return the decoded payload or None on any failure (signature, expiry, parse)."""
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except PyJWTError:
        return None
