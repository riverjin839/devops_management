"""업무 일정 알람 — '내 업무' 중 지연 · 오늘 마감 · 내일 마감 판정 + 매일 아침 마감 알림.

판정 기준(화면 종 `GET /work-items/my-alarms` 와 아침 알림 `run_due_reminders` 가 같은 함수를 쓴다):
- 기준일 = 마감일(`due_date`)이 있으면 그것, 없으면 시작일(`started_at`, 서비스 시간대 날짜).
- 완료(`done`) 업무, 일정형(회의·교육) 업무는 뺀다 — 지난 회의가 '지연'으로 쌓이지 않게.
- 백로그는 '언젠가 할 일'이라 마감일이 명시된 경우에만 본다(오늘 요약 KPI 와 같은 규칙).
- '내일 마감'은 마감일이 명시된 업무만(시작일이 내일인 건 마감이 아니다).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import and_, or_

from app.config import settings

SCHEDULE_TYPES = ("meeting", "training")


def service_tz():
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        return ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return ZoneInfo("Asia/Seoul")


def local_today(now_utc: datetime | None = None) -> date:
    now = now_utc or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(service_tz()).date()


def local_date(dt: datetime | None) -> date | None:
    """DB 의 UTC-naive 시각 → 서비스 시간대 날짜."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(service_tz()).date()


def day_start_utc(d: date) -> datetime:
    """서비스 시간대 d 00:00 의 UTC-naive 시각."""
    return datetime.combine(d, time.min, tzinfo=service_tz()).astimezone(timezone.utc).replace(tzinfo=None)


def effective_due(item) -> tuple[date | None, str]:
    """(기준일, 근거) — 근거는 due_date | started_at."""
    if item.due_date:
        return item.due_date, "due_date"
    return local_date(item.started_at), "started_at"


def alarm_kind(item, today: date) -> str | None:
    """overdue | due_today | due_tomorrow | None."""
    if item.kanban_status == "done" or item.type in SCHEDULE_TYPES:
        return None
    due, basis = effective_due(item)
    if due is None:
        return None
    if item.kanban_status == "backlog" and basis != "due_date":
        return None
    if due < today:
        return "overdue"
    if due == today:
        return "due_today"
    if due == today + timedelta(days=1) and basis == "due_date":
        return "due_tomorrow"
    return None


def candidate_filter(WorkItem, today: date):
    """기준일이 내일 이전일 수 있는 미완료 업무 — SQL 에서 먼저 좁힌다(전체 업무를 내려받지 않게)."""
    tomorrow = today + timedelta(days=1)
    return and_(
        WorkItem.kanban_status != "done",
        WorkItem.type.notin_(SCHEDULE_TYPES),
        or_(
            WorkItem.due_date <= tomorrow,
            and_(WorkItem.due_date.is_(None), WorkItem.started_at < day_start_utc(tomorrow)),
        ),
    )


def my_name_keys(user) -> list[str]:
    return [x.strip() for x in [user.username, user.display_name, getattr(user, "employee_id", None)]
            if x and str(x).strip()]


def assignee_match_filter(WorkItem, keys: Iterable[str]):
    """담당자 칸 부분 일치(쉼표로 여러 명) — 정확 일치는 Python 에서 다시 본다."""
    conds = []
    for k in keys:
        pat = f"%{k}%"
        conds += [WorkItem.primary_assignee.ilike(pat), WorkItem.secondary_assignee.ilike(pat),
                  WorkItem.assignee.ilike(pat)]
    return or_(*conds) if conds else None


def is_mine(item, keys: Iterable[str], index=None, user=None) -> bool:
    """담당자 이름 목록에 내 username·이름·사번이 정확히 있는가.

    이름(display_name)이 같은 사람이 둘 이상이면 이름만으로는 내 업무라고 보지 않는다
    (`UserIndex.resolve` 가 None) — username·사번 일치만 인정한다.
    """
    from app.services.user_notify import assignee_names

    names = assignee_names(item)
    strong = {str(x).strip() for x in [getattr(user, "username", None), getattr(user, "employee_id", None)] if x}
    for n in names:
        if n in strong:
            return True
        if user is not None and n == (user.display_name or "").strip():
            if index is None:
                return True
            hit = index.resolve(n)
            if hit is not None and str(hit.id) == str(user.id):
                return True
    return False


