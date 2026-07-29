"""Jira 연결 복구 — 해제 / 갈아끼우기 / 죽은 링크 판별 단위 테스트.

Jira 이슈를 사용자가 직접 지웠거나 잘못된 프로젝트에 만들었을 때 PEP 에 남는 죽은 링크를
화면에서 정리할 수 있어야 한다. DB/네트워크 없이 순수 헬퍼 + `httpx.MockTransport` 로 검증한다.
"""
import asyncio

import httpx
import pytest

from app.routers.jira import _JIRA_LINK_ATTRS, _clear_jira_link, _parse_issue_key
from app.services.jira_service import JiraService

BASE = "https://jira.example.com"


class _Item:
    """WorkItem 최소 스텁 — 연결 필드만."""

    def __init__(self, **kw):
        for attr in _JIRA_LINK_ATTRS:
            setattr(self, attr, kw.get(attr, "채워짐"))
        self.title = kw.get("title", "제목")


# ── 이슈 키 파싱 ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("DL-42", "DL-42"),
    ("  dl-42  ", "DL-42"),
    ("https://jira.example.com/browse/DL-42", "DL-42"),
    ("https://jira.example.com/browse/DL-42?filter=1", "DL-42"),
    # URL 이면 /browse/ 뒤를 먼저 본다 — 쿼리스트링의 다른 키에 속지 않아야 한다.
    ("https://jira.example.com/browse/DL-42?jql=OPS-1", "DL-42"),
    ("PROJ_X-7", "PROJ_X-7"),
])
def test_parse_issue_key_accepts_key_and_url(raw, expected):
    assert _parse_issue_key(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "그냥 텍스트", "1234", "https://jira.example.com/"])
def test_parse_issue_key_rejects_garbage(raw):
    assert _parse_issue_key(raw) == ""


# ── 연결 해제 ──────────────────────────────────────────────────────────────────
def test_clear_jira_link_wipes_every_jira_field():
    """하나라도 남으면 '연결을 끊었는데 Jira 값이 보이는' 상태가 된다."""
    item = _Item()
    _clear_jira_link(item)
    for attr in _JIRA_LINK_ATTRS:
        assert getattr(item, attr) is None, f"{attr} 가 남아 있다"


def test_clear_jira_link_covers_epic_and_component_fields():
    """회귀 방지 — 예전 해제 코드는 5개 필드만 지워 Epic/컴포넌트 잔재가 남았다."""
    for attr in ("jira_epic", "jira_epic_key", "jira_epic_summary",
                 "jira_parent_key", "jira_components", "jira_labels",
                 "jira_issue_type", "jira_status_category"):
        assert attr in _JIRA_LINK_ATTRS


def test_clear_jira_link_reopens_provisioning():
    """`jira_issue_key` 가 비어야 Jira·Confluence 자동 생성이 다시 열린다 —
    잘못된 프로젝트에 만든 이슈를 지우고 재생성하는 복구 경로의 핵심."""
    item = _Item(jira_issue_key="DL-42")
    _clear_jira_link(item)
    assert item.jira_issue_key is None


# ── 404 판별 ───────────────────────────────────────────────────────────────────
def _svc(handler) -> JiraService:
    return JiraService(BASE, "tok", transport=httpx.MockTransport(handler))


def test_get_issue_404_is_flagged_missing():
    svc = _svc(lambda req: httpx.Response(404, json={}))
    res = asyncio.run(svc.get_issue("DL-42"))
    assert res["status"] == "error"
    assert res["missing"] is True


def test_get_issue_other_errors_are_not_missing():
    """500 을 '삭제됨'으로 오인하면 멀쩡한 연결을 끊게 된다."""
    svc = _svc(lambda req: httpx.Response(500, text="boom"))
    res = asyncio.run(svc.get_issue("DL-42"))
    assert res["status"] == "error"
    assert "missing" not in res


def test_get_issue_ok_is_not_missing():
    svc = _svc(lambda req: httpx.Response(200, json={"key": "DL-42", "fields": {}}))
    res = asyncio.run(svc.get_issue("DL-42"))
    assert res["status"] == "ok"
    assert "missing" not in res


def test_missing_does_not_imply_deleted():
    """권한 없는 이슈도 Jira 는 404 로 답한다 — 서버는 삭제/권한없음을 구분할 수 없으므로
    이 플래그만으로 자동 정리하면 안 된다(라우터는 status='missing' 으로 알리기만 한다)."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(404, json={"errorMessages": ["Issue does not exist or you do not have permission"]})

    res = asyncio.run(_svc(handler).get_issue("DL-42"))
    assert res["missing"] is True
    assert len(seen) == 1, "404 에 재시도하지 않는다"
