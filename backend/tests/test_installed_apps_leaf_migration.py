"""사이드바/상단바 "leaf 단위 설치" 개편(2단계) — 기존 사용자 1회 이관
(`_migrate_installed_apps_to_leaf_paths`).

핵심 계약:
1. 그룹 단위 id(cluster 등)가 남아있으면 그 그룹의 leaf 페이지 목록으로 치환된다.
2. 상단바 업무 도메인(업무 관리/문서 관리 leaf + 즐겨찾기/Your Island)은 이 마이그레이션
   시점에 존재하던 모든 계정에 grandfather 로 추가된다(예전엔 상시노출이었으므로).
3. sentinel 이후 생성된 계정은 대상이 아니다(신규 계정은 완전히 빈 상태로 시작).
4. sentinel 이 있으면 두 번째 실행은 아무것도 하지 않는다(멱등 — 사용자가 직접 제거한
   항목을 되돌리지 않는다).
"""
import uuid

import pytest

from app.main import _migrate_installed_apps_to_leaf_paths

WORK_DOMAIN_GRANDFATHER = [
    "/tasks-mgmt", "/todo-today", "/sprints", "/members", "/workflow", "/wbs",
    "/weekly-report", "/jira-import",
    "/documents", "/work-guides", "/docs", "/ops-notes", "/mindmap", "/ontology", "/trends",
    "favorites", "island",
]


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
        id=f"u-leafmig-{suffix}-{uuid.uuid4().hex[:8]}",
        username=f"leafmig-{suffix}-{uuid.uuid4().hex[:8]}",
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
    db.query(AppSetting).filter(AppSetting.key == "installed_apps_leaf_migration_v2").delete(synchronize_session=False)
    db.commit()


def test_legacy_group_id_expands_to_leaf_paths(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("group")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["storage", "back"]})

    _migrate_installed_apps_to_leaf_paths()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert "/mc" in value["installed_apps"]
    assert "/isilon-nfs" in value["installed_apps"]
    assert "back" in value["installed_apps"]
    assert "storage" not in value["installed_apps"]


def test_existing_user_grandfathered_with_work_domain_leaves(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("grandfather")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["/cluster-overview"]})

    _migrate_installed_apps_to_leaf_paths()

    value = get_user_setting(db, u.id, "home_prefs", None)
    for leaf in WORK_DOMAIN_GRANDFATHER:
        assert leaf in value["installed_apps"]
    assert "/cluster-overview" in value["installed_apps"]


def test_user_without_installed_apps_key_still_grandfathered(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("nokey")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {"default_home_tab": "work"})

    _migrate_installed_apps_to_leaf_paths()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value["default_home_tab"] == "work"
    for leaf in WORK_DOMAIN_GRANDFATHER:
        assert leaf in value["installed_apps"]


def test_user_created_after_sentinel_stays_unmigrated(db, cleanup):
    from app.services.user_settings import get_user_setting

    _migrate_installed_apps_to_leaf_paths()  # sentinel 확정

    late_user = _user("after-sentinel")
    cleanup.append(late_user.id)
    db.add(late_user)
    db.commit()

    _migrate_installed_apps_to_leaf_paths()  # 이미 sentinel 있으니 no-op

    value = get_user_setting(db, late_user.id, "home_prefs", None)
    assert value is None


def test_migration_is_idempotent_and_does_not_undo_user_removal(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("idempotent")
    cleanup.append(u.id)
    db.add(u)
    db.commit()

    _migrate_installed_apps_to_leaf_paths()
    # 마이그레이션 후 사용자가 직접 즐겨찾기를 껐다고 가정 — 재실행이 되돌리면 안 된다.
    value = get_user_setting(db, u.id, "home_prefs", None)
    remaining = [a for a in value["installed_apps"] if a != "favorites"]
    set_user_setting(db, u.id, "home_prefs", {**value, "installed_apps": remaining})

    _migrate_installed_apps_to_leaf_paths()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert "favorites" not in value["installed_apps"]
