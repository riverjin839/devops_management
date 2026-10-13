"""홈/네비게이션 개인화(home_prefs) 라우터 테스트.

핵심 계약:
1. 미저장 상태는 빈 기본값(HomePrefs())을 돌려준다 — 404/None 이 아니다.
2. PUT은 부분 업데이트 — 보내지 않은 필드는 기존 값을 보존한다.
3. 사용자별로 격리된다 — 남의 home_prefs 를 보거나 건드릴 수 없다.
"""
import uuid

import pytest

from app.routers import home_prefs as home_prefs_router
from app.schemas.home_prefs import HomePrefsUpdate


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
        id=f"u-{suffix}-{uuid.uuid4().hex[:8]}",
        username=f"user-{suffix}",
        display_name=f"사용자 {suffix}",
        role="operator",
    )


@pytest.fixture
def me():
    return _user("me")


@pytest.fixture
def other():
    return _user("other")


@pytest.fixture
def cleanup(db):
    user_ids: list[str] = []
    yield user_ids
    from app.models.user_setting import UserSetting

    if user_ids:
        from app.models.user import User

        db.query(UserSetting).filter(UserSetting.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.commit()


def test_get_without_prior_save_returns_defaults(db, me, cleanup):
    cleanup.append(me.id)
    prefs = home_prefs_router.get_home_prefs(db=db, user=me)
    assert prefs.default_home_tab is None
    assert prefs.pinned_paths == []


def test_put_then_get_roundtrips(db, me, cleanup):
    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(default_home_tab="platform", pinned_paths=["/k9s", "/tasks-mgmt"]),
        db=db, user=me,
    )
    prefs = home_prefs_router.get_home_prefs(db=db, user=me)
    assert prefs.default_home_tab == "platform"
    assert prefs.pinned_paths == ["/k9s", "/tasks-mgmt"]


def test_put_is_partial_and_preserves_unset_fields(db, me, cleanup):
    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(default_home_tab="work", pinned_paths=["/etcdctl"]),
        db=db, user=me,
    )
    # pinned_paths 를 보내지 않은 업데이트 — default_home_tab 만 바뀌고 기존 pinned_paths 는 유지.
    updated = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(default_home_tab="platform"),
        db=db, user=me,
    )
    assert updated.default_home_tab == "platform"
    assert updated.pinned_paths == ["/etcdctl"]


def test_locale_partial_update_preserves_other_fields(db, me, cleanup):
    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(default_home_tab="platform", pinned_paths=["/k9s"]),
        db=db, user=me,
    )
    updated = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(locale="en"),
        db=db, user=me,
    )
    assert updated.locale == "en"
    assert updated.default_home_tab == "platform"
    assert updated.pinned_paths == ["/k9s"]


def test_installed_apps_partial_update_preserves_other_fields(db, me, cleanup):
    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(default_home_tab="platform", locale="en"),
        db=db, user=me,
    )
    updated = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(installed_apps=["cluster", "back"]),
        db=db, user=me,
    )
    assert updated.installed_apps == ["cluster", "back"]
    assert updated.default_home_tab == "platform"
    assert updated.locale == "en"


def test_installed_apps_defaults_to_task_board_only(db, me, cleanup):
    """신규 계정 기본값은 사이드바는 완전히 비어있고, 상단바는 "업무 관리"(`/tasks-mgmt`)
    하나만 미리 설치된 상태다 — 나머지는 전부 사용자가 `+` 로 직접 추가해야 한다."""
    cleanup.append(me.id)
    prefs = home_prefs_router.get_home_prefs(db=db, user=me)
    assert prefs.installed_apps == ["/tasks-mgmt"]
    assert prefs.installed_apps_customized is False


def test_prefs_are_isolated_per_user(db, me, other, cleanup):
    cleanup.append(me.id)
    cleanup.append(other.id)
    home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(default_home_tab="platform", pinned_paths=["/k9s"]),
        db=db, user=me,
    )
    other_prefs = home_prefs_router.get_home_prefs(db=db, user=other)
    assert other_prefs.default_home_tab is None
    assert other_prefs.pinned_paths == []


# ── 설치 앱: 기본값 따름 / 사용자 지정 / 델타 연산 / 초기화 / 조직 기본값 ─────────────

@pytest.fixture
def org_defaults(db):
    """조직 기본값 행을 테스트 동안만 둔다 — 공유 테스트 DB 의 다른 테스트에 새지 않게."""
    from app.models.app_setting import AppSetting
    from app.services.home_prefs import DEFAULTS_KEY

    def _clear():
        db.query(AppSetting).filter(AppSetting.key == DEFAULTS_KEY).delete(synchronize_session=False)
        db.commit()

    _clear()
    yield
    _clear()