def alarm_row(item, kind: str, today: date) -> dict[str, Any]:
    due, basis = effective_due(item)
    return {
        "id": str(item.id),
        "title": item.title,
        "content": item.content,
        "category": item.category,
        "type": item.type,
        "priority": item.priority,
        "kanban_status": item.kanban_status,
        "kind": kind,
        "due_date": due.isoformat() if due else None,
        "basis": basis,
        "overdue_days": (today - due).days if (due and kind == "overdue") else 0,
    }


def compute_my_alarms(db, base_query, user, today: date | None = None) -> dict[str, Any]:
    """현재 사용자의 일정 알람. `base_query` 는 가시 범위(테넌트)가 적용된 WorkItem 쿼리."""
    from app.models.user_notification import WorkAlarmDismissal
    from app.models.work_item import WorkItem
    from app.services.user_notify import UserIndex

    today = today or local_today()
    keys = my_name_keys(user)
    empty = {"today": today.isoformat(), "overdue": [], "due_today": [], "due_tomorrow": [], "dismissed": 0}
    match = assignee_match_filter(WorkItem, keys)
    if match is None:
        return empty
    items = base_query.filter(candidate_filter(WorkItem, today), match).all()
    dismissed = {
        str(r.work_item_id) for r in db.query(WorkAlarmDismissal).filter(
            WorkAlarmDismissal.user_id == user.id, WorkAlarmDismissal.alarm_date == today).all()
    }
    index = UserIndex.load(db)
    buckets: dict[str, list[dict[str, Any]]] = {"overdue": [], "due_today": [], "due_tomorrow": []}
    hidden = 0
    for it in items:
        if not is_mine(it, keys, index=index, user=user):
            continue
        kind = alarm_kind(it, today)
        if kind is None:
            continue
        if str(it.id) in dismissed:
            hidden += 1
            continue
        buckets[kind].append(alarm_row(it, kind, today))
    for rows in buckets.values():
        rows.sort(key=lambda r: (r["due_date"] or "", r["title"] or ""))
    return {"today": today.isoformat(), **buckets, "dismissed": hidden}


# ── 매일 아침 마감 알림 (Celery Beat `work-item-due-reminder`) ─────────────────
_REMINDER_TYPE = {
    "due_tomorrow": "work_item_due_soon",
    "due_today": "work_item_due_today",
}


def run_due_reminders(db, today: date | None = None) -> dict[str, int]:
    """담당자에게 내일 마감 · 오늘 마감 · 지연 전환(어제가 기준일) 알림을 하루 1회 보낸다.

    같은 날 다시 돌아도 `dedupe_key`(`<kind>:<item>:<date>`) 로 두 번 만들지 않는다.
    """
    from app.models.work_item import WorkItem
    from app.services.user_notify import PrefCache, UserIndex, create_notification, assignee_names

    today = today or local_today()
    yesterday = today - timedelta(days=1)
    items = db.query(WorkItem).filter(candidate_filter(WorkItem, today)).all()
    index = UserIndex.load(db)
    prefs = PrefCache(db)
    counts = {"work_item_due_soon": 0, "work_item_due_today": 0, "work_item_overdue": 0}
    for it in items:
        kind = alarm_kind(it, today)
        if kind == "overdue":
            due, _ = effective_due(it)
            if due != yesterday:
                continue  # 지연은 '지연된 첫날' 한 번만 — 매일 다시 보내지 않는다
            ntype = "work_item_overdue"
        elif kind in _REMINDER_TYPE:
            ntype = _REMINDER_TYPE[kind]
        else:
            continue
        due, _ = effective_due(it)
        label = (it.title or it.category or "업무").strip()
        title = {
            "work_item_due_soon": "내일 마감인 업무가 있습니다",
            "work_item_due_today": "오늘 마감인 업무가 있습니다",
            "work_item_overdue": "업무가 지연됐습니다",
        }[ntype]
        seen: set[str] = set()
        for nm in assignee_names(it):
            user = index.resolve(nm)
            if user is None or str(user.id) in seen:
                continue
            seen.add(str(user.id))
            n = create_notification(
                db, user=user, prefs=prefs, type=ntype, title=title,
                body=f"[{label}] 기준일 {due.isoformat() if due else '-'}",
                link=f"/tasks-mgmt/{it.id}", work_item_id=it.id,
                dedupe_key=f"{ntype}:{it.id}:{today.isoformat()}",
            )
            if n is not None:
                counts[ntype] += 1
                db.flush()  # 같은 실행 안에서도 dedupe 조회가 보이게
    db.commit()
    return counts
