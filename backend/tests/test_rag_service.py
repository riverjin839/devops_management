"""rag_service 통합 테스트 — 실제 Postgres(pgvector) + 임베딩 mock.

유사도 정렬·임계값 필터·소스 타입 필터·fail-safe(임베딩 불가 시 빈 목록)를 검증.
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.config import settings  # noqa: E402
from app.models.ops_note import OpsNote  # noqa: E402
from app.models.work_guide import WorkGuide  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.services import rag_service  # noqa: E402
from app.services.llm import service as llm_service_module  # noqa: E402


DIM = settings.embedding_dim


def _vec(axis: int) -> list[float]:
    v = [0.0] * DIM
    v[axis] = 1.0
    return v


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
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


@pytest.fixture
def seeded(db):
    guide = WorkGuide(
        id=uuid.uuid4(), title="OOMKilled 대응 가이드",
        content="메모리 limit 상향 및 힙 분석 절차", embedding=_vec(0),
    )
    note = OpsNote(
        id=str(uuid.uuid4()), service="k8s", title="etcd defrag 노트",
        content="defrag 는 새벽에", embedding=_vec(1),
    )
    db.add_all([guide, note])
    db.commit()
    yield {"guide": guide, "note": note}
    db.delete(guide)
    db.query(OpsNote).filter(OpsNote.id == note.id).delete()
    db.commit()


def _patch_embed(monkeypatch, vector):
    async def _fake_embed(self, text, *, db=None):
        return vector
    monkeypatch.setattr(llm_service_module.LLMService, "embed", _fake_embed)


@pytest.mark.asyncio
async def test_retrieve_orders_by_similarity_and_filters_threshold(db, seeded, monkeypatch):
    _patch_embed(monkeypatch, _vec(0))  # guide 와 동일 방향 → sim 1.0, note 는 0.0
    results = await rag_service.retrieve(db, "OOM 원인", k=4)
    titles = [r["title"] for r in results]
    assert "OOMKilled 대응 가이드" in titles
    assert "etcd defrag 노트" not in titles  # 유사도 0 < MIN_SIMILARITY
    top = results[0]
    assert top["source_type"] == "work_guide"
    assert top["similarity"] >= 0.99
    assert top["route"].startswith("/")
    assert top["snippet"]


@pytest.mark.asyncio
async def test_retrieve_source_type_filter(db, seeded, monkeypatch):
    _patch_embed(monkeypatch, _vec(1))  # note 방향
    results = await rag_service.retrieve(db, "etcd", k=4, source_types=["ops_note"])
    assert results
    assert all(r["source_type"] == "ops_note" for r in results)


@pytest.mark.asyncio
async def test_retrieve_returns_empty_when_embedding_unavailable(db, monkeypatch):
    _patch_embed(monkeypatch, None)
    assert await rag_service.retrieve(db, "질문") == []


@pytest.mark.asyncio
async def test_retrieve_empty_query(db):
    assert await rag_service.retrieve(db, "   ") == []


def test_build_reference_block_numbering():
    block = rag_service.build_reference_block([
        {"title": "가이드 A", "source_type": "work_guide", "snippet": "내용 A"},
        {"title": "이력 B", "source_type": "work_item", "snippet": "내용 B"},
    ])
    assert "[1] (작업 가이드) 가이드 A" in block
    assert "[2] (업무 이력) 이력 B" in block
    assert rag_service.build_reference_block([]) == ""
