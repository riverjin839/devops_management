"""브라우저 로컬 개인 설정 서버 동기화(`/me/local-prefs`, services/local_prefs.py).

계약:
1. 개인 키 접두사만 받고, 기기 값·캐시·비밀 가능성이 있는 키는 거절한다(rejected).
2. 델타(set/remove)는 기존 값에 합쳐진다 — 두 기기가 서로 다른 키를 바꿔도 덮지 않는다.
3. rev 는 실제로 바뀐 쓰기에서만 오른다.
4. 값 하나·전체 크기 상한을 넘으면 413.
5. 사용자별로 분리된다.
"""
import uuid

import pytest

from app.services import local_prefs


@pytest.mark.parametrize("key, ok", [
    ("pep:homeTab", True),
    ("k8s:ops-notes:viewMode", True),
    ("pep.runlog.batch.show", True),
    ("cluster-links-layout", True),
    ("k8s:auth:token", False),
    ("k8s:theme", False),
    ("pep:profile:abc", False),
    ("pep:profile-owner", False),
    ("k8s:img:work-item:1", False),
    ("k8s:saved-cmd:mc", False),
    ("pep:popout:x", False),
    ("k8s:cluster-sidebar-width", False),
    ("pep-sync:abc", False),
    ("random", False),
    ("pep:has space", False),
])
def test_syncable_keys(key, ok):
    assert local_prefs.is_syncable_key(key) is ok


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
def users(db):
    from app.models.user import User
    from app.models.user_setting import UserSetting

    us = [User(username=f"lp-{uuid.uuid4().hex[:8]}", hashed_password="x", role="viewer") for _ in range(2)]
    db.add_all(us)
    db.commit()
    for u in us:
        db.refresh(u)
    yield us
    ids = [u.id for u in us]
    db.query(UserSetting).filter(UserSetting.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


def test_delta_merges_and_bumps_rev(db, users):
    uid = users[0].id
    r1 = local_prefs.apply_delta(db, uid, {"pep:homeTab": "work", "k8s:theme": "dark"}, [])
    assert r1["values"] == {"pep:homeTab": "work"} and r1["rev"] == 1 and r1["rejected"] == ["k8s:theme"]

    # 다른 기기가 다른 키를 바꿔도 앞의 키는 남는다
    r2 = local_prefs.apply_delta(db, uid, {"pep:k8s:navCollapsed": "true"}, [])
    assert r2["values"] == {"pep:homeTab": "work", "pep:k8s:navCollapsed": "true"} and r2["rev"] == 2

    # 같은 값 다시 쓰기는 rev 를 올리지 않는다
    r3 = local_prefs.apply_delta(db, uid, {"pep:homeTab": "work"}, [])
    assert r3["rev"] == 2

    r4 = local_prefs.apply_delta(db, uid, {}, ["pep:homeTab"])
    assert r4["values"] == {"pep:k8s:navCollapsed": "true"} and r4["rev"] == 3
    assert local_prefs.get_local_prefs(db, uid)["values"] == r4["values"]


def test_size_limits(db, users, monkeypatch):
    uid = users[0].id
    big = "x" * (local_prefs.MAX_VALUE_CHARS + 1)
    r = local_prefs.apply_delta(db, uid, {"pep:big": big}, [])
    assert r["rejected"] == ["pep:big"] and r["values"] == {}

    monkeypatch.setattr(local_prefs, "MAX_TOTAL_CHARS", 100)
    with pytest.raises(local_prefs.LocalPrefsTooLarge):
        local_prefs.apply_delta(db, uid, {f"pep:k{i}": "y" * 30 for i in range(5)}, [])
    assert local_prefs.get_local_prefs(db, uid)["values"] == {}


def test_api_per_user(db, users):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    c = TestClient(app)
    try:
        app.dependency_overrides[get_current_user] = lambda: users[0]
        assert c.get("/api/v1/me/local-prefs").json() == {"values": {}, "rev": 0, "updated_at": None}
        r = c.patch("/api/v1/me/local-prefs", json={"set": {"pep:homeTab": "platform"}, "remove": []})
        assert r.status_code == 200 and r.json()["values"] == {"pep:homeTab": "platform"}
        assert c.get("/api/v1/me/local-prefs").json()["rev"] == 1

        app.dependency_overrides[get_current_user] = lambda: users[1]
        assert c.get("/api/v1/me/local-prefs").json()["values"] == {}

        r = c.patch("/api/v1/me/local-prefs", json={"set": {"pep:x": "y" * (local_prefs.MAX_TOTAL_CHARS + 10)}})
        assert r.status_code == 200 and r.json()["rejected"] == ["pep:x"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)
