"""Your Island 15차 감사(B-12) — PUT 낙관적 동시성(`expected_updated_at`) 계약.

1. expected_updated_at 생략 → 확인 없이 저장(구 클라이언트 호환).
2. 일치 → 저장되고 updated_at 이 올라간다(값이 같아도 올라감 = 다음 기대값).
3. 불일치 → 409 + "다른 곳에서 바뀌었습니다. 새로고침하세요", 아무것도 바뀌지 않는다.
4. tz-aware 로 보내도 naive UTC 컬럼과 같은 기준으로 비교한다.
5. 아일랜드 순서 변경은 updated_at(내용 버전)을 올리지 않는다 — 진행 중 패널 저장이 튕기지 않게.
"""
import uuid
from datetime import timedelta, timezone

import pytest
from fastapi import HTTPException

from app.routers import island as island_router
from app.schemas.island import IslandCreate, IslandReorder, IslandUpdate


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
def owner(db):
    u = _user("r15")
    yield u
    from app.models.island import Island

    db.rollback()
    db.query(Island).filter(Island.owner_id == u.id).delete(synchronize_session=False)
    db.commit()


def _create(db, user, name="동시성", **kwargs):
    return island_router.create_island(payload=IslandCreate(name=name, **kwargs), db=db, user=user)


def _update(db, user, island_id, **fields):
    return island_router.update_island(
        island_id=island_id, payload=IslandUpdate(**fields), db=db, user=user,
    )


def test_update_without_expected_skips_version_check(db, owner):
    isl = _create(db, owner)
    out = _update(db, owner, isl.id, name="새 이름")
    assert out.name == "새 이름"


def test_update_with_matching_expected_saves_and_bumps_version(db, owner):
    isl = _create(db, owner, panels=[{"key": "p1", "path": "/ops-checks"}])
    out = _update(
        db, owner, isl.id,
        panels=[{"key": "p1", "path": "/ops-checks"}, {"key": "p2", "path": "/alerts"}],
        expected_updated_at=isl.updated_at,
    )
    assert [p.key for p in out.panels] == ["p1", "p2"]
    assert out.updated_at > isl.updated_at


def test_update_bumps_version_even_when_values_unchanged(db, owner):
    """클라이언트는 응답의 updated_at 을 다음 기대값으로 쓴다 — 같은 값 저장도 버전이 올라가야 일관된다."""
    isl = _create(db, owner, name="그대로")
    out = _update(db, owner, isl.id, name="그대로", expected_updated_at=isl.updated_at)
    assert out.updated_at > isl.updated_at


def test_update_with_stale_expected_is_409_and_changes_nothing(db, owner):
    isl = _create(db, owner, panels=[{"key": "p1", "path": "/ops-checks"}])
    # 다른 기기가 먼저 저장 → 버전이 올라간다.
    first = _update(
        db, owner, isl.id,
        panels=[{"key": "p1", "path": "/ops-checks"}, {"key": "p2", "path": "/alerts"}],
        expected_updated_at=isl.updated_at,
    )

    with pytest.raises(HTTPException) as exc:
        _update(db, owner, isl.id, panels=[], expected_updated_at=isl.updated_at)
    assert exc.value.status_code == 409
    assert exc.value.detail == "다른 곳에서 바뀌었습니다. 새로고침하세요"

    now = island_router.get_island(island_id=isl.id, db=db, user=owner)
    assert [p.key for p in now.panels] == ["p1", "p2"], "409 면 아무것도 바뀌지 않아야 한다"
    assert now.updated_at == first.updated_at


def test_update_accepts_tz_aware_expected(db, owner):
    isl = _create(db, owner)
    aware = isl.updated_at.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=9)))
    out = _update(db, owner, isl.id, name="KST 로 보냄", expected_updated_at=aware)
    assert out.name == "KST 로 보냄"


def test_expected_updated_at_is_not_persisted_as_column(db, owner):
    isl = _create(db, owner)
    _update(db, owner, isl.id, description="설명", expected_updated_at=isl.updated_at)
    row = db.query(island_router.Island).filter(island_router.Island.id == isl.id).first()
    assert not hasattr(row, "expected_updated_at")
    assert row.description == "설명"


def test_iso_string_round_trip_matches(db, owner):
    """프런트는 응답 JSON 의 문자열을 그대로 돌려보낸다 — 직렬화 → 파싱 왕복이 같은 값이어야 한다."""
    isl = _create(db, owner)
    wire = isl.model_dump(mode="json")["updated_at"]
    payload = IslandUpdate.model_validate({"name": "왕복", "expected_updated_at": wire})
    out = island_router.update_island(island_id=isl.id, payload=payload, db=db, user=owner)
    assert out.name == "왕복"


def test_reorder_keeps_content_version(db, owner):
    a = _create(db, owner, name="A")
    b = _create(db, owner, name="B")

    result = island_router.reorder_islands(payload=IslandReorder(order=[b.id, a.id]), db=db, user=owner)
    assert [i.id for i in result.data] == [b.id, a.id]
    by_id = {i.id: i for i in result.data}
    assert by_id[a.id].updated_at == a.updated_at
    assert by_id[b.id].updated_at == b.updated_at

    # 순서 변경 뒤에도 앞서 받은 버전으로 저장할 수 있어야 한다.
    out = _update(db, owner, a.id, name="A2", expected_updated_at=a.updated_at)
    assert out.name == "A2"
