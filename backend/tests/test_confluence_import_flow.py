"""Confluence 문서 가져오기/내보내기 라우터 통합 테스트 — 실제 Postgres 사용.

ConfluenceService 는 fake 로 대체(네트워크 없음)하고, dry-run 프리뷰 → 커밋 →
재가져오기(unchanged) → PEP 수정(modified 전이) → 게시(역저장) 의 핵심 상태 전이를
실 DB 위에서 검증한다.
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.work_guide import WorkGuide  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
import app.routers.confluence as confluence_router  # noqa: E402
from app.routers.confluence import export_doc, import_docs  # noqa: E402
from app.schemas.confluence_docs import (  # noqa: E402
    ConfluenceDocExportRequest,
    ConfluenceDocImportRequest,
)


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


class _Actor:
    username = "tester"
    role = "operator"


class _FakeConfluence:
    """get_page/update_page/upsert_page 만 흉내내는 fake — page 상태를 들고 있다."""

    def __init__(self, pages: dict):
        self.pages = pages          # page_id -> {title, space_key, body_storage, version, url}
        self.updated: list = []

    async def get_page(self, page_id: str) -> dict:
        page = self.pages.get(page_id)
        if not page:
            return {"status": "error", "detail": f"페이지 {page_id} 없음 (404)"}
        return {"status": "ok", "page": {"id": page_id, **page}}

    async def update_page(self, page_id, title, body, *, version):
        self.pages[page_id]["version"] = version
        self.pages[page_id]["title"] = title
        self.updated.append((page_id, version))
        return {"status": "ok", "action": "updated", "id": page_id, "version": version,
                "url": self.pages[page_id].get("url", "")}

    async def upsert_page(self, space_key, title, body, *, parent_id=""):
        pid = "9001"
        self.pages[pid] = {"title": title, "space_key": space_key,
                           "body_storage": body, "version": 1, "url": "https://c/x"}
        return {"status": "ok", "action": "created", "id": pid, "url": "https://c/x"}

    async def upload_attachment(self, page_id, filename, content, mime):
        return {"status": "ok", "filename": filename}


def _patch_service(monkeypatch, fake):
    async def _verified(db, actor, cfg):
        return fake, {"status": "ok"}
    monkeypatch.setattr(confluence_router, "_confluence_service_verified", _verified)
    monkeypatch.setattr(confluence_router, "_get_config",
                        lambda db: {"confluence_base_url": "https://c.example.com"})
    # 브로커 없는 테스트 환경에서 celery .delay 재시도 대기를 피한다 (큐잉은 fail-safe 헬퍼)
    monkeypatch.setattr(confluence_router, "_queue_embedding_recompute", lambda gid: None)


PAGE_ID = None  # 각 테스트가 고유 page_id 를 쓰도록 헬퍼에서 발급


def _new_page_id() -> str:
    return f"t{uuid.uuid4().hex[:10]}"


async def test_import_dry_run_then_commit_then_unchanged(db, monkeypatch):
    pid = _new_page_id()
    fake = _FakeConfluence({pid: {
        "title": "etcd 런북", "space_key": "OPS", "version": 3, "url": "https://c/p",
        "body_storage": '<ac:structured-macro ac:name="info">'
                        "<ac:rich-text-body><p>안내</p></ac:rich-text-body></ac:structured-macro>",
    }})
    _patch_service(monkeypatch, fake)

    # 1) dry-run — 쓰기 없음, action=create
    res = await import_docs(ConfluenceDocImportRequest(page_ids=[pid], dry_run=True), db, _Actor())
    assert res.status == "ok" and res.dry_run
    assert res.items[0].action == "create"
    assert db.query(WorkGuide).filter(WorkGuide.confluence_page_id == pid).first() is None

    # 2) 커밋 — WorkGuide 생성 + 변환된 본문 + synced
    res = await import_docs(ConfluenceDocImportRequest(page_ids=[pid], dry_run=False), db, _Actor())
    assert res.status == "ok" and res.imported == 1
    guide = db.query(WorkGuide).filter(WorkGuide.confluence_page_id == pid).first()
    assert guide is not None
    assert 'data-callout="info"' in (guide.content or "")
    assert guide.source == "confluence"
    assert guide.confluence_version == 3
    assert guide.confluence_sync_status == "synced"

    # 3) 같은 버전 재가져오기 — unchanged 로 건너뜀
    res = await import_docs(ConfluenceDocImportRequest(page_ids=[pid], dry_run=False), db, _Actor())
    assert res.skipped == 1 and res.imported == 0 and res.updated == 0

    # 4) 원격 버전 증가 → update
    fake.pages[pid]["version"] = 4
    fake.pages[pid]["title"] = "etcd 런북 (개정)"
    res = await import_docs(ConfluenceDocImportRequest(page_ids=[pid], dry_run=False), db, _Actor())
    assert res.updated == 1
    db.refresh(guide)
    assert guide.confluence_version == 4 and guide.title == "etcd 런북 (개정)"


async def test_export_linked_guide_publishes_new_version(db, monkeypatch):
    pid = _new_page_id()
    fake = _FakeConfluence({pid: {
        "title": "가이드", "space_key": "OPS", "version": 5,
        "url": "https://c/p", "body_storage": "<p>old</p>",
    }})
    _patch_service(monkeypatch, fake)

    guide = WorkGuide(
        title="가이드", content="<p>새 본문</p>", source="pep",
        confluence_page_id=pid, confluence_space_key="OPS",
        confluence_version=5, confluence_sync_status="modified",
    )
    db.add(guide)
    db.commit()
    db.refresh(guide)

    res = await export_doc(guide.id, ConfluenceDocExportRequest(), db, _Actor())
    assert res.status == "ok" and res.action == "updated"
    assert fake.updated == [(pid, 6)]        # 원격 v5 위에 v6 로 게시
    db.refresh(guide)
    assert guide.confluence_version == 6
    assert guide.confluence_sync_status == "synced"
    assert guide.confluence_sync_error is None


async def test_export_unlinked_guide_creates_page(db, monkeypatch):
    fake = _FakeConfluence({})
    _patch_service(monkeypatch, fake)
    monkeypatch.setattr(confluence_router, "_get_docs_settings",
                        lambda db: {"space_key": "OPS", "parent_page_id": "",
                                    "default_category": "기타", "title_prefix": ""})

    guide = WorkGuide(title="신규 문서", content="<p>본문</p>", source="pep")
    db.add(guide)
    db.commit()
    db.refresh(guide)

    res = await export_doc(guide.id, ConfluenceDocExportRequest(), db, _Actor())
    assert res.status == "ok" and res.action == "created"
    db.refresh(guide)
    assert guide.confluence_page_id == "9001"
    assert guide.confluence_sync_status == "synced"
