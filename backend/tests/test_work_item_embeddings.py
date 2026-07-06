"""WorkItem/WorkGuide 임베딩 파이프라인 통합 테스트 — 실제 Postgres(+pgvector) 사용.

pgvector 확장/컬럼/코사인 검색은 SQLite 나 mock 으로 재현할 수 없으므로, 이 파일만
DATABASE_URL 이 가리키는 실제 Postgres 에 대해 동작한다 (CI 서비스 컨테이너 / 로컬
docker-compose postgres 필요 — CLAUDE.md 참고).
"""
import os
import uuid
from datetime import datetime
from unittest.mock import MagicMock

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.work_item import WorkItem  # noqa: E402
from app.models.work_guide import WorkGuide  # noqa: E402
import app.celery_app as celery_app_module  # noqa: E402
import app.routers.work_items as work_items_router  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    """모듈 최초 1회 — 실제 lifespan 이 하는 순서(확장→create_all→migrations) 를 그대로 재현해
    pgvector 확장과 embedding 컬럼(구버전 DB 호환 경로)을 보장한다.

    (TestClient(app) 를 ``with`` 없이 인스턴스화하는 것만으로는 ASGI lifespan 이 실행되지
    않는다 — 다른 테스트가 만든 work_items 테이블에는 embedding 컬럼이 없을 수 있으므로
    반드시 _run_migrations() 로 보강해야 한다.)
    """
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _make_work_item(db, *, title="샘플 제목", content="샘플 본문", embedding=None) -> WorkItem:
    item = WorkItem(
        id=uuid.uuid4(),
        type="task",
        assignee="tester",
        primary_assignee="tester",
        category="테스트",
        content=content,
        title=title,
        started_at=datetime.utcnow(),
        embedding=embedding,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@pytest.fixture(autouse=True)
def _cleanup(db):
    yield
    db.query(WorkItem).filter(WorkItem.category == "테스트").delete()
    db.query(WorkGuide).filter(WorkGuide.category == "테스트").delete()
    db.commit()


# ── Celery task: compute_work_item_embedding ──────────────────────────────

def test_compute_work_item_embedding_updates_row(db, monkeypatch):
    item = _make_work_item(db, title="etcd 리더 없음", content="etcd 클러스터 리더 선출 실패")

    async def fake_embed(text):
        assert "etcd" in text
        return [0.1] * 768

    monkeypatch.setattr(celery_app_module, "asyncio", celery_app_module.asyncio)
    monkeypatch.setattr(
        "app.services.embedding_service.embedding_service.embed", fake_embed
    )

    result = celery_app_module.compute_work_item_embedding(str(item.id))

    assert result["dim"] == 768
    db.refresh(item)
    assert item.embedding is not None
    assert len(item.embedding) == 768


def test_compute_work_item_embedding_skips_when_llm_unavailable(db, monkeypatch):
    item = _make_work_item(db, title="offline case", content="ollama down")

    async def fake_embed_none(_text):
        return None

    monkeypatch.setattr(
        "app.services.embedding_service.embedding_service.embed", fake_embed_none
    )

    result = celery_app_module.compute_work_item_embedding(str(item.id))

    assert result["skipped"] is True
    db.refresh(item)
    assert item.embedding is None


def test_compute_work_item_embedding_missing_item_is_noop():
    result = celery_app_module.compute_work_item_embedding(str(uuid.uuid4()))
    assert result["skipped"] is True
    assert result["reason"] == "not found"


def test_compute_work_guide_embedding_updates_row(db, monkeypatch):
    guide = WorkGuide(id=uuid.uuid4(), title="배포 가이드", content="배포 절차 설명", category="테스트")
    db.add(guide)
    db.commit()

    async def fake_embed(text):
        assert "배포" in text
        return [0.2] * 768

    monkeypatch.setattr(
        "app.services.embedding_service.embedding_service.embed", fake_embed
    )

    result = celery_app_module.compute_work_guide_embedding(str(guide.id))

    assert result["dim"] == 768
    db.refresh(guide)
    assert guide.embedding is not None


# ── Fail-safe: queueing must never break the write path ───────────────────

def test_queue_embedding_recompute_is_fail_safe_when_celery_import_fails(monkeypatch):
    """Celery/Redis 가 죽어 있어도 큐잉 헬퍼는 예외를 삼킨다 — 쓰기 응답에 영향 없음."""
    import builtins
    real_import = builtins.__import__

    def _boom_import(name, *args, **kwargs):
        if name == "app.celery_app":
            raise RuntimeError("redis connection refused")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _boom_import)
    # 예외가 전파되지 않아야 한다.
    work_items_router._queue_embedding_recompute(uuid.uuid4())


def test_create_work_item_queues_embedding_without_blocking(db, monkeypatch):
    """POST 응답 경로가 임베딩 계산을 기다리지 않고 .delay() 만 호출하는지 확인."""
    from fastapi import Request

    from app.schemas.work_item import WorkItemCreate

    fake_delay = MagicMock()
    monkeypatch.setattr(celery_app_module.compute_work_item_embedding, "delay", fake_delay)

    actor = MagicMock()
    actor.id = "actor-uuid"
    actor.username = "tester"
    actor.role = "operator"

    request = MagicMock(spec=Request)
    request.client = MagicMock(host="127.0.0.1")
    request.headers = {"user-agent": "pytest"}

    payload = WorkItemCreate(
        type="task",
        assignee="tester",
        primary_assignee="tester",
        category="테스트",
        content="임베딩 큐잉 확인용",
        title="임베딩 큐잉 테스트",
        started_at=datetime.utcnow(),
    )

    item = work_items_router.create_work_item(payload, db=db, actor=actor, request=request)

    fake_delay.assert_called_once_with(str(item.id))
    # 동기 경로에서 embedding 이 채워지지 않아야 한다 (Celery 가 비동기로 채움).
    assert item.embedding is None


# ── Similarity search (pgvector cosine distance) ──────────────────────────

def test_similar_work_items_orders_by_cosine_distance(db):
    target = _make_work_item(db, title="타겟", content="타겟 문서", embedding=[1.0, 0.0] + [0.0] * 766)
    close = _make_work_item(db, title="근접", content="근접 문서", embedding=[0.9, 0.1] + [0.0] * 766)
    far = _make_work_item(db, title="먼", content="먼 문서", embedding=[0.0, 1.0] + [0.0] * 766)

    fake_user = MagicMock()

    result = work_items_router.get_similar_work_items(
        item_id=target.id, limit=5, db=db, _=fake_user,
    )

    assert result.embedding_available is True
    ids_in_order = [row.id for row in result.data]
    assert ids_in_order.index(close.id) < ids_in_order.index(far.id)
    assert target.id not in ids_in_order


def test_similar_work_items_reports_unavailable_when_no_embedding(db):
    item = _make_work_item(db, title="임베딩 없음", content="아직 계산 전", embedding=None)
    fake_user = MagicMock()

    result = work_items_router.get_similar_work_items(
        item_id=item.id, limit=5, db=db, _=fake_user,
    )

    assert result.embedding_available is False
    assert result.data == []
