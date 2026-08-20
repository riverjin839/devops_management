"""담당자 명부 → 로그인 계정 통합.

과거에는 담당자 명부가 ``app_settings`` 의 JSON blob 이고, 사번이 있는 담당자만
별도 로그인 계정(``User``)으로 단방향 provisioning 됐다(생성 전용 — 명부를 고쳐도
이미 만든 계정은 갱신되지 않고, 삭제되지도 않았다). 지금은 ``users`` 테이블 자체가
명부다 — 담당자 필드(이름/사번/이메일/IP/좌석/역할)와 로그인 필드(username/
hashed_password/role/is_active) 가 한 행에 함께 있다(``models/user.py`` 참고).

이 모듈은 그 구(舊) JSON 명부를 ``users`` 테이블로 흡수하는 1회성 마이그레이션만
담당한다(``main.py`` 부팅 시퀀스에서 한 번 호출). 이후 담당자 CRUD 는
``routers/ui_settings.py`` 가 ``users`` 테이블을 직접 다룬다.
"""
import logging

from sqlalchemy.orm import Session

from app.models.user import User
from app.auth.security import hash_password

_log = logging.getLogger("k8s_monitor.assignee_accounts")

# 사번이 있는 담당자에게 자동 부여하는 기본 로그인 권한.
ASSIGNEE_ACCOUNT_ROLE = "operator"


def _normalize_legacy_entry(a) -> dict | None:
    """구 JSON 담당자 항목(문자열 또는 dict)을 정규화. 이름이 없으면 None."""
    if isinstance(a, str):
        name = a.strip()
        return {"name": name, "employee_id": None, "email": None, "ip": None,
                "seat_location": None, "primary_role": None, "secondary_role": None} if name else None
    if isinstance(a, dict):
        name = str(a.get("name", "")).strip()
        if not name:
            return None
        def _s(*keys) -> str | None:
            for k in keys:
                v = a.get(k)
                if v is not None and str(v).strip():
                    return str(v).strip()
            return None
        return {
            "name": name,
            "employee_id": _s("employeeId", "employee_id"),
            "email": _s("email"),
            "ip": _s("ip"),
            "seat_location": _s("seatLocation", "seat_location"),
            "primary_role": _s("primaryRole", "primary_role"),
            "secondary_role": _s("secondaryRole", "secondary_role"),
        }
    return None


def migrate_legacy_roster_into_users(db: Session, raw_entries: list) -> dict:
    """구 JSON 담당자 명부 항목들을 ``users`` 테이블 행으로 흡수(멱등).

    - 사번이 있는 항목: 기존 계정(``employee_id`` 또는 레거시 ``username`` 매칭)을 찾아
      명부 필드만 갱신하고, 없으면 operator 로그인 계정을 새로 만든다(초기 비밀번호=사번 —
      구 ``sync_assignee_accounts`` 와 동일 규칙).
    - 사번이 없는 항목: 로그인 없는 순수 명부 행. 같은 이름(사번 없음)의 기존 행이 있으면
      갱신, 없으면 새로 만든다.

    한 항목 처리 실패가 나머지 항목 흡수를 막지 않도록 항목별 commit/rollback 격리.
    """
    migrated: list[str] = []
    errors: list[str] = []

    entries = [n for a in (raw_entries or []) if (n := _normalize_legacy_entry(a)) is not None]
    if not entries:
        return {"migrated": migrated, "errors": errors}

    for e in entries:
        try:
            emp = e["employee_id"]
            user = None
            if emp:
                user = db.query(User).filter(
                    (User.employee_id == emp) | (User.username == emp)
                ).first()
            else:
                user = db.query(User).filter(
                    User.employee_id.is_(None), User.display_name == e["name"],
                ).first()

            if user is None:
                user = User(display_name=e["name"], role=ASSIGNEE_ACCOUNT_ROLE if emp else "viewer")
                if emp:
                    user.username = emp
                    user.hashed_password = hash_password(emp)
                db.add(user)

            user.display_name = e["name"]
            user.employee_id = emp
            user.email = e["email"]
            user.ip = e["ip"]
            user.seat_location = e["seat_location"]
            user.primary_role = e["primary_role"]
            user.secondary_role = e["secondary_role"]
            db.commit()
            migrated.append(e["name"])
        except Exception as ex:  # noqa: BLE001
            db.rollback()
            errors.append(e["name"])
            _log.warning("assignee roster migration failed for %s (%s) — continuing", e["name"], ex)

    return {"migrated": migrated, "errors": errors}
