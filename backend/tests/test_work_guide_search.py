"""문서 검색(knowledge_search) 단위 테스트 — HTML 스트립 + 폴백 경로 (DB/네트워크 불필요)."""
from app.services import knowledge_search
from app.services.embedding_service import build_embedding_text
from app.services.knowledge_search import strip_html_text


# ── HTML 스트립 ────────────────────────────────────────────────────────────────
def test_strip_html_text_removes_tags_and_entities():
    html = "<h2>제목</h2><p>본문 &amp; <strong>강조</strong></p>"
    assert strip_html_text(html) == "제목 본문 & 강조"


def test_strip_html_text_handles_empty():
    assert strip_html_text(None) == ""
    assert strip_html_text("") == ""


def test_build_embedding_text_strips_html_content():
    text = build_embedding_text("가이드", "<p>본문 <b>내용</b></p>")
    assert text == "가이드\n\n본문 내용"
    assert "<" not in text


# ── 검색 폴백 경로 ─────────────────────────────────────────────────────────────
async def test_search_guides_falls_back_to_ilike_when_embedding_unavailable(monkeypatch):
    """Ollama 미기동(embed→None)이면 ILIKE 폴백 + embedding_available=False."""

    async def _no_embed(text):
        return None

    sentinel = [{"id": "x", "title": "폴백 결과"}]
    # embedding_service 싱글턴은 search_guides 안에서 지연 import 되므로 원본 모듈을 패치
    from app.services import embedding_service as emb_mod
    monkeypatch.setattr(emb_mod.embedding_service, "embed", _no_embed)
    monkeypatch.setattr(knowledge_search, "_ilike_search", lambda db, q, limit: sentinel)

    result = await knowledge_search.search_guides(db=None, q="etcd", limit=5)
    assert result["embedding_available"] is False
    assert result["items"] == sentinel


async def test_search_guides_empty_query_returns_empty():
    result = await knowledge_search.search_guides(db=None, q="   ", limit=5)
    assert result == {"items": [], "embedding_available": False}
