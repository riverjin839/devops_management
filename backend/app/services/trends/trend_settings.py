"""기술 동향 설정 — AppSetting ``trends.settings`` (UI-First, A-19).

값::

    {
      "github_api_url": "https://api.github.com",   # 폐쇄망은 GHE 주소(https://ghe.example/api/v3)
      "allowed_hosts": ["mirror.internal", "*.corp.example", "10.20.0.0/16"],
      "github_token_encrypted": "v1:..."            # secret_box 암호문 — 응답에 절대 싣지 않는다
    }

- 비어 있는 값은 env(`TRENDS_GITHUB_API_URL` / `TRENDS_GITHUB_TOKEN`)로 폴백한다.
- ``allowed_hosts`` 는 사설·루프백·링크로컬 차단(SSRF 가드)의 예외 목록이다(`url_guard`).
  항목 형식: 호스트명(`mirror.internal`), 와일드카드(`*.corp.example`), IP, CIDR.
"""
from __future__ import annotations

import ipaddress
import logging
import re
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger(__name__)

SETTINGS_KEY = "trends.settings"
MAX_ALLOWED_HOSTS = 100
_HOST_RE = re.compile(r"^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")


def _row(db: Session):
    from app.models.app_setting import AppSetting
    return db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()


def _raw(db: Session) -> dict[str, Any]:
    try:
        row = _row(db)
    except Exception as e:  # noqa: BLE001 — 설정 조회 실패가 수집·화면을 막지 않게
        logger.warning("trends.settings 조회 실패 — env 기본값 사용: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return {}
    return dict(row.value) if row and isinstance(row.value, dict) else {}


def normalize_api_url(value: str) -> str:
    v = (value or "").strip().rstrip("/")
    p = urlparse(v)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("github_api_url 은 http(s):// 로 시작하는 주소여야 합니다")
    return v


def normalize_allowed_hosts(values: list[str]) -> list[str]:
    out: list[str] = []
    for raw in values or []:
        v = (raw or "").strip().lower()
        if not v:
            continue
        ok = False
        try:
            ipaddress.ip_network(v, strict=False)
            ok = True
        except ValueError:
            ok = bool(_HOST_RE.match(v))
        if not ok:
            raise ValueError(f"allowed_hosts 항목 '{raw}' 이 호스트명·*.도메인·IP·CIDR 형식이 아닙니다")
        if v not in out:
            out.append(v)
    if len(out) > MAX_ALLOWED_HOSTS:
        raise ValueError(f"allowed_hosts 는 최대 {MAX_ALLOWED_HOSTS}개입니다")
    return out


def _decrypt_token(enc: str | None) -> str | None:
    if not enc:
        return None
    try:
        from app.services.secret_box import decrypt
        return decrypt(enc)
    except Exception as e:  # noqa: BLE001 — SECRET_KEY 교체 등. 토큰 없이 진행(익명 레이트 리밋)
        logger.warning("trends GitHub 토큰 복호화 실패 — 토큰 없이 수집: %s", e)
        return None


def effective(db: Session) -> dict[str, Any]:
    """수집기가 쓰는 실제 값 — AppSetting 우선, env 폴백. 토큰 평문 포함(서버 내부 전용)."""
    raw = _raw(db)
    api_url = (raw.get("github_api_url") or "").strip() or settings.trends_github_api_url
    token = _decrypt_token(raw.get("github_token_encrypted")) or (settings.trends_github_token or None)
    hosts = raw.get("allowed_hosts") if isinstance(raw.get("allowed_hosts"), list) else []
    return {
        "github_api_url": api_url.rstrip("/"),
        "github_token": token,
        "allowed_hosts": [str(h).strip().lower() for h in hosts if str(h).strip()],
    }


def public_view(db: Session) -> dict[str, Any]:
    """GET /trends/settings 응답 — 토큰은 설정 여부만(write-only)."""
    raw = _raw(db)
    eff = effective(db)
    if raw.get("github_token_encrypted"):
        token_source = "app_setting"
    elif settings.trends_github_token:
        token_source = "env"
    else:
        token_source = None
    return {
        "github_api_url": eff["github_api_url"],
        "allowed_hosts": eff["allowed_hosts"],
        "token_set": bool(eff["github_token"]) or token_source == "app_setting",
        "token_source": token_source,
        "github_api_url_source": "app_setting" if (raw.get("github_api_url") or "").strip() else "env",
    }


def update(
    db: Session,
    *,
    github_api_url: str | None = None,
    allowed_hosts: list[str] | None = None,
    github_token: str | None = None,
    clear_token: bool = False,
) -> dict[str, Any]:
    """설정 갱신. ``github_token``: None=유지, ""=삭제(env 폴백), 값=암호화 저장. ValueError=422."""
    from app.models.app_setting import AppSetting
    from app.services.secret_box import encrypt

    raw = _raw(db)
    if github_api_url is not None:
        raw["github_api_url"] = normalize_api_url(github_api_url) if github_api_url.strip() else ""
    if allowed_hosts is not None:
        raw["allowed_hosts"] = normalize_allowed_hosts(allowed_hosts)
    if clear_token or github_token == "":
        raw.pop("github_token_encrypted", None)
    elif github_token is not None:
        raw["github_token_encrypted"] = encrypt(github_token.strip())
    row = _row(db)
    if row:
        row.value = raw
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=raw))
    db.commit()
    return public_view(db)
