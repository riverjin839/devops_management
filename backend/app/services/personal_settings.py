"""개인 설정 내보내기/가져오기 — 환경 이전(새 클러스터 배포·새 PC)에 내 설정만 옮긴다.

전체 DB 백업(`backup_service`)은 admin 전용이고 모든 사람의 데이터를 담는다. 이 모듈은 로그인한
사용자 **본인**의 `user_settings` 중 이식 가능한 키만 다룬다.

- 허용 목록(`EXPORTABLE_KEYS`)에 있는 키만 내보내고, 가져올 때도 그 키만 받는다 — 각 키는 해당
  기능의 정규화 함수를 거쳐 저장되므로 손으로 고친 파일이 이상한 값을 넣지 못한다.
- 비밀이 섞인 키는 제외한다: `mc_presets`(MinIO 별칭 비밀번호), Jira 자격증명(별도 테이블).
- 브라우저에만 있는 개인 설정(테마·접힘 상태 등)은 화면이 같은 파일의 ``local`` 에 담아 직접
  읽고 쓴다 — 서버는 그 부분을 저장하지도 해석하지도 않는다.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.schemas.home_prefs import HomePrefs
from app.services.user_settings import get_user_setting, set_user_setting

FORMAT = "pep-personal-settings"
FORMAT_VERSION = 1


def _norm_home_prefs(raw: Any) -> dict:
    prefs = HomePrefs.model_validate(raw if isinstance(raw, dict) else {})
    out = prefs.model_dump()
    # 옛 레이아웃 파일이면 버전을 그대로 둬 다음 부팅 이관이 변환하게 한다(표식 없음 = 0).
    if not (isinstance(raw, dict) and isinstance(raw.get("layout_version"), int)):
        out["layout_version"] = 0
    return out


def _norm_terminal_appearance(raw: Any) -> dict:
    # 정규화 규칙의 원천은 해당 라우터다 — 순환 import 를 피하려고 지연 import.
    from app.routers.terminal_appearance import _normalize_appearance

    return _normalize_appearance(raw)


def _norm_jira_preset(raw: Any) -> dict:
    from app.routers.jira import normalize_provision_preset

    return normalize_provision_preset(raw)


# key → (화면 표시 이름, 정규화 함수)
EXPORTABLE_KEYS: dict[str, tuple[str, Callable[[Any], dict]]] = {
    "home_prefs": ("홈·사이드바·즐겨찾기", _norm_home_prefs),
    "terminal_appearance": ("터미널/로그 화면 색상", _norm_terminal_appearance),
    "jira_provision_preset": ("Jira 생성 기본값", _norm_jira_preset),
}


def export_settings(db: Session, user) -> dict:
    server: dict[str, Any] = {}
    for key in EXPORTABLE_KEYS:
        value = get_user_setting(db, user.id, key, None)
        if value is not None:
            server[key] = value
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "username": user.username,
        "server": server,
    }


def import_settings(db: Session, user, payload: dict) -> dict:
    """``payload`` 는 내보낸 파일 전체 또는 그 ``server`` 부분. 반환: 적용/건너뜀 키 목록."""
    if not isinstance(payload, dict):
        raise ValueError("설정 파일 형식이 아니다")
    if "format" in payload and payload.get("format") != FORMAT:
        raise ValueError(f"지원하지 않는 파일 형식: {payload.get('format')}")
    version = payload.get("version", FORMAT_VERSION)
    if isinstance(version, int) and version > FORMAT_VERSION:
        raise ValueError(f"더 새 버전에서 내보낸 파일이다(v{version}) — 이 서버는 v{FORMAT_VERSION} 까지 읽는다")
    server = payload.get("server", payload)
    if not isinstance(server, dict):
        raise ValueError("server 항목이 객체가 아니다")

    applied: list[str] = []
    skipped: list[str] = []
    for key, value in server.items():
        spec = EXPORTABLE_KEYS.get(key)
        if spec is None:
            skipped.append(key)
            continue
        try:
            normalized = spec[1](value)
        except Exception as e:  # noqa: BLE001 — 한 키가 깨져도 나머지는 적용
            skipped.append(f"{key} ({type(e).__name__})")
            continue
        set_user_setting(db, user.id, key, normalized)
        applied.append(key)
    return {"applied": applied, "skipped": skipped}
