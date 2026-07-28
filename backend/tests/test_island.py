"""Your Island 라우터 테스트.

핵심 계약 3가지를 지킨다:
1. 소유권 — 남의 아일랜드는 수정/삭제 불가(403), 비공개면 존재도 노출 안 함(404).
2. 공유 — is_shared 는 읽기 + 복제만 허용하고, 복제본은 내 소유 + 비공개로 떨어진다.
3. panels 방어 정규화 — 깨진 데이터가 들어와도 500 나지 않고 조용히 정리된다.
"""
import uuid

import pytest
from fastapi import HTTPException

from app.routers import island as island_router
from app.schemas.island import MAX_PANELS, IslandCreate, IslandUpdate


# ── _normalize_panels (DB 불필요) ────────────────────────────────────────────
def test_normalize_drops_non_list_and_non_dict():
    assert island_router._normalize_panels(None) == []
    assert island_router._normalize_panels("nope") == []
    assert island_router._normalize_panels([{"key": "a", "path": "/x"}, "junk", 42]) == [
        {"key": "a", "path": "/x", "label": None, "icon": None},
    ]


def test_normalize_drops_items_without_usable_path():
    out = island_router._normalize_panels([
        {"key": "a", "path": ""},
        {"key": "b", "path": "   "},
        {"key": "c"},
        {"key": "d", "path": 123},
        {"key": "e", "path": "/ok"},
    ])
    assert [p["path"] for p in out] == ["/ok"]


def test_normalize_regenerates_missing_or_duplicate_keys():
    out = island_router._normalize_panels([
        {"key": "same", "path": "/a"},
        {"key": "same", "path": "/b"},   # 중복 → 새 키 발급
        {"path": "/c"},                   # 키 없음 → 새 키 발급
    ])
    keys = [p["key"] for p in out]
    assert keys[0] == "same"
    assert len(set(keys)) == 3, f"키가 유일해야 한다: {keys}"
    assert [p["path"] for p in out] == ["/a", "/b", "/c"]


def test_normalize_blanks_empty_label_and_icon():
    out = island_router._normalize_panels([
        {"key": "a", "path": "/x", "label": "   ", "icon": ""},
    ])
    assert out[0]["label"] is None and out[0]["icon"] is None


def test_normalize_truncates_at_max_panels():
    raw = [{"key": f"k{i}", "path": f"/p{i}"} for i in range(MAX_PANELS + 5)]
    assert len(island_router._normalize_panels(raw)) == MAX_PANELS


def test_normalize_accepts_pydantic_models():
    """PUT 본문은 IslandPanel 모델로 들어온다 — dict 가 아니어도 처리돼야 한다."""
    payload = IslandCreate(name="x", panels=[{"key": "a", "path": "/ops-checks"}])
    assert island_router._normalize_panels(payload.panels) == [
        {"key": "a", "path": "/ops-checks", "label": None, "icon": None},
    ]


# ── DB 기반 라우터 테스트 ────────────────────────────────────────────────────
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
    """get_current_user 대체 — 라우터는 .id / .username / .display_name 만 읽는다."""
    from app.models.user import User

    return User(
        id=f"u-{suffix}-{uuid.uuid4().hex[:8]}",
        username=f"user-{suffix}",
        display_name=f"사용자 {suffix}",
        role="operator",
    )


@pytest.fixture
def owner():
    return _user("owner")


@pytest.fixture
def other():
    return _user("other")


@pytest.fixture
def cleanup(db):
    """테스트가 만든 아일랜드를 소유자 기준으로 정리."""
    owners: list[str] = []
    yield owners
    from app.models.island import Island

    if owners:
        db.query(Island).filter(Island.owner_id.in_(owners)).delete(synchronize_session=False)
        db.commit()


def _create(db, user, name="테스트 아일랜드", **kwargs):
    return island_router.create_island(
        payload=IslandCreate(name=name, **kwargs), db=db, user=user,
    )


def test_create_sets_owner_and_snapshot_name(db, owner, cleanup):
    cleanup.append(owner.id)
    isl = _create(db, owner, panels=[{"key": "p1", "path": "/ops-checks"}])

    assert isl.owner_id == owner.id
    assert isl.owner_name == owner.display_name
    assert isl.layout_mode == "tabs"
    assert isl.is_shared is False
    assert [p.path for p in isl.panels] == ["/ops-checks"]


def test_sort_order_increments_per_owner(db, owner, cleanup):
    cleanup.append(owner.id)
    first = _create(db, owner, name="첫번째")
    second = _create(db, owner, name="두번째")
    assert second.sort_order > first.sort_order


def test_list_separates_mine_from_shared(db, owner, other, cleanup):
    cleanup.extend([owner.id, other.id])
    mine = _create(db, owner, name="내 것")
    theirs_shared = _create(db, other, name="공유된 남의 것", is_shared=True)
    _create(db, other, name="비공개 남의 것")

    result = island_router.list_islands(db=db, user=owner)

    assert [i.id for i in result.data] == [mine.id]
    assert [i.id for i in result.shared] == [theirs_shared.id]
    assert result.total == 1


def test_get_private_island_of_another_user_is_404_not_403(db, owner, other, cleanup):
    """비공개 아일랜드는 존재 자체를 노출하지 않는다."""
    cleanup.extend([owner.id, other.id])
    theirs = _create(db, other, name="비공개")

    with pytest.raises(HTTPException) as exc:
        island_router.get_island(island_id=theirs.id, db=db, user=owner)
    assert exc.value.status_code == 404


