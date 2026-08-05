"""PATCH /work-items/{id}/status — 완료일(closed_at) 자동 관리 회귀 테스트.

done 전이 시 자동 set 은 기존에도 있었지만, done 에서 벗어날(재오픈) 때 자동으로 채웠던
완료일을 지우는 분기가 이 엔드포인트(PATCH .../status, 칸반 드래그 경로)에는 없어서
PUT /{item_id}(update_work_item, 정식 폼 경로)와 동작이 어긋나는 버그가 있었다 — 그 수정을
검증한다. 라우터 함수를 FastAPI DI 없이 직접 호출한다(다른 실통합 테스트와 동일 패턴).
"""
import os
import uuid
from datetime import datetime

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.work_item import WorkItem  # noqa: E402
from app.routers.work_items import patch_status  # noqa: E402
from app.schemas.work_item import WorkItemStatusPatch  # noqa: E402


@pytest.fixture
def db():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def actor():
    # 소유권 검사를 건너뛰도록 admin — 이 테스트는 closed_at 전이 로직만 검증한다.
    return User(id=str(uuid.uuid4()), username="tester", hashed_password="x", role="admin")


def _make_item(db, **overrides) -> WorkItem:
    item = WorkItem(
        id=uuid.uuid4(),
        type="task",
        assignee="tester",
        primary_assignee="tester",
        category=f"테스트-{uuid.uuid4().hex[:8]}",
        content="본문",
        started_at=datetime.utcnow(),
        kanban_status=overrides.pop("kanban_status", "in_progress"),
        **overrides,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@pytest.fixture(autouse=True)
def _cleanup(db):
    yield
    db.query(WorkItem).filter(WorkItem.category.like("테스트-%")).delete(synchronize_session=False)
    db.commit()


def test_done_transition_sets_closed_at(db, actor):
    item = _make_item(db)
    assert item.closed_at is None

    patch_status(item_id=item.id, payload=WorkItemStatusPatch(kanban_status="done"), db=db, actor=actor)

    db.refresh(item)
    assert item.closed_at is not None


def test_reopen_after_done_clears_auto_set_closed_at(db, actor):
    """done → 다른 상태로 되돌리면(재오픈), 자동으로 채워졌던 완료일도 함께 지워져야 한다
    (PUT /{item_id} 의 기존 동작과 일치)."""
    item = _make_item(db)
    patch_status(item_id=item.id, payload=WorkItemStatusPatch(kanban_status="done"), db=db, actor=actor)
    db.refresh(item)
    assert item.closed_at is not None

    patch_status(item_id=item.id, payload=WorkItemStatusPatch(kanban_status="in_progress"), db=db, actor=actor)

    db.refresh(item)
    assert item.closed_at is None


def test_non_done_to_non_done_transition_does_not_touch_closed_at(db, actor):
    """done 이 아니었던 상태끼리의 이동은 closed_at 에 손대지 않는다."""
    item = _make_item(db, kanban_status="backlog")

    patch_status(item_id=item.id, payload=WorkItemStatusPatch(kanban_status="todo"), db=db, actor=actor)

    db.refresh(item)
    assert item.closed_at is None
