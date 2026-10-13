"""홈/네비게이션 개인화(home_prefs) 공용 로직 — 라우터 두 곳(`home_prefs`, `ui_settings`)이 공유한다.

- 조직 기본 설치 목록은 `app_settings` 의 ``home_prefs_defaults`` 에 있고, admin 이 Settings
  "화면 UI 설정" 에서 바꾼다(UI-First). 행이 없으면 내장 기본값을 쓴다.
- 사용자 행의 ``installed_apps`` 가 None 이면 조직 기본값을 따른다.
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.app_setting import AppSetting
from app.schemas.home_prefs import (
    BUILTIN_DEFAULT_INSTALLED_APPS,
    HomePrefs,
    HomePrefsOut,
    HomePrefsUpdate,
)

DEFAULTS_KEY = "home_prefs_defaults"


def _clean_ids(ids: Any) -> list[str]:
    """문자열만, 중복 제거, 순서 보존."""
    out: list[str] = []
    if not isinstance(ids, list):
        return out
    for v in ids:
        if isinstance(v, str) and v and v not in out:
            out.append(v)
    return out


def get_default_installed_apps(db: Session) -> list[str]:
    try:
        row = db.query(AppSetting).filter(AppSetting.key == DEFAULTS_KEY).first()
    except Exception:  # noqa: BLE001 — 기본값 조회 실패가 개인 설정 응답을 막으면 안 된다
        db.rollback()
        row = None
    if row is not None and isinstance(row.value, dict) and isinstance(row.value.get("installed_apps"), list):
        return _clean_ids(row.value["installed_apps"])
    return list(BUILTIN_DEFAULT_INSTALLED_APPS)


def set_default_installed_apps(db: Session, apps: list[str]) -> list[str]:
    cleaned = _clean_ids(apps)
    row = db.query(AppSetting).filter(AppSetting.key == DEFAULTS_KEY).first()
    if row is None:
        db.add(AppSetting(key=DEFAULTS_KEY, value={"installed_apps": cleaned}))
    else:
        row.value = {"installed_apps": cleaned}
    db.commit()
    return cleaned


def load_prefs(raw: Any) -> HomePrefs:
    if not isinstance(raw, dict):
        return HomePrefs()
    try:
        prefs = HomePrefs.model_validate(raw)
    except ValidationError:
        # 표시 선호(테마·강조색)가 깨져 있다고 설정 전체를 못 읽으면 안 된다 — 그 둘만 버리고 다시 읽는다.
        prefs = HomePrefs.model_validate({k: v for k, v in raw.items() if k not in ("theme", "accent")})
    # 버전 표식 없는 기존 행은 아직 부팅 이관(`_migrate_home_prefs_layout`) 전일 수 있다 — 여기서
    # 최신 버전을 찍어 저장하면 옛 그룹 id 가 변환 없이 "최신"으로 굳으므로 0 으로 유지한다.
    if "layout_version" not in raw:
        prefs.layout_version = 0
    return prefs


def to_out(prefs: HomePrefs, defaults: list[str]) -> HomePrefsOut:
    customized = isinstance(prefs.installed_apps, list)
    data = prefs.model_dump()
    data["installed_apps"] = list(prefs.installed_apps) if customized else list(defaults)
    data["installed_apps_customized"] = customized
    return HomePrefsOut.model_validate(data)


def apply_update(current: HomePrefs, payload: HomePrefsUpdate, defaults: list[str]) -> HomePrefs:
    """부분 업데이트 + installed_apps 연산 적용. 적용 순서: reset → 전체 교체 → remove → add → move."""
    fields = payload.model_dump(exclude_unset=True)
    simple = {k: fields[k] for k in ("default_home_tab", "pinned_paths", "locale", "theme", "accent") if k in fields}
    updated = current.model_copy(update=simple)

    apps: list[str] | None = list(updated.installed_apps) if isinstance(updated.installed_apps, list) else None
    touched = False
    if fields.get("installed_apps_reset"):
        apps = None
    if fields.get("installed_apps") is not None:
        apps = _clean_ids(fields["installed_apps"])
        touched = True
    remove = _clean_ids(fields.get("installed_apps_remove"))
    add = _clean_ids(fields.get("installed_apps_add"))
    if remove or add:
        # 기본값을 따르던 계정이 처음 손대는 순간 — 그때의 실효 목록을 기준으로 고정한다.
        base = apps if apps is not None else list(defaults)
        base = [a for a in base if a not in remove]
        for a in add:
            if a not in base:
                base.append(a)
        apps = base
        touched = True
    move = payload.installed_apps_move
    if move is not None:
        base = apps if apps is not None else list(defaults)
        if move.id in base:
            base = [a for a in base if a != move.id]
            idx = base.index(move.before) if move.before in base else len(base)
            base.insert(idx, move.id)
            apps = base
            touched = True
    if touched or fields.get("installed_apps_reset"):
        updated = updated.model_copy(update={"installed_apps": apps})
    return updated
