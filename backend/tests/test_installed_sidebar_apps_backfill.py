"""사이드바 "SaaS 앱" opt-in 개편 — 기존 사용자 1회 이관(`_backfill_installed_sidebar_apps`).

핵심 계약:
1. home_prefs 가 아예 없던 사용자도 기본 설치 목록을 받는다.
2. home_prefs 는 있지만 installed_apps 키가 없던 사용자도 기본 목록으로 보강된다.
3. 이미 installed_apps 를 가진 사용자(이 마이그레이션 이후 스스로 설정)는 건드리지 않는다.
4. sentinel 이 있으면 두 번째 실행은 아무것도 하지 않는다(멱등).
"""
import uuid

import pytest

from app.main import _backfill_installed_sidebar_apps


@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _user(suffix: str):
    from app.models.user import User

    return User(
        id=f"u-backfill-{suffix}-{uuid.uuid4().hex[:8]}",
        username=f"backfill-{suffix}-{uuid.uuid4().hex[:8]}",
        display_name=f"사용자 {suffix}",
        role="operator",
    )


@pytest.fixture
def cleanup(db):
    user_ids: list[str] = []
    yield user_ids
    from app.models.app_setting import AppSetting
    from app.models.user import User
    from app.models.user_setting import UserSetting

    if user_ids:
        db.query(UserSetting).filter(UserSetting.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.commit()
    db.query(AppSetting).filter(AppSetting.key == "installed_sidebar_apps_backfilled_v1").delete(synchronize_session=False)
    db.commit()


def test_backfill_creates_home_prefs_for_user_without_any(db, cleanup):
    from app.services.user_settings import get_user_setting

    u = _user("none")
    cleanup.append(u.id)
    db.add(u)
    db.commit()

    _backfill_installed_sidebar_apps()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value is not None
    assert value["installed_apps"] == ["cluster", "server", "network", "storage", "services", "devops", "system", "back"]


def test_backfill_adds_key_without_clobbering_existing_home_prefs_fields(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("partial")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {"default_home_tab": "work", "pinned_paths": ["/k9s"]})

    _backfill_installed_sidebar_apps()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value["default_home_tab"] == "work"
    assert value["pinned_paths"] == ["/k9s"]
    assert "installed_apps" in value


def test_backfill_does_not_overwrite_already_configured_installed_apps(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("configured")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["cluster"]})

    _backfill_installed_sidebar_apps()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value["installed_apps"] == ["cluster"]


def test_backfill_is_idempotent_via_sentinel(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("sentinel")
    cleanup.append(u.id)
    db.add(u)
    db.commit()

    _backfill_installed_sidebar_apps()
    # 첫 실행 후 사용자가 직접 앱을 전부 제거했다고 가정 — 두 번째 실행이 되돌리면 안 된다.
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": []})

    _backfill_installed_sidebar_apps()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value["installed_apps"] == []
