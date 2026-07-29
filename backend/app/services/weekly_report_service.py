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
import re
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


_EPIC_KEY_RE = re.compile(r"^([A-Z][A-Z0-9_]*-\d+)\s*(.*)$")


def split_epic(value: str) -> tuple[str, str]:
    """Epic 표기("DL-12 인프라 고도화")를 (키, 이름)으로 나눈다.

    키 형식이 아니면 전체를 이름으로 본다(Epic Name 만 저장된 인스턴스 대비)."""
    v = (value or "").strip()
    m = _EPIC_KEY_RE.match(v)
    if m:
        return m.group(1), m.group(2).strip()
    return "", v


def _epic_of(item: WorkItem) -> str:
    """task(Epic) 축 — Jira 에서 수집한 Epic/상위 이슈. 없으면 미지정으로 묶는다.

    키/제목이 분리 저장된 신규 데이터는 그것으로 합본을 만들고(파싱 왕복을 피한다),
    구버전 행은 합본 컬럼(`jira_epic`)을 그대로 쓴다."""
    key = (getattr(item, "jira_epic_key", None) or "").strip()
    summary = (getattr(item, "jira_epic_summary", None) or "").strip()
    if key or summary:
        return f"{key} {summary}".strip()
    v = (getattr(item, "jira_epic", None) or "").strip()
    return v or "(Epic 미지정)"


def planned_rate(item: WorkItem, *, today: date) -> int:
    """계획진도율(%) — 일정상 지금까지 진행됐어야 할 비율.

    시작일~종료예정일 구간에서 오늘까지의 경과 비율. 종료예정일이 없으면 계획을 세울 수
    없으므로 완료면 100, 아니면 0 으로 본다(실적과 비교 가능한 최소 기준)."""
    start = _dt(item.started_at)
    due = _due_of(item)
    if not due:
        return 100 if classify_status(item, today=today) == STATUS_DONE else 0
    if not start or due <= start:
        return 100 if today >= due else 0
    if today >= due:
        return 100
    if today <= start:
        return 0
    return int(round((today - start).days / (due - start).days * 100))


def build_progress(items: list[WorkItem], *, today: date, base_url: str = "") -> list[dict]:
    """진척률 — category(component) × task(Epic) 로 묶은 집계.

    - 계획진도율: 그룹 내 항목별 계획진도율의 평균
    - 실적진도율: 완료 건수 / 전체 건수
    - 달성률: 실적 / 계획 (계획이 0 이면 실적이 있을 때 100, 없으면 0)
    """
    groups: dict[tuple[str, str], list[WorkItem]] = {}
    for it in items:
        groups.setdefault((_component_of(it), _epic_of(it)), []).append(it)

    rows: list[dict] = []
    for (category, epic), members in sorted(groups.items()):
        total = len(members)
        statuses = [classify_status(m, today=today) for m in members]
        done = sum(1 for st in statuses if st == STATUS_DONE)
        # 지연도 아직 진행 중인 일이므로 '진행중'에 포함해 전체 = 완료 + 진행중 이 되게 한다.
        in_progress = total - done
        planned = int(round(sum(planned_rate(m, today=today) for m in members) / total)) if total else 0
        actual = int(round(done / total * 100)) if total else 0
        if planned > 0:
            achievement = int(round(actual / planned * 100))
        else:
            achievement = 100 if actual > 0 else 0
        epic_key, epic_name = split_epic(epic)
        rows.append({
            "category": category,
            "epic": epic,
            "epic_key": epic_key,
            "epic_name": epic_name,
            "planned_rate": planned,
            "actual_rate": actual,
            "achievement_rate": achievement,
            "done_count": done,
            "in_progress_count": in_progress,
            "total_count": total,
            "epic_url": f"{base_url}/browse/{epic_key}" if (base_url and epic_key) else "",
        })
    return rows


def _component_of(item: WorkItem) -> str:
    """구분(component) — Jira component 원본이 있으면 그것을 쓰고, 없으면 PEP 필드로 폴백."""
    jira_components = getattr(item, "jira_components", None) or []
    if jira_components:
        first = str(jira_components[0]).strip()
        if first:
            return first
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
    base_url: str = "",
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
        epic_raw = (getattr(it, "jira_epic", None) or "").strip()
        epic_key, epic_name = split_epic(epic_raw)
        rows_detail.append({
            "component": _component_of(it),
            # task = Jira Epic, sub task = 그 Epic 아래의 이슈(현재 행) — 사용자 매핑 기준.
            "task": (epic_raw or "(Epic 미지정)")[:200],
            "epic_key": epic_key,
            "epic_name": epic_name,
            "epic_url": f"{base_url}/browse/{epic_key}" if (base_url and epic_key) else "",
            "sub_task": title[:200],
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

    progress = build_progress(items, today=today, base_url=base_url)
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
        "progress": progress,
        "details": rows_detail,
        "owners": rows_owner,
    }


def _issue_cell(row: dict) -> str:
    """sub task 셀 — "DL-12 제목 (상태)" 한 덩어리. 표 안에서 이슈를 바로 식별하게 한다.

    (HTML 링크는 `_table` 이 이스케이프하므로 여기서는 텍스트로 합친다 — Confluence 에서
    이슈 키는 자동 링크되는 경우가 많고, 링크가 필요하면 상세 표의 Jira 열을 쓴다.)"""
    parts = [p for p in [row.get("jira_key", ""), row.get("sub_task", "")] if p]
    text = " ".join(parts)
    status = row.get("status", "")
    return f"{text} ({status})" if status else text


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
        "<h2>1-1. 진척률</h2>",
        _table(
            ["category", "task(Epic)", "계획진도율(%)", "실적진도율(%)", "달성률(%)",
             "완료 Task", "진행중 Task", "전체 Task"],
            [[r["category"], r["epic"], str(r["planned_rate"]), str(r["actual_rate"]),
              str(r["achievement_rate"]), str(r["done_count"]), str(r["in_progress_count"]),
              str(r["total_count"])] for r in report.get("progress", [])],
        ),
        "<h2>2. 구분별 상세</h2>",
        _table(
            ["구분", "task", "sub task", "시작일", "종료 예정일", "종료일", "상태", "이슈", "비고"],
            [[r["component"], r["task"], _issue_cell(r), r["start"], r["due"], r["closed"],
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
