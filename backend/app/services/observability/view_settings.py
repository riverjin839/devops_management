"""관측 지표 화면 설정 — AppSetting ``observability.settings`` (D-183).

현재 키는 push 스냅샷 "오래됨" 기준(``stale_minutes``, 기본 15분) 하나다. 환경마다 수집 주기가
달라 코드 상수가 아니라 화면에서 고치는 값으로 둔다(UI-First). 저장값이 손상돼 있어도 기본값으로
되돌려 조회 화면이 죽지 않게 한다.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

OBSERVABILITY_SETTINGS_KEY = "observability.settings"
DEFAULT_STALE_MINUTES = 15
STALE_MINUTES_MIN = 1
STALE_MINUTES_MAX = 1440

DEFAULT_OBSERVABILITY_SETTINGS: dict[str, Any] = {"stale_minutes": DEFAULT_STALE_MINUTES}


def _normalize(stored: Any) -> dict[str, Any]:
    merged = {**DEFAULT_OBSERVABILITY_SETTINGS, **(stored if isinstance(stored, dict) else {})}
    try:
        minutes = int(merged.get("stale_minutes"))
    except (TypeError, ValueError):
        minutes = DEFAULT_STALE_MINUTES
    if not STALE_MINUTES_MIN <= minutes <= STALE_MINUTES_MAX:
        minutes = DEFAULT_STALE_MINUTES
    merged["stale_minutes"] = minutes
    return merged


def get_observability_settings(db: Session) -> dict[str, Any]:
    """설정 조회 — DB 오류도 기본값으로 흡수한다(fail-safe)."""
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == OBSERVABILITY_SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001
        db.rollback()
        return _normalize(None)
    return _normalize(row.value if row else None)


def set_observability_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == OBSERVABILITY_SETTINGS_KEY).first()
    prev = row.value if row and isinstance(row.value, dict) else {}
    merged = _normalize({**prev, **{k: v for k, v in patch.items() if v is not None}})
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=OBSERVABILITY_SETTINGS_KEY, value=merged))
    db.commit()
    return get_observability_settings(db)


def snapshot_freshness(
    collected_at: Optional[datetime], stale_minutes: int, now: Optional[datetime] = None
) -> tuple[bool, Optional[int]]:
    """(stale, age_sec). 수집 시각을 모르면 오래된 것으로 본다."""
    if collected_at is None:
        return True, None
    if collected_at.tzinfo is not None:
        collected_at = collected_at.astimezone(timezone.utc).replace(tzinfo=None)
    now = now or datetime.utcnow()
    age = max(0, int((now - collected_at).total_seconds()))
    return age > stale_minutes * 60, age
