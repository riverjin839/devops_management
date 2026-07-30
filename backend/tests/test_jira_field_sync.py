"""Jira 원본 항목 동기화 — 매핑/보존 규칙 단위 테스트.

DB/네트워크 불필요 — 순수 매핑 함수(`map_jira_issue`, `extract_*`)와 라우터의
보존 규칙 헬퍼(`_jira_sync_values`, `_diff_existing`)만 검증한다.
"""
from app.routers.jira import _diff_existing, _jira_sync_values
from app.services.jira_service import (
    extract_confluence_url,
    extract_epic_parts,
    extract_parent_parts,
    map_jira_issue,
)

BASE = "https://jira.example.com"
CONF = "https://confluence.example.com"


def _issue(**field_overrides) -> dict:
    fields = {
        "summary": "노드 NIC 점검",
        "description": "본문",
        "issuetype": {"name": "Sub-task"},
        "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
        "priority": {"name": "High"},
        "assignee": {"displayName": "홍길동"},
        "created": "2026-07-01T09:00:00.000+0900",
        "updated": "2026-07-20T09:00:00.000+0900",
        "components": [{"name": "K8s"}, {"name": "Network"}],
        "labels": ["infra", "urgent"],
        "parent": {"key": "DL-10", "fields": {"summary": "인프라 고도화"}},
    }
    fields.update(field_overrides)
    return {"id": "10001", "key": "DL-42", "fields": fields}


class _Existing:
    """WorkItem 최소 스텁 — 보존 규칙 헬퍼가 읽는 속성만."""

    def __init__(self, **kw):
        for attr in (
            "title", "content", "kanban_status", "priority", "jira_status", "category",
            "jira_issue_type", "jira_epic", "jira_parent_key", "jira_components",
            "jira_labels", "confluence_url",
        ):
            setattr(self, attr, kw.get(attr))


# ── 매핑 ───────────────────────────────────────────────────────────────────────
def test_map_jira_issue_carries_original_jira_axes():
    out = map_jira_issue(_issue(), BASE)
    assert out["jira_issue_type"] == "Sub-task"
    assert out["jira_status_category"] == "indeterminate"
    assert out["jira_components"] == ["K8s", "Network"]
    assert out["jira_labels"] == ["infra", "urgent"]
    assert out["jira_parent_key"] == "DL-10"
    assert out["jira_parent_summary"] == "인프라 고도화"


def test_map_jira_issue_uses_first_component_as_category():
    """진척률이 category × Epic 으로 묶이므로 전부 "Jira" 로 들어가면 축이 무너진다."""
    assert map_jira_issue(_issue(), BASE)["category"] == "K8s"


def test_map_jira_issue_falls_back_to_jira_category_without_components():
    assert map_jira_issue(_issue(components=[]), BASE)["category"] == "Jira"


def test_epic_parts_from_custom_field_dict():
    fields = {"customfield_10008": {"key": "DL-7", "fields": {"summary": "플랫폼 개선"}}}
    assert extract_epic_parts(fields, "customfield_10008") == ("DL-7", "플랫폼 개선")


def test_epic_parts_from_plain_key_string():
    assert extract_epic_parts({"customfield_10008": "DL-7"}, "customfield_10008") == ("DL-7", "")


def test_epic_parts_fall_back_to_parent_when_field_unset():
    """`jira_epic_field` 미설정 배포에서도 상위 이슈로 Epic 축을 잡을 수 있어야 한다."""
    assert extract_epic_parts(_issue()["fields"]) == ("DL-10", "인프라 고도화")
    assert extract_parent_parts(_issue()["fields"]) == ("DL-10", "인프라 고도화")


# ── Confluence 링크 추출 ───────────────────────────────────────────────────────
def test_extract_confluence_url_finds_link_in_description():
    fields = {"description": f"설계는 {CONF}/display/TEAM/설계 참고"}
    assert extract_confluence_url(fields, CONF) == f"{CONF}/display/TEAM/설계"


