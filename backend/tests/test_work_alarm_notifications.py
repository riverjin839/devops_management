"""업무 알람 상용화(P0~P3) 회귀 테스트.

- 받는 사람을 users.id 로 판정(동명이인 오배달 방지) + 예전 문자열 행 호환
- 일정 알람: 마감일 우선 판정, 회의·교육 제외, 백로그 규칙, '오늘 그만 보기'
- 업무 이벤트 알림(배정·상태·댓글·멘션), 마감 알림 중복 방지
- 사용자 설정(앱 끔/전부 끔), 외부 발송(방해 금지·하루 요약), 채널 비밀 값 가림·URL 검증
라우터 함수를 FastAPI DI 없이 직접 호출한다(다른 실통합 테스트와 같은 패턴).
"""
import os
import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.user_notification import (  # noqa: E402
    UserNotification, UserNotificationPref, WorkAlarmDismissal,
)
from app.models.work_item import WorkItem  # noqa: E402
from app.models.work_item_comment import WorkItemComment  # noqa: E402
from app.routers import notifications as nr  # noqa: E402
from app.services import user_notify as un  # noqa: E402
from app.services import user_notify_delivery as ud  # noqa: E402
from app.services import work_alarms as wa  # noqa: E402
from app.services.tenant_scope import TenantScope  # noqa: E402

TAG = f"wa{uuid.uuid4().hex[:6]}"
ADMIN_SCOPE = TenantScope(is_admin=True, tenant_ids=frozenset())


