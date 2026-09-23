"""Password hashing + JWT issue/verify utilities."""
from datetime import datetime, timedelta, timezone
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


def create_access_token(subject: str, *, role: str, extra: dict | None = None) -> str:
    """Issue a JWT for `subject` (username). Encodes role and any extra claims."""
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload: dict[str, Any] = {
        "sub": subject,
        "role": role,
        "exp": expires,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict[str, Any] | None:
    """Return the decoded payload or None on any failure (signature, expiry, parse)."""
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except PyJWTError:
        return None
