"""주간보고 생성 서비스 단위 테스트 (DB 세션 없이 순수 로직 위주).

`classify_status` / `week_range` / `render_storage_html` 는 순수 함수라 DB 없이 검증한다.
`build_report` 는 실 DB 조회가 필요해 여기서는 다루지 않고, 렌더링 계약만 고정한다.
"""
from datetime import date, datetime

from app.services import weekly_report_service as wrs


class _Item:
    """WorkItem 최소 스텁 — classify_status 가 읽는 속성만 갖는다."""

    def __init__(self, *, kanban_status="todo", closed_at=None, due_date=None):
        self.kanban_status = kanban_status
        self.closed_at = closed_at
        self.due_date = due_date


# ── 주 범위 ────────────────────────────────────────────────────────────────────
def test_week_range_returns_monday_to_friday():
    # 2026-07-29 는 수요일 → 그 주 월요일 27일, 금요일 31일
    start, end = wrs.week_range(date(2026, 7, 29))
    assert start == date(2026, 7, 27)
    assert end == date(2026, 7, 31)
    assert start.weekday() == 0 and end.weekday() == 4


def test_week_range_on_monday_and_friday_stays_in_same_week():
    assert wrs.week_range(date(2026, 7, 27)) == (date(2026, 7, 27), date(2026, 7, 31))
    assert wrs.week_range(date(2026, 7, 31)) == (date(2026, 7, 27), date(2026, 7, 31))


# ── 상태 판정 (진행/완료/지연) ──────────────────────────────────────────────────
def test_classify_done_by_kanban_status():
    item = _Item(kanban_status="done")
    assert wrs.classify_status(item, today=date(2026, 7, 31)) == wrs.STATUS_DONE


def test_classify_done_by_closed_at_even_if_overdue():
    """완료가 최우선 — 기한이 지났어도 닫혔으면 완료."""
    item = _Item(kanban_status="in_progress", closed_at=datetime(2026, 7, 30),
                 due_date=date(2026, 7, 1))
    assert wrs.classify_status(item, today=date(2026, 7, 31)) == wrs.STATUS_DONE


def test_classify_delayed_when_due_passed_and_open():
    item = _Item(kanban_status="in_progress", due_date=date(2026, 7, 20))
    assert wrs.classify_status(item, today=date(2026, 7, 31)) == wrs.STATUS_DELAYED


def test_classify_in_progress_when_due_future_or_missing():
    assert wrs.classify_status(_Item(due_date=date(2026, 8, 10)),
                               today=date(2026, 7, 31)) == wrs.STATUS_IN_PROGRESS
    assert wrs.classify_status(_Item(), today=date(2026, 7, 31)) == wrs.STATUS_IN_PROGRESS


def test_classify_not_delayed_on_due_date_itself():
    """기한 당일은 아직 지연이 아니다."""
    item = _Item(due_date=date(2026, 7, 31))
    assert wrs.classify_status(item, today=date(2026, 7, 31)) == wrs.STATUS_IN_PROGRESS


# ── Confluence storage HTML 렌더 ────────────────────────────────────────────────
def _sample_report() -> dict:
    return {
        "period_start": "2026-07-27",
        "period_end": "2026-07-31",
        "title": "주간보고 2026-07-27 ~ 2026-07-31",
        "summary": {"total": 3, "in_progress": 1, "done": 1, "delayed": 1, "note": ""},
        "details": [{
            "component": "K8s", "task": "노드 증설", "sub_task": "워커 3대",
            "start": "2026-07-27", "due": "2026-07-30", "closed": "",
            "status": "지연", "issue": "자재 지연", "note": "",
            "jira_key": "OPS-1", "jira_url": "",
        }],
        "owners": [{
            "task": "노드 증설", "assignee": "홍길동",
            "main_work": "증설 계획 수립", "issue_summary": "자재 지연",
        }],
    }


def test_render_storage_html_contains_three_tables_with_required_headers():
    html = wrs.render_storage_html(_sample_report())
    assert html.count("<table>") == 3
    # 표 1 — 요약
    for h in ("전체 task 수", "진행중", "완료", "지연", "비고"):
        assert f"<th>{h}</th>" in html
    # 표 2 — 구분별 상세
    for h in ("구분", "task", "sub task", "시작일", "종료 예정일", "종료일", "상태", "이슈"):
        assert f"<th>{h}</th>" in html
    # 표 3 — 담당자별
    for h in ("담당자", "주요 추진업무", "issue 요약"):
        assert f"<th>{h}</th>" in html
    assert "노드 증설" in html and "홍길동" in html


def test_render_storage_html_escapes_user_content():
    """본문이 그대로 Confluence 저장 포맷이 되므로 HTML 주입을 막아야 한다."""
    report = _sample_report()
    report["details"][0]["task"] = '<script>alert("x")</script>'
    report["owners"][0]["assignee"] = "a & b"
    html = wrs.render_storage_html(report)
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "a &amp; b" in html


def test_render_storage_html_handles_empty_rows():
    report = _sample_report()
    report["details"] = []
    report["owners"] = []
    html = wrs.render_storage_html(report)
    assert html.count("<table>") == 3   # 빈 표라도 구조는 유지
    assert "<tbody></tbody>" in html
