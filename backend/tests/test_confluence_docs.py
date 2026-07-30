"""Confluence 문서 라우터 헬퍼 단위 테스트 — DB/네트워크 불필요 (fake svc 사용)."""
import base64

from app.routers.confluence import (
    _build_confluence_cql,
    _cql_quote,
    _import_changes,
    _inline_attachment_images,
    _INLINE_IMAGE_MAX,
)
from app.schemas.confluence_docs import ConfluenceDocSearchRequest


class _Guide:
    """WorkGuide 최소 스텁 — _import_changes 가 읽는 속성만."""

    def __init__(self, **kw):
        self.title = kw.get("title", "")
        self.confluence_version = kw.get("confluence_version")


class _FakeSvc:
    """ConfluenceService 스텁 — get_attachment 만 흉내낸다."""

    def __init__(self, responses: dict):
        self.responses = responses

    async def get_attachment(self, page_id, filename):
        return self.responses.get(filename, {"status": "error", "detail": "없음"})


# ── _build_confluence_cql ────────────────────────────────────────────────────────
def test_cql_default_mode_is_contributor_currentuser():
    """기본값 검증 — 요청사항: '본인 기준으로 가져오는 걸 기본설정으로'."""
    req = ConfluenceDocSearchRequest()
    assert req.contributor_mode == "me"
    cql, err = _build_confluence_cql(req)
    assert err == ""
    assert cql == 'type = page and contributor = currentUser() order by lastmodified desc'


def test_cql_specific_user_single():
    req = ConfluenceDocSearchRequest(contributor_mode="user", contributor="hong")
    cql, err = _build_confluence_cql(req)
    assert err == ""
    assert 'contributor = "hong"' in cql


def test_cql_specific_user_multiple_uses_in_clause():
    req = ConfluenceDocSearchRequest(contributor_mode="user", contributor="hong, kim")
    cql, _ = _build_confluence_cql(req)
    assert 'contributor IN ("hong", "kim")' in cql


def test_cql_specific_user_mode_without_value_omits_clause():
    """'user' 모드인데 값이 비어 있으면 조건 없이 넘어간다 (다른 조건이 없으면 에러)."""
    req = ConfluenceDocSearchRequest(contributor_mode="user", contributor="")
    cql, err = _build_confluence_cql(req)
    assert cql == "" and "조건" in err


def test_cql_any_mode_requires_other_condition():
    req = ConfluenceDocSearchRequest(contributor_mode="any")
    cql, err = _build_confluence_cql(req)
    assert cql == "" and "조건" in err


def test_cql_any_mode_with_space_is_valid():
    req = ConfluenceDocSearchRequest(contributor_mode="any", space_key="OPS")
    cql, err = _build_confluence_cql(req)
    assert err == ""
    assert "contributor" not in cql
    assert 'space = "OPS"' in cql


def test_cql_combines_space_label_period_text_with_and():
    req = ConfluenceDocSearchRequest(
        space_key="OPS", labels=["runbook", "etcd"], updated_since_days=7, text="백업",
    )
    cql, err = _build_confluence_cql(req)
    assert err == ""
    assert 'contributor = currentUser()' in cql
    assert 'space = "OPS"' in cql
    assert 'label IN ("runbook", "etcd")' in cql
    assert 'lastmodified >= now("-7d")' in cql
    assert 'text ~ "백업"' in cql
    assert cql.count(" and ") == 5   # type + contributor + space + label + period + text = 6절 → 5개 and
    assert cql.endswith("order by lastmodified desc")


def test_cql_quote_escapes_quotes_and_backslashes():
    assert _cql_quote('a"b') == 'a\\"b'
    assert _cql_quote("a\\b") == "a\\\\b"


def test_cql_escapes_injection_attempt_in_space_key():
    req = ConfluenceDocSearchRequest(contributor_mode="any", space_key='X" or space = "Y')
    cql, _ = _build_confluence_cql(req)
    assert 'space = "X\\" or space = \\"Y"' in cql


# ── _import_changes ────────────────────────────────────────────────────────────
def test_import_changes_reports_title_and_version_diff():
    guide = _Guide(title="옛 제목", confluence_version=3)
    changes = _import_changes(guide, "새 제목", 5)
    fields = {c.field for c in changes}
    assert fields == {"title", "version", "content"}
    version = next(c for c in changes if c.field == "version")
    assert version.old == "3" and version.new == "5"


def test_import_changes_same_title_omits_title():
    guide = _Guide(title="같음", confluence_version=1)
    changes = _import_changes(guide, "같음", 2)
    assert {c.field for c in changes} == {"version", "content"}


# ── _inline_attachment_images ──────────────────────────────────────────────────
async def test_inline_swaps_attachment_url_for_data_uri():
    raw = b"\x89PNG-fake-bytes"
    svc = _FakeSvc({"a.png": {"status": "ok", "content": raw, "mime": "image/png"}})
    html = '<p><img src="https://c.example.com/download/attachments/77/a.png" alt="a.png"></p>'
    warnings: list[str] = []
    out = await _inline_attachment_images(svc, "77", html, ["a.png"], warnings)
    assert f'src="data:image/png;base64,{base64.b64encode(raw).decode()}"' in out
    assert warnings == []


async def test_inline_keeps_url_when_download_fails():
    svc = _FakeSvc({})
    html = '<img src="https://c.example.com/download/attachments/77/b.png">'
    warnings: list[str] = []
    out = await _inline_attachment_images(svc, "77", html, ["b.png"], warnings)
    assert "download/attachments/77/b.png" in out  # 원본 링크 유지
    assert any("다운로드 실패" in w for w in warnings)


async def test_inline_respects_per_image_size_cap():
    big = b"x" * (_INLINE_IMAGE_MAX + 1)
    svc = _FakeSvc({"big.png": {"status": "ok", "content": big, "mime": "image/png"}})
    html = '<img src="https://c.example.com/download/attachments/77/big.png">'
    warnings: list[str] = []
    out = await _inline_attachment_images(svc, "77", html, ["big.png"], warnings)
    assert "data:" not in out
    assert any("용량 제한" in w for w in warnings)
