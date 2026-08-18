"""Jira 원본 항목 동기화 — 매핑/보존 규칙 단위 테스트.

DB/네트워크 불필요 — 순수 매핑 함수(`map_jira_issue`, `extract_*`)와 라우터의
보존 규칙 헬퍼(`_jira_sync_values`, `_diff_existing`)만 검증한다.
"""
from app.routers.jira import _diff_existing, _jira_sync_values, _resolve_epic_chain
from app.services.jira_service import (
    extract_confluence_url,
    extract_epic_parts,
    extract_parent_parts,
    extract_sprint_name,
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
            "jira_labels", "confluence_url", "primary_assignee", "due_date",
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
    """diff 와 apply 가 같은 규칙을 봐야 재가져오기가 매번 update 로 잡히지 않는다.

    title 은 요약문만 담는다(이슈 키 접두어 없음) — map_jira_issue 가 반환하는 형식과 맞춰야
    "이미 최신값" 케이스를 검증할 수 있다."""
    existing = _Existing(
        title="노드 NIC 점검", content="본문", kanban_status="in_progress",
        priority="high", jira_status="In Progress", category="K8s",
        jira_issue_type="Sub-task", jira_epic="DL-10 인프라 고도화",
        jira_parent_key="DL-10", jira_components=["K8s", "Network"],
        jira_labels=["infra", "urgent"], confluence_url=None,
        primary_assignee="홍길동", due_date=None,
    )
    fields = map_jira_issue(_issue(), BASE)
    assert _diff_existing(existing, fields) == []


# ── Sub-task / Epic 생성 ───────────────────────────────────────────────────────
def test_create_issue_keeps_parent_when_retrying_without_optional_fields():
    """선택 필드가 프로젝트 스킴에 없어 400 이 나면 **그 필드만** 빼고 재시도한다 —
    Sub-task 의 `parent` 는 Jira 가 필수로 요구하므로 재시도에서도 남아 있어야 하고,
    400 을 유발하지 않은 다른 선택 필드(라벨)는 통째로 같이 빠지면 안 된다(회귀:
    담당자/우선순위 등 딴 필드 때문에 400 이 나도 라벨·컴포넌트가 함께 날아가
    Jira 화면에 반영되지 않던 버그)."""
    import asyncio
    import json

    import httpx

    from app.services.jira_service import JiraService

    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        sent.append(body["fields"])
        if len(sent) == 1:  # 첫 시도는 Epic 필드만 스킴에 없어 거절
            return httpx.Response(400, json={"errors": {"customfield_10008": "not on screen"}})
        return httpx.Response(201, json={"key": "DL-99", "id": "20001"})

    svc = JiraService(BASE, "tok", transport=httpx.MockTransport(handler))
    res = asyncio.run(svc.create_issue(
        "DL", "하위 작업", issue_type="Sub-task", parent_key="DL-10",
        epic_key="DL-7", epic_field="customfield_10008", labels=["infra"],
    ))

    assert res["status"] == "ok" and res["key"] == "DL-99"
    assert len(sent) == 2, "400 이면 그 필드만 빼고 1회 재시도해야 한다"
    assert sent[0]["parent"] == {"key": "DL-10"}
    assert sent[0]["customfield_10008"] == "DL-7"
    # 재시도: 400 을 유발한 Epic 필드만 빠지고, parent 와 무관한 라벨은 그대로 유지.
    assert sent[1]["parent"] == {"key": "DL-10"}
    assert "customfield_10008" not in sent[1]
    assert sent[1]["labels"] == ["infra"]


# ── 담당자/마감일 — 이제 title/content 와 동일하게 Jira 가 무조건 소유 ───────────────
def test_sync_assignee_now_overwrites_existing_value():
    """이전엔 담당자가 비어있을 때만 채웠지만, 이름 매핑이 정확해진 뒤로는 재배정 여부와
    무관하게 매 동기화마다 Jira 쪽 값으로 최신화한다."""
    existing = _Existing(primary_assignee="이전담당자")
    values = _jira_sync_values(existing, {"primary_assignee": "새담당자"})
    assert values["primary_assignee"] == "새담당자"


def test_sync_due_date_always_included_even_when_cleared():
    """마감일은 Jira 가 소유 — Jira 쪽에서 지워지면(None) PEP 값도 따라 지워진다."""
    existing = _Existing(due_date="2026-08-01")
    values = _jira_sync_values(existing, {"due_date": None})
    assert values["due_date"] is None


# ── Confluence 링크 전체 목록 — "이번엔 안 봤음" 과 "봤는데 0건" 구분 ────────────────
def test_sync_confluence_links_untouched_when_not_attempted():
    existing = _Existing()
    assert "confluence_links" not in _jira_sync_values(existing, {})


def test_sync_confluence_links_replaces_with_latest_when_attempted():
    existing = _Existing()
    values = _jira_sync_values(existing, {"confluence_links": []})
    assert values["confluence_links"] == []


# ── map_jira_issue: epic_override / remote_confluence_links / due_date ──────────
def test_map_jira_issue_epic_override_replaces_self_extraction():
    out = map_jira_issue(
        _issue(), BASE, epic_field="customfield_10008", epic_override=("DL-1", "플랫폼 개선"),
    )
    assert out["jira_epic_key"] == "DL-1"
    assert out["jira_epic_summary"] == "플랫폼 개선"


def test_map_jira_issue_confluence_links_only_when_remote_links_param_given():
    out_not_attempted = map_jira_issue(_issue(), BASE, confluence_base_url=CONF)
    assert "confluence_links" not in out_not_attempted

    out_attempted = map_jira_issue(
        _issue(), BASE, confluence_base_url=CONF,
        remote_confluence_links=[{"url": f"{CONF}/x", "title": "X"}],
    )
    assert out_attempted["confluence_links"] == [{"url": f"{CONF}/x", "title": "X"}]
    # 대표 링크(confluence_url) 는 본문 스캔이 실패하면 원격 링크 첫 값으로 폴백.
    assert out_attempted["confluence_url"] == f"{CONF}/x"


def test_map_jira_issue_maps_due_date():
    out = map_jira_issue(_issue(duedate="2026-08-20"), BASE)
    assert str(out["due_date"]) == "2026-08-20"


def test_map_jira_issue_due_date_none_when_unset():
    assert map_jira_issue(_issue(), BASE)["due_date"] is None


# ── extract_sprint_name ───────────────────────────────────────────────────────
def test_extract_sprint_name_from_greenhopper_string():
    raw = (
        "com.atlassian.greenhopper.service.sprint.Sprint@1a2b3c4d[id=5,rapidViewId=1,"
        "state=ACTIVE,name=Sprint 12,startDate=2026-08-01,endDate=2026-08-14]"
    )
    assert extract_sprint_name({"customfield_10007": [raw]}, "customfield_10007") == "Sprint 12"


def test_extract_sprint_name_from_dict_list_uses_last():
    fields = {"customfield_10007": [{"id": 4, "name": "Sprint 11"}, {"id": 5, "name": "Sprint 12"}]}
    assert extract_sprint_name(fields, "customfield_10007") == "Sprint 12"


def test_extract_sprint_name_empty_without_field_configured():
    assert extract_sprint_name({"customfield_10007": [{"name": "Sprint 1"}]}, "") == ""


def test_extract_sprint_name_missing_value():
    assert extract_sprint_name({}, "customfield_10007") == ""


# ── _resolve_epic_chain — Epic→Task→Sub-task 체인 해석, 형제 Sub-task 공유 상위 dedup ──
def test_resolve_epic_chain_dedupes_shared_parent():
    import asyncio

    import httpx

    from app.services.jira_service import JiraService

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={
            "key": "DL-10",
            "fields": {"customfield_10008": {"key": "DL-1", "fields": {"summary": "플랫폼 개선"}}},
        })

    svc = JiraService(BASE, "tok", transport=httpx.MockTransport(handler))

    # 두 Sub-task 가 같은 상위(Task, DL-10) 를 공유 — 자신에게는 Epic Link 값이 없다.
    issues = [
        {"key": "DL-42", "fields": {"issuetype": {"name": "Sub-task"}, "parent": {"key": "DL-10"}}},
        {"key": "DL-43", "fields": {"issuetype": {"name": "Sub-task"}, "parent": {"key": "DL-10"}}},
        # 자기 자신에게 이미 Epic Link 가 있는 이슈 — 추가 조회 대상이 아니다.
        {"key": "DL-44", "fields": {"customfield_10008": "DL-9", "parent": {"key": "DL-11"}}},
    ]

    chain = asyncio.run(_resolve_epic_chain(svc, issues, "customfield_10008"))

    assert len(calls) == 1, "형제 Sub-task 가 같은 상위를 공유하면 1회만 조회해야 한다"
    assert chain == {"DL-10": ("DL-1", "플랫폼 개선")}


def test_resolve_epic_chain_noop_without_epic_field_configured():
    import asyncio

    result = asyncio.run(_resolve_epic_chain(None, [{"key": "DL-1", "fields": {}}], ""))
    assert result == {}
