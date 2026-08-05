"""Jira 스프린트 이름 → PEP Sprint.id 매칭(`_resolve_sprint_id`) — 실제 테스트 DB 필요."""
import os
import uuid
from datetime import date, timedelta

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.sprint import Sprint  # noqa: E402
from app.routers.jira import _resolve_sprint_id  # noqa: E402


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def _make_sprint(db, name: str) -> Sprint:
    sprint = Sprint(
        id=uuid.uuid4(), name=name, start_date=date.today(),
        end_date=date.today() + timedelta(days=13), status="active",
    )
    db.add(sprint)
    db.commit()
    db.refresh(sprint)
    return sprint


@pytest.fixture(autouse=True)
def _cleanup(db):
    yield
    db.query(Sprint).filter(Sprint.name.like("테스트-%")).delete(synchronize_session=False)
    db.commit()


def test_resolve_sprint_id_matches_case_insensitively(db):
    sprint = _make_sprint(db, f"테스트-Sprint {uuid.uuid4().hex[:6]}")
    cache = {}
    resolved = _resolve_sprint_id(db, cache, sprint.name.upper())
    assert resolved == str(sprint.id)


def test_resolve_sprint_id_no_match_does_not_autocreate(db):
    """매칭 실패 시 None — 자동 생성 없음(UI-First 원칙, 스프린트 생성은 PEP 기획 행위)."""
    cache = {}
    name = f"테스트-없는스프린트-{uuid.uuid4().hex[:8]}"
    assert _resolve_sprint_id(db, cache, name) is None
    assert db.query(Sprint).filter(Sprint.name == name).first() is None


def test_resolve_sprint_id_caches_repeated_lookups(db):
    sprint = _make_sprint(db, f"테스트-Sprint {uuid.uuid4().hex[:6]}")
    cache = {}
    first = _resolve_sprint_id(db, cache, sprint.name)
    # 캐시에 담겼는지 — db 를 None 으로 바꿔도(실제 조회 없이) 같은 값을 반환해야 한다.
    second = _resolve_sprint_id(None, cache, sprint.name)
    assert first == second == str(sprint.id)


def test_resolve_sprint_id_blank_name_returns_none(db):
    assert _resolve_sprint_id(db, {}, "") is None
    assert _resolve_sprint_id(db, {}, "   ") is None
