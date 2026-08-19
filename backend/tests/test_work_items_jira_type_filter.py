"""work_items 목록의 "등록 타입"(jira_issue_type) 필터 — 실제 Postgres 사용.

`_apply_filters` 를 라우터 함수 대신 직접 호출해 인증/TestClient 없이 필터 로직만
검증한다(다른 work_items 통합 테스트, 예: test_work_item_embeddings.py 와 동일한
직접-DB 세션 패턴).
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
from app.models.work_item import WorkItem  # noqa: E402
from app.routers.work_items import _apply_filters  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _make_item(db, *, jira_issue_type=None, title="필터 테스트") -> WorkItem:
    item = WorkItem(
        id=uuid.uuid4(), type="task", assignee="tester", primary_assignee="tester",
        category="테스트", content="본문", title=title, started_at=datetime.utcnow(),
        priority="medium", kanban_status="todo", jira_issue_type=jira_issue_type,
    )
    db.add(item)
    db.commit()
    return item


def test_jira_issue_type_filter_matches_exact_value_case_insensitive(db):
    task = _make_item(db, jira_issue_type="Task", title="필터 테스트 — Task")
    sub = _make_item(db, jira_issue_type="Sub-task", title="필터 테스트 — Sub-task")
    _make_item(db, jira_issue_type=None, title="필터 테스트 — 미연동")

    query = db.query(WorkItem).filter(WorkItem.id.in_([task.id, sub.id]))
    results = _apply_filters(
        query, type_=None, cluster_id=None, assignee=None, category=None,
        priority=None, kanban_status=None, module=None, started_from=None,
        started_to=None, closed=None, jira_issue_type="task",
    ).all()

    assert [r.id for r in results] == [task.id]


def test_jira_issue_type_filter_none_returns_everything(db):
    a = _make_item(db, jira_issue_type="Bug", title="필터 테스트 — Bug")
    b = _make_item(db, jira_issue_type=None, title="필터 테스트 — 미연동2")

    query = db.query(WorkItem).filter(WorkItem.id.in_([a.id, b.id]))
    results = _apply_filters(
        query, type_=None, cluster_id=None, assignee=None, category=None,
        priority=None, kanban_status=None, module=None, started_from=None,
        started_to=None, closed=None, jira_issue_type=None,
    ).all()

    assert {r.id for r in results} == {a.id, b.id}
