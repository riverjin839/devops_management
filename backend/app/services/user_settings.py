"""Helpers for reading/writing per-user JSON preferences (``user_settings``).

Both helpers are defensive: a malformed/missing row returns the supplied
default rather than raising, so callers can treat personal settings as
best-effort overlays on top of built-in defaults.
"""
from typing import Any

from sqlalchemy.orm import Session

from app.models.user_setting import UserSetting


def get_user_setting(db: Session, user_id: str, key: str, default: Any = None) -> Any:
    try:
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user_id, UserSetting.key == key)
            .first()
        )
    except Exception:  # noqa: BLE001 — never let a bad row break a read path
        db.rollback()
        return default
    if row is None or row.value is None:
        return default
    return row.value


def set_user_setting(db: Session, user_id: str, key: str, value: Any) -> Any:
    row = (
        db.query(UserSetting)
        .filter(UserSetting.user_id == user_id, UserSetting.key == key)
        .first()
    )
    if row is None:
        row = UserSetting(user_id=user_id, key=key, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()
    db.refresh(row)
    return row.value