def test_get_shared_island_of_another_user_is_allowed(db, owner, other, cleanup):
    cleanup.extend([owner.id, other.id])
    theirs = _create(db, other, name="공유됨", is_shared=True)

    got = island_router.get_island(island_id=theirs.id, db=db, user=owner)
    assert got.id == theirs.id


def test_update_by_non_owner_is_403(db, owner, other, cleanup):
    cleanup.extend([owner.id, other.id])
    theirs = _create(db, other, name="공유됨", is_shared=True)

    with pytest.raises(HTTPException) as exc:
        island_router.update_island(
            island_id=theirs.id, payload=IslandUpdate(name="탈취"), db=db, user=owner,
        )
    assert exc.value.status_code == 403


def test_delete_by_non_owner_is_403(db, owner, other, cleanup):
    cleanup.extend([owner.id, other.id])
    theirs = _create(db, other, name="공유됨", is_shared=True)

    with pytest.raises(HTTPException) as exc:
        island_router.delete_island(island_id=theirs.id, db=db, user=owner)
    assert exc.value.status_code == 403


def test_update_applies_only_provided_fields(db, owner, cleanup):
    cleanup.append(owner.id)
    isl = _create(db, owner, name="원래 이름", panels=[{"key": "p1", "path": "/ops-checks"}])

    updated = island_router.update_island(
        island_id=isl.id, payload=IslandUpdate(layout_mode="sidebar"), db=db, user=owner,
    )
    assert updated.layout_mode == "sidebar"
    assert updated.name == "원래 이름"                      # 건드리지 않은 필드는 유지
    assert [p.path for p in updated.panels] == ["/ops-checks"]


def test_update_normalizes_incoming_panels(db, owner, cleanup):
    cleanup.append(owner.id)
    isl = _create(db, owner)

    updated = island_router.update_island(
        island_id=isl.id,
        payload=IslandUpdate(panels=[
            {"key": "dup", "path": "/a"},
            {"key": "dup", "path": "/b"},
        ]),
        db=db, user=owner,
    )
    keys = [p.key for p in updated.panels]
    assert len(set(keys)) == 2


def test_clone_of_shared_island_becomes_mine_and_private(db, owner, other, cleanup):
    cleanup.extend([owner.id, other.id])
    theirs = _create(
        db, other, name="공유 대시보드", is_shared=True,
        panels=[{"key": "p1", "path": "/ops-checks"}],
    )

    clone = island_router.clone_island(island_id=theirs.id, db=db, user=owner)

    assert clone.id != theirs.id
    assert clone.owner_id == owner.id
    assert clone.owner_name == owner.display_name
    assert clone.is_shared is False, "복제본은 비공개로 시작해야 한다"
    assert clone.name == "공유 대시보드 (복사)"
    assert [p.path for p in clone.panels] == ["/ops-checks"]


def test_clone_of_private_island_of_another_user_is_404(db, owner, other, cleanup):
    cleanup.extend([owner.id, other.id])
    theirs = _create(db, other, name="비공개")

    with pytest.raises(HTTPException) as exc:
        island_router.clone_island(island_id=theirs.id, db=db, user=owner)
    assert exc.value.status_code == 404


def test_reorder_applies_requested_order(db, owner, cleanup):
    from app.schemas.island import IslandReorder

    cleanup.append(owner.id)
    a = _create(db, owner, name="A")
    b = _create(db, owner, name="B")
    c = _create(db, owner, name="C")

    result = island_router.reorder_islands(
        payload=IslandReorder(order=[c.id, a.id, b.id]), db=db, user=owner,
    )
    assert [i.id for i in result.data] == [c.id, a.id, b.id]


def test_reorder_ignores_unknown_ids_and_appends_missing(db, owner, other, cleanup):
    from app.schemas.island import IslandReorder

    cleanup.extend([owner.id, other.id])
    a = _create(db, owner, name="A")
    b = _create(db, owner, name="B")
    theirs = _create(db, other, name="남의 것")

    # 남의 id 는 무시되고, 목록에서 빠진 b 는 뒤로 밀린다.
    result = island_router.reorder_islands(
        payload=IslandReorder(order=[theirs.id, a.id]), db=db, user=owner,
    )
    assert [i.id for i in result.data] == [a.id, b.id]


def test_reorder_does_not_touch_other_users_islands(db, owner, other, cleanup):
    from app.schemas.island import IslandReorder

    cleanup.extend([owner.id, other.id])
    theirs = _create(db, other, name="남의 것")
    before = theirs.sort_order
    _create(db, owner, name="내 것")

    island_router.reorder_islands(payload=IslandReorder(order=[]), db=db, user=owner)

    # _create 는 IslandResponse(Pydantic)를 돌려주므로 ORM row 를 다시 읽어 확인한다.
    row = db.query(island_router.Island).filter(island_router.Island.id == theirs.id).first()
    assert row.sort_order == before


def test_to_response_repairs_corrupt_layout_mode_and_panels(db, owner, cleanup):
    """DB 에 직접 들어간 잘못된 값도 응답 단계에서 복구된다 (500 금지)."""
    cleanup.append(owner.id)
    isl = _create(db, owner)

    raw = db.query(island_router.Island).filter(island_router.Island.id == isl.id).first()
    raw.layout_mode = "쓰레기값"
    raw.panels = ["not-a-dict", {"path": "/ok"}]
    db.commit()

    resp = island_router.get_island(island_id=isl.id, db=db, user=owner)
    assert resp.layout_mode == "tabs"
    assert [p.path for p in resp.panels] == ["/ok"]