@pytest.fixture
def db():
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _user(db, key, display, role="operator", email=None):
    u = User(id=str(uuid.uuid4()), username=f"{TAG}-{key}", display_name=display, hashed_password="x",
             role=role, is_active=True, email=email)
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def people(db):
    out = {
        "kim1": _user(db, "kim1", f"{TAG}김철수"),
        "kim2": _user(db, "kim2", f"{TAG}김철수"),        # 동명이인
        "lee": _user(db, "lee", f"{TAG}이영희", email="lee@example.com"),
        "park": _user(db, "park", f"{TAG}박민수"),
    }
    yield out
    ids = [u.id for u in out.values()]
    names = [u.username for u in out.values()] + [u.display_name for u in out.values()]
    db.rollback()
    db.query(UserNotification).filter(
        (UserNotification.recipient_user_id.in_(ids)) | (UserNotification.recipient.in_(names))
    ).delete(synchronize_session=False)
    db.query(WorkAlarmDismissal).filter(WorkAlarmDismissal.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(UserNotificationPref).filter(UserNotificationPref.user_id.in_(ids)).delete(synchronize_session=False)
    items = db.query(WorkItem).filter(WorkItem.category.like(f"{TAG}%")).all()
    for it in items:
        db.query(WorkItemComment).filter(WorkItemComment.work_item_id == it.id).delete(synchronize_session=False)
        db.delete(it)
    db.commit()
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


def _item(db, assignee, **kw):
    it = WorkItem(
        id=uuid.uuid4(), type=kw.pop("type", "task"), assignee=assignee, primary_assignee=assignee,
        category=f"{TAG}-cat", title=kw.pop("title", "업무"), content="본문",
        started_at=kw.pop("started_at", datetime.utcnow()), kanban_status=kw.pop("kanban_status", "todo"),
        **kw,
    )
    db.add(it)
    db.commit()
    db.refresh(it)
    return it


def _mine(db, user):
    return db.query(UserNotification).filter(nr._mine_filter(db, user)).all()


# ── 받는 사람 판정 ────────────────────────────────────────────────────────────
def test_ambiguous_display_name_is_not_delivered(db, people):
    idx = un.UserIndex.load(db)
    assert idx.resolve(people["kim1"].display_name) is None          # 동명이인 → 아무에게도
    assert idx.resolve(people["lee"].display_name).id == people["lee"].id
    assert idx.resolve(people["kim1"].username).id == people["kim1"].id


def test_legacy_rows_match_username_and_unique_name_only(db, people):
    db.add_all([
        UserNotification(recipient=people["kim1"].display_name, type="info", title="동명이인"),
        UserNotification(recipient=people["kim1"].username, type="info", title="username"),
        UserNotification(recipient=people["lee"].display_name, type="info", title="유일한 이름"),
    ])
    db.commit()
    assert {n.title for n in _mine(db, people["kim1"])} == {"username"}
    assert {n.title for n in _mine(db, people["kim2"])} == set()
    assert {n.title for n in _mine(db, people["lee"])} == {"유일한 이름"}


def test_new_rows_use_user_id(db, people):
    n = un.create_notification(db, user=people["kim2"], type="work_item_comment", title="t")
    db.commit()
    assert n.recipient_user_id == people["kim2"].id
    assert [x.title for x in _mine(db, people["kim2"])] == ["t"]
    assert _mine(db, people["kim1"]) == []


# ── 사용자 설정 ──────────────────────────────────────────────────────────────
def test_prefs_inapp_off_keeps_history_only_and_all_off_skips(db, people):
    lee = people["lee"]
    db.add(UserNotificationPref(user_id=lee.id, prefs={
        "work_item_comment": {"inapp": False, "email": True, "webhook": False},
        "work_item_status": {"inapp": False, "email": False, "webhook": False},
    }))
    db.commit()
    a = un.create_notification(db, user=lee, type="work_item_comment", title="c")
    b = un.create_notification(db, user=lee, type="work_item_status", title="s")
    db.commit()
    assert a.is_read is True and a.external_status == "pending" and a.external_channels == ["email"]
    assert b is None


def test_dedupe_key_prevents_duplicates(db, people):
    u = people["park"]
    assert un.create_notification(db, user=u, type="work_item_due_today", title="a", dedupe_key="k1")
    db.flush()
    assert un.create_notification(db, user=u, type="work_item_due_today", title="a", dedupe_key="k1") is None


# ── 일정 알람 ────────────────────────────────────────────────────────────────
def test_my_alarms_uses_due_date_and_excludes_schedule_types(db, people):
    lee = people["lee"]
    today = wa.local_today()
    long_ago = datetime.utcnow() - timedelta(days=30)
    in_progress_not_due = _item(db, lee.display_name, title="시작만 지남", started_at=long_ago,
                                due_date=today + timedelta(days=5), kanban_status="in_progress")
    overdue = _item(db, lee.username, title="마감 지남", started_at=long_ago, due_date=today - timedelta(days=2))
    tomorrow = _item(db, f"{people['park'].username},{lee.display_name}", title="내일",
                     started_at=long_ago, due_date=today + timedelta(days=1))
    _item(db, lee.username, title="지난 회의", type="meeting", started_at=long_ago)
    _item(db, lee.username, title="백로그", kanban_status="backlog", started_at=long_ago)
    _item(db, lee.username, title="완료", kanban_status="done", started_at=long_ago)
    started_today = _item(db, lee.username, title="오늘 시작", started_at=wa.day_start_utc(today) + timedelta(hours=3))

    res = wa.compute_my_alarms(db, db.query(WorkItem), lee, today)
    assert [r["id"] for r in res["overdue"]] == [str(overdue.id)]
    assert res["overdue"][0]["overdue_days"] == 2 and res["overdue"][0]["basis"] == "due_date"
    assert [r["id"] for r in res["due_today"]] == [str(started_today.id)]
    assert [r["id"] for r in res["due_tomorrow"]] == [str(tomorrow.id)]
    assert str(in_progress_not_due.id) not in {r["id"] for b in ("overdue", "due_today", "due_tomorrow") for r in res[b]}


def test_ambiguous_name_assignee_is_not_my_alarm(db, people):
    today = wa.local_today()
    _item(db, people["kim1"].display_name, due_date=today)
    assert wa.compute_my_alarms(db, db.query(WorkItem), people["kim1"], today)["due_today"] == []


def test_dismiss_hides_line_for_today_and_restore(db, people):
    from app.routers.work_items import dismiss_my_alarm, get_my_alarms, restore_my_alarms

    lee = people["lee"]
    it = _item(db, lee.username, due_date=wa.local_today())
    assert len(get_my_alarms(db=db, scope=ADMIN_SCOPE, user=lee)["due_today"]) == 1
    dismiss_my_alarm(item_id=it.id, db=db, scope=ADMIN_SCOPE, user=lee)
    dismiss_my_alarm(item_id=it.id, db=db, scope=ADMIN_SCOPE, user=lee)  # 두 번 눌러도 1행
    res = get_my_alarms(db=db, scope=ADMIN_SCOPE, user=lee)
    assert res["due_today"] == [] and res["dismissed"] == 1
    # 내일이면 다시 보인다
    tomorrow = wa.local_today() + timedelta(days=1)
    assert len(wa.compute_my_alarms(db, db.query(WorkItem), lee, tomorrow)["overdue"]) == 1
    assert restore_my_alarms(db=db, user=lee)["restored"] == 1
    assert len(get_my_alarms(db=db, scope=ADMIN_SCOPE, user=lee)["due_today"]) == 1


def test_due_reminders_once_per_day(db, people):
    lee = people["lee"]
    today = wa.local_today()
    _item(db, lee.username, title="내일", due_date=today + timedelta(days=1))
    _item(db, lee.username, title="오늘", due_date=today)
    _item(db, lee.username, title="어제", due_date=today - timedelta(days=1))
    _item(db, lee.username, title="그저께", due_date=today - timedelta(days=2))   # 이미 지연 알림 보냄
    wa.run_due_reminders(db, today)
    wa.run_due_reminders(db, today)
    rows = [n for n in _mine(db, lee) if n.type.startswith("work_item_")]
    assert sorted(n.type for n in rows) == ["work_item_due_soon", "work_item_due_today", "work_item_overdue"]


# ── 업무 이벤트 ──────────────────────────────────────────────────────────────
def test_comment_mentions_and_stakeholders(db, people):
    lee, park, kim1 = people["lee"], people["park"], people["kim1"]
    it = _item(db, lee.username, created_by=kim1.username, watchers=[park.username])
    c = WorkItemComment(work_item_id=it.id, author=kim1.username, body=f"<p>@{park.username} 확인 부탁, a@b.com</p>")
    un.notify_work_item_comment(db, it, kim1, c)
    db.commit()
    assert [n.type for n in _mine(db, park)] == ["work_item_mention"]      # 구독자지만 멘션 1건만
    assert [n.type for n in _mine(db, lee)] == ["work_item_comment"]
    assert _mine(db, kim1) == []                                          # 작성자 본인 제외


def test_parse_mentions_ignores_email():
    assert un.parse_mentions("@kim, mail a@b.com @이영희.") == ["kim", "이영희"]


def test_status_and_assignment_events(db, people):
    from app.routers.work_items import patch_status
    from app.schemas.work_item import WorkItemStatusPatch

    lee, park = people["lee"], people["park"]
    admin = _user(db, "adm", f"{TAG}관리자", role="admin")
    try:
        it = _item(db, lee.username, created_by=park.username)
        patch_status(item_id=it.id, payload=WorkItemStatusPatch(kanban_status="in_progress"),
                     db=db, actor=admin, scope=ADMIN_SCOPE)
        assert {n.type for n in _mine(db, lee)} == {"work_item_status"}
        assert {n.type for n in _mine(db, park)} == {"work_item_status"}
        un.notify_work_item_assigned(db, it, admin, [park.display_name])
        db.commit()
        assert "work_item_assigned" in {n.type for n in _mine(db, park)}
    finally:
        db.query(UserNotification).filter(UserNotification.recipient_user_id == admin.id).delete()
        db.query(User).filter(User.id == admin.id).delete()
        db.commit()


# ── 외부 발송 ────────────────────────────────────────────────────────────────
def test_quiet_hours_and_digest_due():
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("Asia/Seoul")
    p = {"quiet_start": "22:00", "quiet_end": "07:00", "digest_hour": "09:00"}
    assert ud.in_quiet_hours(p, datetime(2026, 1, 1, 23, 0, tzinfo=tz))
    assert ud.in_quiet_hours(p, datetime(2026, 1, 1, 6, 59, tzinfo=tz))
    assert not ud.in_quiet_hours(p, datetime(2026, 1, 1, 7, 0, tzinfo=tz))
    assert not ud.digest_due(p, None, datetime(2026, 1, 1, 8, 0, tzinfo=tz))
    assert ud.digest_due(p, None, datetime(2026, 1, 1, 9, 5, tzinfo=tz))
    sent_today = datetime(2026, 1, 1, 0, 30)  # UTC 00:30 = KST 09:30
    assert not ud.digest_due(p, sent_today, datetime(2026, 1, 1, 18, 0, tzinfo=tz))


def test_deliver_pending_sends_and_skips(db, people, monkeypatch):
    from app.models.check_definitions import NotificationChannel, NotificationChannelType

    lee, park = people["lee"], people["park"]
    ch = NotificationChannel(name=f"{TAG}-mail", channel_type=NotificationChannelType.email, config={"smtp_host": "x"})
    db.add(ch)
    db.commit()
    saved = ud.get_delivery_settings(db)
    try:
        ud.set_delivery_settings(db, {"enabled": True, "email_channel_id": str(ch.id), "webhook_channel_id": None})
        for u in (lee, park):
            db.add(UserNotificationPref(user_id=u.id, prefs={"work_item_comment": {"inapp": True, "email": True}}))
        db.commit()
        a = un.create_notification(db, user=lee, type="work_item_comment", title="메일로")
        b = un.create_notification(db, user=park, type="work_item_comment", title="메일 없음")
        db.commit()
        calls = []
        monkeypatch.setattr(ud, "_send", lambda _db, _ch, kind, user, s, body, link: (
            calls.append((kind, user.email)) or (("sent", None) if user.email else ("skipped", "사용자 메일 주소 없음"))))
        ud.deliver_pending(db)
        db.refresh(a)
        db.refresh(b)
        assert a.external_status == "sent" and b.external_status == "skipped"
        assert ("email", "lee@example.com") in calls
    finally:
        ud.set_delivery_settings(db, saved)
        db.delete(ch)
        db.commit()


# ── 채널 비밀 값·대상 주소 ───────────────────────────────────────────────────
def test_channel_config_masking_and_merge():
    cfg = {"smtp_password": "pw", "headers": {"Authorization": "Bearer t"}, "url": "https://hook"}
    viewer = nr._mask_config(cfg, is_admin=False)
    assert viewer["smtp_password"] == nr.MASK and viewer["headers"]["Authorization"] == nr.MASK
    assert viewer["url"] == nr.MASK
    assert nr._mask_config(cfg, is_admin=True)["url"] == "https://hook"
    merged = nr._merge_masked({"smtp_password": nr.MASK, "headers": {"Authorization": nr.MASK}, "url": "https://new"}, cfg)
    assert merged == {"smtp_password": "pw", "headers": {"Authorization": "Bearer t"}, "url": "https://new"}


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://169.254.169.254/latest", "http://127.0.0.1:8000/x",
                                 "http://localhost/x", "http://metadata.google.internal/"])
