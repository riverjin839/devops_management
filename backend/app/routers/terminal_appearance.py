"""터미널/로그 화면 Appearance 설정.

모든 로그 출력 화면(LogViewer)이 공유하는 글꼴/색상 테마를 사용자별로 관리한다.
- personal: user_settings 의 ``terminal_appearance`` (mode/개발·운영 프로파일/개인 커스텀 템플릿).
- shared:   admin 이 배포한 공용 색상 템플릿 (app_settings 의 ``terminal_themes_shared``).

색상 템플릿(PuTTY/SecureCRT/Tera Term 등) 의 기본 카탈로그는 프론트엔드 상수로
정의되며, 백엔드는 사용자의 '선택' 과 '개인/공용 커스텀 템플릿' 만 저장한다.

NOTE: 프론트 axios 인터셉터가 요청 본문을 snake_case 로, 응답을 camelCase 로
자동 변환하므로 이 라우터는 **snake_case** 키로 송수신한다 (template_id/font_size 등).
"""
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User
from app.auth.deps import get_current_user, require_admin
from app.services.user_settings import get_user_setting, set_user_setting

router = APIRouter(prefix="/terminal-appearance", tags=["terminal-appearance"])

PERSONAL_KEY = "terminal_appearance"
SHARED_KEY = "terminal_themes_shared"

_VALID_MODES = {"auto", "dev", "ops"}


# 사용자가 아무것도 설정하지 않았을 때의 기본값. template_id='' 는 프론트의
# "기본 (테마 색상)" 템플릿을 의미한다. font_size 13px.
def _default_appearance() -> dict:
    return {
        "mode": "auto",
        "profiles": {
            "dev": {"template_id": "", "font_size": 13, "font_family": "", "colors": {}},
            "ops": {"template_id": "", "font_size": 13, "font_family": "", "colors": {}},
        },
        "custom_templates": [],
    }


def _normalize_profile(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {"template_id": "", "font_size": 13, "font_family": "", "colors": {}}
    try:
        font_size = int(raw.get("font_size", 13))
    except (TypeError, ValueError):
        font_size = 13
    font_size = max(9, min(28, font_size))
    colors = raw.get("colors")
    return {
        "template_id": str(raw.get("template_id") or ""),
        "font_size": font_size,
        "font_family": str(raw.get("font_family") or ""),
        "colors": {str(k): str(v) for k, v in colors.items()} if isinstance(colors, dict) else {},
    }


def _normalize_template(raw: Any) -> dict | None:
    if not isinstance(raw, dict) or not raw.get("id"):
        return None
    palette = raw.get("palette")
    return {
        "id": str(raw["id"]),
        "name": str(raw.get("name") or raw["id"]),
        "group": str(raw.get("group") or "커스텀"),
        "palette": {str(k): str(v) for k, v in palette.items()} if isinstance(palette, dict) else {},
    }


def _normalize_appearance(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return _default_appearance()
    mode = raw.get("mode")
    profiles_raw = raw.get("profiles") if isinstance(raw.get("profiles"), dict) else {}
    templates = [n for t in (raw.get("custom_templates") or []) if (n := _normalize_template(t))]
    return {
        "mode": mode if mode in _VALID_MODES else "auto",
        "profiles": {
            "dev": _normalize_profile(profiles_raw.get("dev")),
            "ops": _normalize_profile(profiles_raw.get("ops")),
        },
        "custom_templates": templates,
    }


def _read_shared(db: Session) -> list[dict]:
    row = db.query(AppSetting).filter(AppSetting.key == SHARED_KEY).first()
    value = (row.value if row else None) or {}
    templates = value.get("templates") if isinstance(value, dict) else None
    out: list[dict] = []
    if isinstance(templates, list):
        for t in templates:
            n = _normalize_template(t)
            if n:
                out.append(n)
    return out


@router.get("")
def get_appearance(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    personal = _normalize_appearance(get_user_setting(db, user.id, PERSONAL_KEY, None))
    return {"appearance": personal, "shared": _read_shared(db)}


@router.put("")
def update_appearance(payload: dict, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    value = _normalize_appearance(payload.get("appearance", payload))
    set_user_setting(db, user.id, PERSONAL_KEY, value)
    return {"appearance": value, "shared": _read_shared(db)}


@router.get("/shared")
def get_shared(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return {"templates": _read_shared(db)}


@router.put("/shared")
def update_shared(payload: dict, db: Session = Depends(get_db),
                  _: User = Depends(require_admin)):
    """공용 색상 템플릿 배포 — admin 전용."""
    raw_templates = payload.get("templates", payload if isinstance(payload, list) else [])
    seen: set[str] = set()
    cleaned: list[dict] = []
    for t in raw_templates if isinstance(raw_templates, list) else []:
        n = _normalize_template(t)
        if n and n["id"] not in seen:
            seen.add(n["id"])
            cleaned.append(n)
    row = db.query(AppSetting).filter(AppSetting.key == SHARED_KEY).first()
    if row is None:
        row = AppSetting(key=SHARED_KEY, value={"templates": cleaned})
        db.add(row)
    else:
        row.value = {"templates": cleaned}
    db.commit()
    return {"templates": cleaned}
