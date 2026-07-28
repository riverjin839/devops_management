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
        "progress": [{
            "category": "K8s", "epic": "OPS-100 인프라 고도화",
            "planned_rate": 60, "actual_rate": 33, "achievement_rate": 55,
            "done_count": 1, "in_progress_count": 2, "total_count": 3,
        }],
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


def test_render_storage_html_contains_all_tables_with_required_headers():
    html = wrs.render_storage_html(_sample_report())
    # 요약 · 진척률 · 구분별 상세 · 담당자별 = 4개 표
    assert html.count("<table>") == 4
    # 표 1 — 요약
    for h in ("전체 task 수", "진행중", "완료", "지연", "비고"):
        assert f"<th>{h}</th>" in html
    # 표 2 — 구분별 상세
    for h in ("구분", "task", "sub task", "시작일", "종료 예정일", "종료일", "상태", "이슈"):
        assert f"<th>{h}</th>" in html
    # 표 3 — 담당자별
    for h in ("담당자", "주요 추진업무", "issue 요약"):
        assert f"<th>{h}</th>" in html
    # 표 1-1 — 진척률
    for h in ("category", "task(Epic)", "계획진도율(%)", "실적진도율(%)", "달성률(%)",
              "완료 Task", "진행중 Task", "전체 Task"):
        assert f"<th>{h}</th>" in html
    assert "노드 증설" in html and "홍길동" in html
    assert "OPS-100 인프라 고도화" in html


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
    report["progress"] = []
    html = wrs.render_storage_html(report)
    assert html.count("<table>") == 4   # 빈 표라도 구조는 유지
    assert "<tbody></tbody>" in html


# ── 진척률 집계 ────────────────────────────────────────────────────────────────
class _ProgressItem(_Item):
    """진척률 집계가 읽는 속성까지 갖춘 스텁."""

    def __init__(self, *, category="K8s", epic="OPS-1 에픽", started_at=None, **kw):
        super().__init__(**kw)
        self.category = category
        self.service = None
        self.jira_epic = epic
        self.started_at = started_at


def test_planned_rate_uses_elapsed_schedule_ratio():
    item = _ProgressItem(started_at=datetime(2026, 7, 1), due_date=date(2026, 7, 11))
    # 7/6 은 10일 구간의 절반
    assert wrs.planned_rate(item, today=date(2026, 7, 6)) == 50
    assert wrs.planned_rate(item, today=date(2026, 7, 1)) == 0
    assert wrs.planned_rate(item, today=date(2026, 7, 20)) == 100


def test_planned_rate_without_due_falls_back_to_done_state():
    open_item = _ProgressItem(started_at=datetime(2026, 7, 1))
    done_item = _ProgressItem(started_at=datetime(2026, 7, 1), kanban_status="done")
    assert wrs.planned_rate(open_item, today=date(2026, 7, 6)) == 0
    assert wrs.planned_rate(done_item, today=date(2026, 7, 6)) == 100


def test_build_progress_groups_by_category_and_epic():
    items = [
        _ProgressItem(category="K8s", epic="E1", started_at=datetime(2026, 7, 1),
                      due_date=date(2026, 7, 11), kanban_status="done"),
        _ProgressItem(category="K8s", epic="E1", started_at=datetime(2026, 7, 1),
                      due_date=date(2026, 7, 11)),
        _ProgressItem(category="Network", epic="E2", started_at=datetime(2026, 7, 1),
                      due_date=date(2026, 7, 11)),
    ]
    rows = wrs.build_progress(items, today=date(2026, 7, 6))
    assert len(rows) == 2
    k8s = next(r for r in rows if r["category"] == "K8s")
    assert k8s["epic"] == "E1"
    assert k8s["total_count"] == 3 - 1  # K8s 그룹은 2건
    assert k8s["done_count"] == 1 and k8s["in_progress_count"] == 1
    assert k8s["actual_rate"] == 50   # 1/2 완료
    # 계획진도율은 **일정 기준**이라 완료 여부와 무관 — 두 건 모두 구간의 절반 경과.
    assert k8s["planned_rate"] == 50
    assert k8s["achievement_rate"] == 100     # 실적(50) / 계획(50)


def test_build_progress_missing_epic_is_grouped_as_unassigned():
    rows = wrs.build_progress([_ProgressItem(epic="", started_at=datetime(2026, 7, 1))],
                              today=date(2026, 7, 6))
    assert rows[0]["epic"] == "(Epic 미지정)"


def test_build_progress_empty_input():
    assert wrs.build_progress([], today=date(2026, 7, 6)) == []