def test_new_account_follows_org_default_until_it_customizes(db, me, cleanup, org_defaults):
    from app.services.home_prefs import set_default_installed_apps

    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(payload=HomePrefsUpdate(locale="en"), db=db, user=me)
    prefs = home_prefs_router.get_home_prefs(db=db, user=me)
    assert prefs.installed_apps_customized is False
    assert prefs.installed_apps == ["/tasks-mgmt"]

    # admin 이 조직 기본값을 바꾸면 개인화 안 한 계정에 즉시 반영된다.
    set_default_installed_apps(db, ["/tasks-mgmt", "/k9s"])
    assert home_prefs_router.get_home_prefs(db=db, user=me).installed_apps == ["/tasks-mgmt", "/k9s"]


def test_delta_ops_customize_from_effective_list(db, me, cleanup, org_defaults):
    from app.services.home_prefs import set_default_installed_apps

    cleanup.append(me.id)
    set_default_installed_apps(db, ["/tasks-mgmt", "/k9s"])
    updated = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(installed_apps_add=["/wbs"], installed_apps_remove=["/k9s"]), db=db, user=me,
    )
    assert updated.installed_apps == ["/tasks-mgmt", "/wbs"]
    assert updated.installed_apps_customized is True

    # 이후 조직 기본값이 바뀌어도 사용자 지정 목록은 그대로다.
    set_default_installed_apps(db, ["/settings"])
    assert home_prefs_router.get_home_prefs(db=db, user=me).installed_apps == ["/tasks-mgmt", "/wbs"]


def test_concurrent_style_deltas_do_not_overwrite_each_other(db, me, cleanup, org_defaults):
    """두 기기가 같은 옛 목록을 보고 각자 하나씩 추가해도 둘 다 남는다(전체 교체였다면 하나 유실)."""
    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(payload=HomePrefsUpdate(installed_apps_add=["/a"]), db=db, user=me)
    home_prefs_router.update_home_prefs(payload=HomePrefsUpdate(installed_apps_add=["/b"]), db=db, user=me)
    home_prefs_router.update_home_prefs(payload=HomePrefsUpdate(installed_apps_add=["/a"]), db=db, user=me)
    assert home_prefs_router.get_home_prefs(db=db, user=me).installed_apps == ["/tasks-mgmt", "/a", "/b"]


def test_reset_returns_to_org_default(db, me, cleanup, org_defaults):
    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(payload=HomePrefsUpdate(installed_apps=["/k9s"], locale="en"), db=db, user=me)
    updated = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(installed_apps_reset=True), db=db, user=me,
    )
    assert updated.installed_apps_customized is False
    assert updated.installed_apps == ["/tasks-mgmt"]
    assert updated.locale == "en"


def test_org_default_update_is_admin_audited(db, cleanup, org_defaults):
    from app.models.audit_log import AuditLog
    from app.models.user import User
    from app.routers import ui_settings
    from app.schemas.home_prefs import HomePrefsDefaults

    admin = User(id=f"u-admin-{uuid.uuid4().hex[:8]}", username=f"admin-{uuid.uuid4().hex[:8]}", role="admin")
    cleanup.append(admin.id)
    res = ui_settings.update_home_prefs_defaults(
        payload=HomePrefsDefaults(installed_apps=["/tasks-mgmt", "/k9s", "/k9s"]),
        request=None, db=db, actor=admin,
    )
    assert res.installed_apps == ["/tasks-mgmt", "/k9s"]
    assert ui_settings.get_home_prefs_defaults(db=db, _=admin).installed_apps == ["/tasks-mgmt", "/k9s"]
    log = (
        db.query(AuditLog)
        .filter(AuditLog.action == "settings.home_prefs_defaults.update", AuditLog.actor_username == admin.username)
        .first()
    )
    assert log is not None and log.details["added"] == ["/k9s"]
    db.query(AuditLog).filter(AuditLog.actor_username == admin.username).delete(synchronize_session=False)
    db.commit()


