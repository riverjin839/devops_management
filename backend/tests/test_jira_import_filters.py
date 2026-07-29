"""Jira 가져오기 — 조건 조합 JQL 조립과 재가져오기 변경 diff 단위 테스트.

DB/네트워크 불필요 — 라우터의 순수 헬퍼(`_build_filter_jql`, `_diff_existing`)만 검증한다.
"""
from app.routers.jira import _build_filter_jql, _diff_existing, _jql_quote
from app.schemas.jira import JiraImportRequest


class _Existing:
    """WorkItem 최소 스텁 — _diff_existing 이 읽는 속성만."""

    def __init__(self, **kw):
        self.title = kw.get("title", "")
        self.content = kw.get("content", "")
        self.kanban_status = kw.get("kanban_status", "todo")
        self.priority = kw.get("priority", "medium")
        self.jira_status = kw.get("jira_status", "")


# ── JQL 조립 ───────────────────────────────────────────────────────────────────
def test_build_filter_jql_combines_conditions_with_and():
    jql, err = _build_filter_jql(JiraImportRequest(
        scope="filter", project_key="OPS", labels=["infra", "urgent"],
        components=["K8s"], statuses=["In Progress"],
    ))
    assert err == ""
    assert 'project = "OPS"' in jql
    assert 'labels IN ("infra", "urgent")' in jql
    assert 'component IN ("K8s")' in jql
    assert 'status IN ("In Progress")' in jql
    assert jql.count(" AND ") == 3
    assert jql.endswith("ORDER BY updated DESC")


def test_build_filter_jql_ignores_blank_values():
    jql, err = _build_filter_jql(JiraImportRequest(
        scope="filter", project_key="OPS", labels=["", "  "], components=[],
    ))
    assert err == ""
    assert "labels" not in jql and "component" not in jql
    assert 'project = "OPS"' in jql


def test_build_filter_jql_requires_at_least_one_condition():
    jql, err = _build_filter_jql(JiraImportRequest(scope="filter"))
    assert jql == ""
    assert "조건" in err


def test_build_filter_jql_current_user_and_recent_days():
    jql, err = _build_filter_jql(JiraImportRequest(
        scope="filter", assignee="currentUser()", updated_since_days=7,
    ))
    assert err == ""
    assert "assignee = currentUser()" in jql   # 함수는 따옴표로 감싸지 않는다
    assert "updated >= -7d" in jql


def test_build_filter_jql_named_assignee_is_quoted():
    jql, _ = _build_filter_jql(JiraImportRequest(scope="filter", assignee="hong"))
    assert 'assignee = "hong"' in jql


def test_jql_quote_escapes_quotes_and_backslashes():
    assert _jql_quote('a"b') == 'a\\"b'
    assert _jql_quote("a\\b") == "a\\\\b"


def test_build_filter_jql_escapes_injection_attempt():
    """따옴표가 들어와도 JQL 구조가 깨지지 않아야 한다."""
    jql, _ = _build_filter_jql(JiraImportRequest(
        scope="filter", project_key='X" OR project = "Y',
    ))
    assert 'project = "X\\" OR project = \\"Y"' in jql


# ── 재가져오기 변경 diff ────────────────────────────────────────────────────────
def test_diff_existing_detects_changed_fields_only():
    existing = _Existing(title="OPS-1 옛 제목", content="본문", kanban_status="todo",
                         priority="medium", jira_status="To Do")
    fields = {"title": "OPS-1 새 제목", "content": "본문", "kanban_status": "in_progress",
              "priority": "medium", "jira_status": "In Progress"}
    changes = _diff_existing(existing, fields)
    changed = {c.field for c in changes}
    assert changed == {"title", "kanban_status", "jira_status"}
    title_change = next(c for c in changes if c.field == "title")
    assert title_change.old == "OPS-1 옛 제목"
    assert title_change.new == "OPS-1 새 제목"
    assert title_change.label == "제목"


def test_diff_existing_returns_empty_when_identical():
    existing = _Existing(title="t", content="c", kanban_status="done",
                         priority="high", jira_status="Done")
    fields = {"title": "t", "content": "c", "kanban_status": "done",
              "priority": "high", "jira_status": "Done"}
    assert _diff_existing(existing, fields) == []


def test_diff_existing_treats_none_as_empty_string():
    """None ↔ "" 를 변경으로 오탐하지 않는다."""
    existing = _Existing(title="t", content="c", jira_status=None)
    fields = {"title": "t", "content": "c", "kanban_status": "todo",
              "priority": "medium", "jira_status": ""}
    assert _diff_existing(existing, fields) == []


def test_build_filter_jql_supports_multiple_projects():
    """프로젝트도 쉼표로 여러 개 — 컴포넌트/라벨과 같은 방식(개별 또는 조합)."""
    jql, err = _build_filter_jql(JiraImportRequest(scope="filter", project_key="OPS, INFRA"))
    assert err == ""
    assert 'project IN ("OPS", "INFRA")' in jql


def test_build_filter_jql_single_project_uses_equals():
    jql, _ = _build_filter_jql(JiraImportRequest(scope="filter", project_key="OPS"))
    assert 'project = "OPS"' in jql


def test_build_filter_jql_component_only_is_valid():
    """컴포넌트만 단독으로도 가져올 수 있어야 한다."""
    jql, err = _build_filter_jql(JiraImportRequest(scope="filter", components=["K8s"]))
    assert err == ""
    assert jql.startswith('component IN ("K8s")')


def test_build_filter_jql_label_only_is_valid():
    jql, err = _build_filter_jql(JiraImportRequest(scope="filter", labels=["infra"]))
    assert err == ""
    assert jql.startswith('labels IN ("infra")')
