"""사이드바/상단바 설치 목록 행 단위 버전 이관(`_migrate_home_prefs_layout`).

회귀 배경: 예전 3단계 이관은 `app_settings` 전역 sentinel 로 1회 실행을 보장했다. sentinel 만
사라지면(운영 DB 를 가리킨 pytest cleanup, 구 백업 복원 등) 다음 배포 부팅에서 다시 돌아
개인화 안 한 계정엔 앱 42개가 전부 설치되고, 개인화한 계정은 고른 상단바 항목이 지워졌다.

핵심 계약:
1. 이미 leaf 모양인 행은 몇 번을 다시 돌아도 목록이 바뀌지 않는다(버전만 찍힌다).
2. home_prefs 행이 없는 계정은 만들지 않는다.
3. 옛 그룹 id 행만 leaf 로 펼치고 `/tasks-mgmt` 를 보장한다.
4. installed_apps 키가 없는 1단계 이전 행은 당시 사이드바 전체로 변환된다.
5. 최신 버전이 찍힌 행은 이후 사용자가 무엇을 하든(전부 제거 포함) 다시 건드리지 않는다.
6. 버전 없는 기존 행을 PUT 해도 버전이 몰래 최신으로 찍히지 않는다(이관 전 변환 누락 방지).
"""
import uuid

import pytest

from app.main import _migrate_home_prefs_layout
from app.routers import home_prefs as home_prefs_router
from app.schemas.home_prefs import HOME_PREFS_LAYOUT_VERSION, HomePrefsUpdate


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


@pytest.fixture
def cleanup(db):
    user_ids: list[str] = []
    yield user_ids
    from app.models.user import User
    from app.models.user_setting import UserSetting

    if user_ids:
        db.query(UserSetting).filter(UserSetting.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.commit()


def _user(db, cleanup, suffix: str):
    from app.models.user import User

    u = User(
        id=f"u-layout-{suffix}-{uuid.uuid4().hex[:8]}",
        username=f"layout-{suffix}-{uuid.uuid4().hex[:8]}",
        display_name=f"사용자 {suffix}",
        role="operator",
    )
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    return u


def _prefs(db, user_id):
    from app.services.user_settings import get_user_setting

    db.expire_all()
    return get_user_setting(db, user_id, "home_prefs", None)


def test_current_rows_survive_repeated_boots_unchanged(db, cleanup):
    from app.services.user_settings import set_user_setting

    u = _user(db, cleanup, "custom")
    mine = ["/k9s", "/tasks-mgmt", "/wbs", "favorites"]
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": mine, "pinned_paths": ["/k9s"]})

    for _ in range(3):
        _migrate_home_prefs_layout()

    value = _prefs(db, u.id)
    assert value["installed_apps"] == mine  # 상단바 항목(/wbs, favorites)도 지워지지 않는다
    assert value["pinned_paths"] == ["/k9s"]
    assert value["layout_version"] == HOME_PREFS_LAYOUT_VERSION


def test_user_without_row_is_not_backfilled(db, cleanup):
    u = _user(db, cleanup, "norow")

    _migrate_home_prefs_layout()

    assert _prefs(db, u.id) is None


def test_legacy_group_ids_expand_to_leaves(db, cleanup):
    from app.services.user_settings import set_user_setting

    u = _user(db, cleanup, "legacy")
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["storage", "back"]})

    _migrate_home_prefs_layout()

    value = _prefs(db, u.id)
    assert value["installed_apps"] == ["/mc", "/isilon-nfs", "back", "/tasks-mgmt"]
    assert value["layout_version"] == HOME_PREFS_LAYOUT_VERSION


def test_pre_v1_row_without_key_gets_legacy_full_sidebar(db, cleanup):
    from app.services.user_settings import set_user_setting

    u = _user(db, cleanup, "prev1")
    set_user_setting(db, u.id, "home_prefs", {"default_home_tab": "work"})

    _migrate_home_prefs_layout()

    value = _prefs(db, u.id)
    assert value["default_home_tab"] == "work"
    assert "/k9s" in value["installed_apps"] and "/settings" in value["installed_apps"]
    assert "back" in value["installed_apps"] and "/tasks-mgmt" in value["installed_apps"]


def test_versioned_row_is_never_touched_again(db, cleanup):
    from app.services.user_settings import set_user_setting

    u = _user(db, cleanup, "emptied")
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["cluster"]})
    _migrate_home_prefs_layout()
    # 이관 후 사용자가 전부 제거 — 재부팅이 되살리면 안 된다.
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": [], "layout_version": HOME_PREFS_LAYOUT_VERSION})

    _migrate_home_prefs_layout()

    assert _prefs(db, u.id)["installed_apps"] == []


def test_put_on_unversioned_row_does_not_stamp_latest(db, cleanup):
    from app.services.user_settings import set_user_setting

    u = _user(db, cleanup, "put-legacy")
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["network"]})

    res = home_prefs_router.update_home_prefs(HomePrefsUpdate(locale="en"), db=db, user=u)
    assert res.layout_version == 0
    _migrate_home_prefs_layout()

    value = _prefs(db, u.id)
    assert "/cilium-trace" in value["installed_apps"]
    assert value["locale"] == "en"


def test_put_on_new_row_stamps_latest(db, cleanup):
    u = _user(db, cleanup, "put-new")

    res = home_prefs_router.update_home_prefs(HomePrefsUpdate(installed_apps=["/k9s"]), db=db, user=u)

    assert res.layout_version == HOME_PREFS_LAYOUT_VERSION
    assert _prefs(db, u.id)["layout_version"] == HOME_PREFS_LAYOUT_VERSION