def test_deleting_user_removes_their_settings(db, cleanup):
    from app.models.user import User
    from app.routers import auth
    from app.services.user_settings import get_user_setting, set_user_setting

    admin = User(id=f"u-adm-{uuid.uuid4().hex[:8]}", username=f"adm-{uuid.uuid4().hex[:8]}", role="admin")
    victim = User(id=f"u-del-{uuid.uuid4().hex[:8]}", username=f"del-{uuid.uuid4().hex[:8]}", role="operator")
    cleanup.extend([admin.id, victim.id])
    db.add_all([admin, victim])
    db.commit()
    set_user_setting(db, victim.id, "home_prefs", {"installed_apps": ["/k9s"]})

    auth.delete_user(user_id=victim.id, request=None, db=db, actor=admin)

    assert get_user_setting(db, victim.id, "home_prefs", None) is None


# ── 순서 변경(move) ───────────────────────────────────────────────────────────

def test_move_reorders_one_item(db, me, cleanup, org_defaults):
    from app.schemas.home_prefs import InstalledAppMove

    cleanup.append(me.id)
    home_prefs_router.update_home_prefs(payload=HomePrefsUpdate(installed_apps=["/a", "/b", "/c"]), db=db, user=me)
    moved = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(installed_apps_move=InstalledAppMove(id="/c", before="/a")), db=db, user=me,
    )
    assert moved.installed_apps == ["/c", "/a", "/b"]
    to_end = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(installed_apps_move=InstalledAppMove(id="/c")), db=db, user=me,
    )
    assert to_end.installed_apps == ["/a", "/b", "/c"]
    # 없는 항목 이동은 무시(다른 기기에서 막 제거된 경우).
    same = home_prefs_router.update_home_prefs(
        payload=HomePrefsUpdate(installed_apps_move=InstalledAppMove(id="/zzz", before="/a")), db=db, user=me,
    )
    assert same.installed_apps == ["/a", "/b", "/c"]


# ── 개인 설정 내보내기 / 가져오기 ──────────────────────────────────────────────

def _user_row(db, cleanup, prefix: str):
    from app.models.user import User

    u = User(id=f"u-{prefix}-{uuid.uuid4().hex[:8]}", username=f"{prefix}-{uuid.uuid4().hex[:8]}", role="operator")
    cleanup.append(u.id)
    db.add(u)
    db.commit()
    return u


def test_export_then_import_moves_settings_to_another_account(db, cleanup):
    import json

    from app.services.user_settings import get_user_setting, set_user_setting

    src = _user_row(db, cleanup, "exp-src")
    dst = _user_row(db, cleanup, "exp-dst")
    set_user_setting(db, src.id, "home_prefs", {"installed_apps": ["/k9s"], "pinned_paths": ["/wbs"], "layout_version": 3})
    set_user_setting(db, src.id, "mc_presets", {"presets": [{"alias": "x", "password": "secret"}]})

    doc = home_prefs_router.export_personal_settings(db=db, user=src)["document"]
    parsed = json.loads(doc)
    assert parsed["format"] == "pep-personal-settings"
    assert "mc_presets" not in parsed["server"]  # 비밀이 섞인 키는 내보내지 않는다
    assert "secret" not in doc

    result = home_prefs_router.import_personal_settings(
        payload=home_prefs_router.SettingsImportRequest(document=doc), request=None, db=db, user=dst,
    )
    assert "home_prefs" in result["applied"]
    value = get_user_setting(db, dst.id, "home_prefs", None)
    assert value["installed_apps"] == ["/k9s"] and value["pinned_paths"] == ["/wbs"]


def test_import_ignores_unknown_keys_and_rejects_foreign_format(db, cleanup):
    import json

    from fastapi import HTTPException

    from app.services.user_settings import get_user_setting

    u = _user_row(db, cleanup, "imp")
    doc = json.dumps({"format": "pep-personal-settings", "version": 1, "server": {
        "mc_presets": {"presets": []}, "home_prefs": {"pinned_paths": ["/k9s"]},
    }})
    result = home_prefs_router.import_personal_settings(
        payload=home_prefs_router.SettingsImportRequest(document=doc), request=None, db=db, user=u,
    )
    assert result["applied"] == ["home_prefs"] and result["skipped"] == ["mc_presets"]
    assert get_user_setting(db, u.id, "mc_presets", None) is None
    # 버전 표식 없는 파일은 0 으로 저장돼 다음 부팅 이관 대상이 된다.
    assert get_user_setting(db, u.id, "home_prefs", None)["layout_version"] == 0

    with pytest.raises(HTTPException) as exc:
        home_prefs_router.import_personal_settings(
            payload=home_prefs_router.SettingsImportRequest(document=json.dumps({"format": "other"})),
            request=None, db=db, user=u,
        )
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        home_prefs_router.import_personal_settings(
            payload=home_prefs_router.SettingsImportRequest(document="not json"), request=None, db=db, user=u,
        )
