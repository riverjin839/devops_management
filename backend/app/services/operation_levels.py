"""운영레벨(operation level) 설정 — 저장 키·기본값과 보호(guarded) 판정.

설정 행은 AppSetting ``operation_levels`` 이고, 편집 API 는 ``routers/ui_settings.py``
(`GET/PUT /ui-settings/operation-levels`)가 담당한다. 보호 판정은 여러 라우터(k9s SSH 의
``--readonly`` 강제, 클러스터 생성·수정의 admin 게이트)가 함께 쓰므로 라우터가 아니라 여기 둔다.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.app_setting import AppSetting
from app.schemas.ui_settings import default_guarded

OPERATION_LEVELS_KEY = "operation_levels"

DEFAULT_OPERATION_LEVELS = {
    "levels": [
        {"value": "production", "label": "운영 (Production)", "color": "red",    "icon": "🚀", "guarded": True},
        {"value": "staging",    "label": "스테이징 (Staging)", "color": "amber",  "icon": "✨", "guarded": False},
        {"value": "dev",        "label": "개발 (Dev)",         "color": "blue",   "icon": "💻", "guarded": False},
        {"value": "test",       "label": "테스트 (Test)",      "color": "slate",  "icon": "🧪", "guarded": False},
        {"value": "dr",         "label": "DR",                 "color": "purple", "icon": "🛡️", "guarded": True},
    ]
}


def is_operation_level_guarded(db: Session, level: str | None) -> bool:
    """운영레벨 ``level`` 이 보호(guarded) 레벨인지 — `GET /ui-settings/operation-levels` 와 같은 해석.

    저장된 레벨 목록(AppSetting ``operation_levels``)에서 value 가 같은 항목의 ``guarded`` 를 쓰고,
    값이 없거나(구버전 데이터)·목록에 없는 레벨·저장값이 비었으면 ``default_guarded``(production·dr)로
    본다. 읽기 전용 — 설정 행을 만들지 않는다. 빈 레벨은 보호 아님.
    """
    v = (level or "").strip()
    if not v:
        return False
    try:
        setting = db.query(AppSetting).filter(AppSetting.key == OPERATION_LEVELS_KEY).first()
    except Exception:  # noqa: BLE001 — 조회 실패 시 기본 규칙으로 판정
        db.rollback()
        return default_guarded(v)
    raw = (setting.value or {}).get("levels", []) if setting is not None else []
    stored = [it for it in raw if isinstance(it, dict) and str(it.get("value", "")).strip()]
    if not stored:
        stored = DEFAULT_OPERATION_LEVELS["levels"]
    for it in stored:
        if str(it.get("value", "")).strip() == v:
            g = it.get("guarded")
            return g if isinstance(g, bool) else default_guarded(v)
    return default_guarded(v)
