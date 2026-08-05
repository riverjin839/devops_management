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
        db.query(UserSetting).filter(UserSetting.user_id.in_(user_ids)).delete(synchronize_session=False)
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