def test_webhook_url_validation_rejects(url):
    with pytest.raises(HTTPException):
        nr._validate_target_url(url, "url")


def test_webhook_url_validation_allows_private_gateway():
    nr._validate_target_url("http://10.1.2.3:8080/cube", "url")   # 폐쇄망 메신저 게이트웨이


def test_channel_routes_require_roles():
    from app.auth.deps import require_admin, require_operator

    want = {("GET", "/notifications/channels"): require_operator,
            ("POST", "/notifications/channels"): require_admin,
            ("PUT", "/notifications/channels/{cid}"): require_admin,
            ("DELETE", "/notifications/channels/{cid}"): require_admin,
            ("POST", "/notifications/test/{cid}"): require_admin,
            ("GET", "/notifications/log"): require_admin,
            ("PUT", "/notifications/delivery-settings"): require_admin}
    seen = {}
    for r in nr.router.routes:
        for m in r.methods:
            deps = {d.call for d in r.dependant.dependencies}
            seen[(m, r.path)] = deps
    for key, dep in want.items():
        assert dep in seen[key], key


def test_today_is_service_timezone():
    # UTC 15:30 = KST 다음날 00:30
    assert wa.local_today(datetime(2026, 3, 1, 15, 30)) == date(2026, 3, 2)


def test_prefs_roundtrip_as_list(db, people):
    lee = people["lee"]
    body = nr.PrefsIn(events=[nr.EventChannels(type="work_item_mention", inapp=False, email=True)],
                      digest_mode="daily", digest_hour="08:30", quiet_start="22:00", quiet_end="07:00")
    out = nr.put_my_prefs(body=body, db=db, user=lee)
    got = {e["type"]: e for e in out["events"]}
    assert got["work_item_mention"]["inapp"] is False and got["work_item_mention"]["email"] is True
    assert got["work_item_comment"]["inapp"] is True          # 안 보낸 종류는 기본값
    assert out["digest_mode"] == "daily" and out["quiet_start"] == "22:00"
    with pytest.raises(HTTPException):
        nr.put_my_prefs(body=nr.PrefsIn(events=[nr.EventChannels(type="nope")]), db=db, user=lee)


def test_stream_opts_out_of_gzip():
    """GZipMiddleware 가 SSE 를 압축하면 브라우저에 이벤트가 전달되지 않는다(curl 은 gzip 을 안 보내 안 드러남)."""
    import inspect

    assert '"Content-Encoding": "identity"' in inspect.getsource(nr.my_notification_stream)
