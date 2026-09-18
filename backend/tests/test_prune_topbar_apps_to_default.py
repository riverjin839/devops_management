"""상단바 "leaf 단위 설치" 개편(3단계) — 기본 노출을 `/tasks-mgmt`("업무 관리") 하나로
줄이는 1회 이관(`_prune_topbar_apps_to_default`).

핵심 계약:
1. `/tasks-mgmt` 를 제외한 업무 도메인 leaf(오늘 할 일 등)·문서 관리 leaf·즐겨찾기·
   Your Island 는 제거된다.
2. 사이드바(platform/system 도메인) 설치 항목·`back` 은 그대로 보존된다.
3. home_prefs 행이 없는 사용자는 건드리지 않는다.
4. sentinel 이후 생성된 계정은 대상이 아니다.
5. sentinel 이 있으면 두 번째 실행은 아무것도 하지 않는다(멱등 — 사용자가 직접 다시 설치한
   항목을 되돌리지 않는다).
"""
import uuid

import pytest

from app.main import _prune_topbar_apps_to_default


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
        id=f"u-prune-{suffix}-{uuid.uuid4().hex[:8]}",
        username=f"prune-{suffix}-{uuid.uuid4().hex[:8]}",
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
    db.query(AppSetting).filter(AppSetting.key == "installed_apps_topbar_default_v3").delete(synchronize_session=False)
    db.commit()


def test_prunes_topbar_extras_but_keeps_task_board(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("full")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {
        "installed_apps": [
            "/cluster-overview", "back",
            "/tasks-mgmt", "/todo-today", "/sprints", "/members", "/workflow", "/wbs",
            "/weekly-report", "/jira-import",
            "/documents", "/work-guides", "/docs", "/ops-notes", "/mindmap", "/ontology", "/trends",
            "favorites", "island",
        ],
    })

    _prune_topbar_apps_to_default()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value["installed_apps"] == ["/cluster-overview", "back", "/tasks-mgmt"]


def test_user_without_home_prefs_row_untouched(db, cleanup):
    from app.services.user_settings import get_user_setting

    u = _user("norow")
    cleanup.append(u.id)
    db.add(u)
    db.commit()

    _prune_topbar_apps_to_default()

    assert get_user_setting(db, u.id, "home_prefs", None) is None


def test_user_created_after_sentinel_stays_unpruned(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    _prune_topbar_apps_to_default()  # sentinel 확정

    late_user = _user("after-sentinel")
    cleanup.append(late_user.id)
    db.add(late_user)
    db.commit()
    set_user_setting(db, late_user.id, "home_prefs", {"installed_apps": ["/tasks-mgmt", "favorites"]})

    _prune_topbar_apps_to_default()  # sentinel 있으니 no-op

    value = get_user_setting(db, late_user.id, "home_prefs", None)
    assert value["installed_apps"] == ["/tasks-mgmt", "favorites"]


def test_idempotent_does_not_restore_user_removed_item(db, cleanup):
    from app.services.user_settings import get_user_setting, set_user_setting

    u = _user("idempotent")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": ["/tasks-mgmt", "favorites"]})

    _prune_topbar_apps_to_default()
    # 첫 실행 후 사용자가 직접 /tasks-mgmt 마저 지웠다고 가정 — 두 번째 실행이 되돌리면 안 된다.
    set_user_setting(db, u.id, "home_prefs", {"installed_apps": []})

    _prune_topbar_apps_to_default()

    value = get_user_setting(db, u.id, "home_prefs", None)
    assert value["installed_apps"] == []
