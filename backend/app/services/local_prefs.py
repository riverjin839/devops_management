"""브라우저 로컬 개인 설정의 서버 동기화 — 그룹 접힘·화면별 보기 모드 등을 다른 PC 로도 따라오게 한다.

화면 40여 곳이 localStorage 에 개인 설정을 두는데(`frontend/src/lib/personalStorage.ts` 의 개인 키), 기기별이라
다른 PC 에서는 기본값으로 시작했다. 이 모듈은 그 키·값을 ``user_settings`` 의 ``local_prefs`` 한 행에 보관한다.

- 서버는 값을 해석하지 않는다 — 문자열 그대로 저장·반환한다. 키는 개인 키 접두사만 받고, 비밀이 섞이거나
  기기에 묶인 키(``EXCLUDED``)는 거절한다(화면 쪽 제외 목록과 같은 규칙).
- 쓰기는 델타(``set``/``remove``)다. 행 잠금 아래에서 합치므로 두 기기가 서로 다른 키를 바꿔도 덮지 않는다.
- ``rev`` 는 쓰기마다 1 씩 오른다. 화면은 마지막으로 맞춘 rev·값(기준본)과 비교해 3-way 로 합친다.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.user_setting import UserSetting

LOCAL_PREFS_KEY = "local_prefs"

KEY_RE = re.compile(r"^(k8s:|pep:|pep\.|cluster-links-)\S{1,200}$")
# 화면 lib/localPrefsSync.ts 의 SYNC_EXCLUDED 와 같은 규칙 — 기기 값·캐시·비밀 가능성이 있는 값.
EXCLUDED_EXACT = frozenset({
    "k8s:auth:token", "k8s:auth:user", "k8s:theme-migrated-light-default", "pep:profile-owner",
    "k8s:theme", "k8s:accent",            # home_prefs.theme/accent 가 원천
    "k8s:debug-flags-v1",
    "k8s:playbook-ssh-creds",
})
EXCLUDED_PREFIXES = (
    "pep:profile:",          # 다른 계정 보관본
    "k8s:img:work-item:",    # 붙여넣기 이미지 캐시(대용량)
    "pep:popout:",           # 팝아웃 창 상태
    "k8s:saved-cmd:",        # 저장 명령 — 자격증명이 섞일 수 있다
)
WIDTH_RE = re.compile(r"width", re.IGNORECASE)  # 창·패널 폭은 화면 크기를 따른다

MAX_VALUE_CHARS = 64 * 1024
MAX_TOTAL_CHARS = 512 * 1024
MAX_KEYS = 500


def is_syncable_key(key: Any) -> bool:
    if not isinstance(key, str) or not KEY_RE.match(key):
        return False
    if key in EXCLUDED_EXACT or key.startswith(EXCLUDED_PREFIXES) or WIDTH_RE.search(key):
        return False
    return True


def _empty() -> dict:
    return {"values": {}, "rev": 0, "updated_at": None}


def _load(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return _empty()
    values = raw.get("values")
    rev = raw.get("rev")
    return {
        "values": {k: v for k, v in values.items() if isinstance(v, str)} if isinstance(values, dict) else {},
        "rev": rev if isinstance(rev, int) and rev >= 0 else 0,
        "updated_at": raw.get("updated_at") if isinstance(raw.get("updated_at"), str) else None,
    }


def get_local_prefs(db: Session, user_id) -> dict:
    try:
        row = db.query(UserSetting).filter(UserSetting.user_id == user_id, UserSetting.key == LOCAL_PREFS_KEY).first()
    except Exception:  # noqa: BLE001 — 읽기 실패가 화면을 막으면 안 된다
        db.rollback()
        return _empty()
    return _load(row.value if row is not None else None)


class LocalPrefsTooLarge(ValueError):
    pass


def apply_delta(db: Session, user_id, set_values: Any, remove: Any) -> dict:
    """``set``/``remove`` 를 행 잠금 아래에서 합친다. 반환: 저장된 상태 + ``rejected``(받지 않은 키)."""
    set_values = set_values if isinstance(set_values, dict) else {}
    remove = remove if isinstance(remove, list) else []
    rejected: list[str] = []

    clean_set: dict[str, str] = {}
    for k, v in set_values.items():
        if not is_syncable_key(k) or not isinstance(v, str) or len(v) > MAX_VALUE_CHARS:
            rejected.append(str(k)[:200])
            continue
        clean_set[k] = v
    clean_remove = [k for k in remove if isinstance(k, str) and is_syncable_key(k)]

    # 행이 아직 없을 때 두 요청이 동시에 INSERT 하면 한쪽이 유니크 위반 — 그때는 생긴 행을 잠그고 다시 한다.
    for attempt in range(2):
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user_id, UserSetting.key == LOCAL_PREFS_KEY)
            .with_for_update()
            .first()
        )
        state = _load(row.value if row is not None else None)
        values = dict(state["values"])
        for k in clean_remove:
            values.pop(k, None)
        values.update(clean_set)
        if len(values) > MAX_KEYS or len(json.dumps(values, ensure_ascii=False)) > MAX_TOTAL_CHARS:
            db.rollback()
            raise LocalPrefsTooLarge(
                f"로컬 개인 설정이 너무 크다(최대 {MAX_KEYS}개·{MAX_TOTAL_CHARS // 1024}KB)"
            )
        changed = values != state["values"]
        new_state = {
            "values": values,
            "rev": state["rev"] + 1 if changed else state["rev"],
            "updated_at": datetime.now(timezone.utc).isoformat() if changed else state["updated_at"],
        }
        if not changed:
            db.rollback()
            return {**new_state, "rejected": rejected}
        try:
            if row is None:
                db.add(UserSetting(user_id=user_id, key=LOCAL_PREFS_KEY, value=new_state))
            else:
                row.value = new_state
            db.commit()
            return {**new_state, "rejected": rejected}
        except IntegrityError:
            db.rollback()
            if attempt == 1:
                raise
    raise RuntimeError("unreachable")
