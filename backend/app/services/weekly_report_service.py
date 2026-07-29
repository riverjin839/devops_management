"""주간보고 생성 — 한 주(월~금)의 업무를 집계해 3개 표로 만든다.

집계 대상은 `work_items` 이며, Jira 에서 가져온 항목(`jira_issue_key` 보유)과 PEP 자체 업무를
동일하게 다룬다. 결과는 두 형태로 낸다:

 - `build_report()` → 순수 dict (프론트 미리보기/표 렌더용). **순수 함수 + DB 조회만** 이라
   테스트가 쉽다.
 - `render_storage_html()` → Confluence storage format(HTML) 문자열. 그대로 페이지 본문이 된다.

표 구성 (요청 사양):
 1. 전체 요약 — 전체 task 수 | 진행중 | 완료 | 지연 | 비고
 2. 구분(component)별 상세 — 구분 / task / sub task / 시작일 / 종료예정일 / 종료일 /
    상태(진행·지연·완료) / 이슈 / 비고
 3. 담당자별 — task / 담당자 / 주요 추진업무 / 이슈 요약

"지연" 판정: 완료되지 않았는데 종료예정일(due)이 기준일보다 과거면 지연.
"""
from __future__ import annotations

import html
import logging
from datetime import date, datetime, timedelta
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.work_item import WorkItem

logger = logging.getLogger(__name__)

# 상태 표기 (요청 사양의 한글 라벨).
STATUS_IN_PROGRESS = "진행"
STATUS_DONE = "완료"
STATUS_DELAYED = "지연"


def week_range(anchor: Optional[date] = None) -> tuple[date, date]:
    """기준일이 속한 주의 (월요일, 금요일). 기준일 미지정 시 오늘."""
    d = anchor or date.today()
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=4)


def _dt(value) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


def _fmt(d: Optional[date]) -> str:
    return d.strftime("%Y-%m-%d") if d else ""


def _due_of(item: WorkItem) -> Optional[date]:
    """종료 예정일 — 모델에 due 전용 컬럼이 없을 수 있어 후보를 순서대로 본다."""
    for attr in ("due_date", "planned_end_at", "scheduled_end_at", "end_at"):
        v = getattr(item, attr, None)
        if v is not None:
            return _dt(v)
    return None


def classify_status(item: WorkItem, *, today: Optional[date] = None) -> str:
    """진행 / 완료 / 지연 판정. 완료가 최우선, 그다음 기한 초과면 지연."""
    ref = today or date.today()
    if (item.kanban_status or "") == "done" or item.closed_at is not None:
        return STATUS_DONE
    due = _due_of(item)
    if due and due < ref:
        return STATUS_DELAYED
    return STATUS_IN_PROGRESS


def _component_of(item: WorkItem) -> str:
    """구분(component) — Jira component 를 저장하는 전용 컬럼이 없으므로 category/service 순."""
    for attr in ("component", "category", "service"):
        v = (getattr(item, attr, None) or "").strip()
        if v:
            return v
    return "(미분류)"


def collect_items(db: Session, start: date, end: date) -> list[WorkItem]:
    """해당 주와 겹치는 업무 — 주중에 진행/완료됐거나, 아직 열려 있는 항목.

    기준: 시작일이 주 종료일 이전이고, (미완료이거나 완료일이 주 시작일 이후)."""
    start_dt = datetime.combine(start, datetime.min.time())
    end_dt = datetime.combine(end, datetime.max.time())
    q = (
        db.query(WorkItem)
        .filter(WorkItem.started_at <= end_dt)
        .filter(or_(WorkItem.closed_at.is_(None), WorkItem.closed_at >= start_dt))
        .order_by(WorkItem.started_at.asc())
    )
    return list(q.all())


def build_report(
    db: Session, *, anchor: Optional[date] = None, project_filter: str = "",
) -> dict[str, Any]:
    """주간보고 데이터 구성 — 3개 표를 그대로 담은 dict."""
    start, end = week_range(anchor)
    items = collect_items(db, start, end)
    if project_filter:
        pf = project_filter.strip().lower()
        items = [
            i for i in items
            if pf in ((i.jira_issue_key or "").lower() + " " + (i.category or "").lower())
        ]

    today = end  # 주 종료일 기준으로 지연 판정 (주간보고 시점)
    rows_detail: list[dict] = []
    rows_owner: list[dict] = []
    counts = {STATUS_IN_PROGRESS: 0, STATUS_DONE: 0, STATUS_DELAYED: 0}

    for it in items:
        status = classify_status(it, today=today)
        counts[status] = counts.get(status, 0) + 1
        title = (it.title or it.content or "").strip()
        rows_detail.append({
            "component": _component_of(it),
            "task": title[:200],
            "sub_task": (it.resolution or "").strip()[:200],
            "start": _fmt(_dt(it.started_at)),
            "due": _fmt(_due_of(it)),
            "closed": _fmt(_dt(it.closed_at)),
            "status": status,
            "issue": (it.remarks or "").strip()[:200] if status == STATUS_DELAYED else "",
            "note": (it.remarks or "").strip()[:200],
            "jira_key": it.jira_issue_key or "",
            "jira_url": it.jira_url or "",
        })
        rows_owner.append({
            "task": title[:200],
            "assignee": (it.primary_assignee or it.assignee or "").strip(),
            "main_work": (it.content or "").strip()[:300],
            "issue_summary": (it.remarks or "").strip()[:200],
        })

    summary = {
        "total": len(items),
        "in_progress": counts.get(STATUS_IN_PROGRESS, 0),
        "done": counts.get(STATUS_DONE, 0),
        "delayed": counts.get(STATUS_DELAYED, 0),
        "note": "",
    }
    return {
        "period_start": _fmt(start),
        "period_end": _fmt(end),
        "title": f"주간보고 {_fmt(start)} ~ {_fmt(end)}",
        "summary": summary,
        "details": rows_detail,
        "owners": rows_owner,
    }


def _cell(v: str) -> str:
    return f"<td>{html.escape(v or '')}</td>"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    head = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(_cell(c) for c in r) + "</tr>" for r in rows)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def render_storage_html(report: dict[str, Any]) -> str:
    """Confluence storage format(HTML) — 표 3개. 값은 전부 이스케이프한다."""
    s = report.get("summary", {}) or {}
    parts: list[str] = [
        f"<p>기간: {html.escape(report.get('period_start', ''))} ~ "
        f"{html.escape(report.get('period_end', ''))}</p>",
        "<h2>1. 전체 요약</h2>",
        _table(
            ["전체 task 수", "진행중", "완료", "지연", "비고"],
            [[str(s.get("total", 0)), str(s.get("in_progress", 0)), str(s.get("done", 0)),
              str(s.get("delayed", 0)), s.get("note", "")]],
        ),
        "<h2>2. 구분별 상세</h2>",
        _table(
            ["구분", "task", "sub task", "시작일", "종료 예정일", "종료일", "상태", "이슈", "비고"],
            [[r["component"], r["task"], r["sub_task"], r["start"], r["due"], r["closed"],
              r["status"], r["issue"], r["note"]] for r in report.get("details", [])],
        ),
        "<h2>3. 담당자별 추진 업무</h2>",
        _table(
            ["task", "담당자", "주요 추진업무", "issue 요약"],
            [[r["task"], r["assignee"], r["main_work"], r["issue_summary"]]
             for r in report.get("owners", [])],
        ),
    ]
    return "".join(parts)