def test_extract_confluence_url_ignores_other_hosts():
    fields = {"description": "https://elsewhere.example.com/page"}
    assert extract_confluence_url(fields, CONF) == ""


def test_extract_confluence_url_needs_configured_base():
    """Base URL 미설정이면 오탐을 만들지 않고 아무것도 반환하지 않는다."""
    fields = {"description": f"{CONF}/display/TEAM/설계"}
    assert extract_confluence_url(fields, "") == ""


# ── 보존 규칙 ──────────────────────────────────────────────────────────────────
def test_sync_keeps_user_entered_confluence_url():
    existing = _Existing(confluence_url="https://confluence.example.com/mine")
    values = _jira_sync_values(existing, {"confluence_url": f"{CONF}/display/TEAM/other"})
    assert "confluence_url" not in values


def test_sync_fills_confluence_url_when_empty():
    values = _jira_sync_values(_Existing(), {"confluence_url": f"{CONF}/display/TEAM/x"})
    assert values["confluence_url"] == f"{CONF}/display/TEAM/x"


def test_sync_does_not_reset_category_when_issue_has_no_components():
    """component 없는 이슈가 사용자가 정한 분류를 폴백값("Jira")으로 되돌리면 안 된다."""
    existing = _Existing(category="Network 설정")
    values = _jira_sync_values(existing, {"category": "Jira", "jira_components": None})
    assert "category" not in values


def test_sync_keeps_epic_when_jira_returns_nothing():
    existing = _Existing(jira_epic="DL-7 플랫폼 개선")
    values = _jira_sync_values(existing, {"jira_epic": "", "jira_epic_key": ""})
    assert "jira_epic" not in values


def test_unchanged_stays_unchanged_on_repeated_import():
    """diff 와 apply 가 같은 규칙을 봐야 재가져오기가 매번 update 로 잡히지 않는다."""
    existing = _Existing(
        title="DL-42 노드 NIC 점검", content="본문", kanban_status="in_progress",
        priority="high", jira_status="In Progress", category="K8s",
        jira_issue_type="Sub-task", jira_epic="DL-10 인프라 고도화",
        jira_parent_key="DL-10", jira_components=["K8s", "Network"],
        jira_labels=["infra", "urgent"], confluence_url=None,
    )
    fields = map_jira_issue(_issue(), BASE)
    assert _diff_existing(existing, fields) == []


# ── Sub-task / Epic 생성 ───────────────────────────────────────────────────────
def test_create_issue_keeps_parent_when_retrying_without_optional_fields():
    """선택 필드가 프로젝트 스킴에 없어 400 이 나면 그것들만 빼고 재시도하는데,
    Sub-task 의 `parent` 는 Jira 가 필수로 요구하므로 재시도에서도 남아 있어야 한다."""
    import asyncio
    import json

    import httpx

    from app.services.jira_service import JiraService

    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        sent.append(body["fields"])
        if len(sent) == 1:  # 첫 시도는 선택 필드 때문에 거절
            return httpx.Response(400, json={"errors": {"customfield_10008": "not on screen"}})
        return httpx.Response(201, json={"key": "DL-99", "id": "20001"})

    svc = JiraService(BASE, "tok", transport=httpx.MockTransport(handler))
    res = asyncio.run(svc.create_issue(
        "DL", "하위 작업", issue_type="Sub-task", parent_key="DL-10",
        epic_key="DL-7", epic_field="customfield_10008", labels=["infra"],
    ))

    assert res["status"] == "ok" and res["key"] == "DL-99"
    assert len(sent) == 2, "400 이면 선택 필드를 빼고 1회 재시도해야 한다"
    assert sent[0]["parent"] == {"key": "DL-10"}
    assert sent[0]["customfield_10008"] == "DL-7"
    # 재시도: Epic/라벨은 빠지고 parent 는 유지.
    assert sent[1]["parent"] == {"key": "DL-10"}
    assert "customfield_10008" not in sent[1]
    assert "labels" not in sent[1]
