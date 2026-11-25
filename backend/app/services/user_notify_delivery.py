"""개인 알림 외부 채널(메일 · 메신저 웹훅) 발송 — Celery Beat `user-notify-delivery`(매분).

흐름: `create_notification` 이 `external_status=pending` + `external_channels=[email|webhook]` 으로
저장 → 여기서 사용자 설정(즉시/하루 요약, 방해 금지 시간)에 맞춰 관리자가 지정한 채널로 보낸다.

- 채널은 관리자가 Settings(알림 화면 '발송 채널') 에서 고른다(AppSetting `user_notify.delivery`):
  메일 = email 형 `NotificationChannel`(SMTP 설정 재사용, 받는 사람만 사용자 메일로 바꿈),
  메신저 = webhook 형 채널(사내 메신저 게이트웨이 — 본문에 받는 사람 username·사번·메일을 함께 보냄).
- 방해 금지 시간에는 보류했다가 끝나면 보낸다. 하루 요약은 지정 시각 이후 하루 한 번 묶어 보낸다.
- 실패는 `external_status=failed` + 사유로 남기고 다시 시도하지 않는다(발송 이력은 `notification_logs`).
- fail-safe — 어떤 예외도 Beat 태스크 밖으로 올리지 않는다.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services.user_notify import EVENT_CATALOG, effective_prefs
from app.services.work_alarms import service_tz

logger = logging.getLogger(__name__)

DELIVERY_KEY = "user_notify.delivery"
DEFAULT_DELIVERY = {
    "enabled": True,
    "email_channel_id": None,
    "webhook_channel_id": None,
    # 메일·메신저 본문의 링크 앞에 붙일 PEP 주소(예: https://pep.example.com). 비우면 경로만.
    "app_base_url": "",
}
BATCH_LIMIT = 500
# 방해 금지·요약 대기 중이라도 이보다 오래된 건 버린다(며칠 묵은 알림을 한꺼번에 쏟지 않게).
MAX_PENDING_AGE = timedelta(days=3)


def get_delivery_settings(db) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == DELIVERY_KEY).first()
    val = row.value if row is not None and isinstance(row.value, dict) else {}
    out = dict(DEFAULT_DELIVERY)
    out.update({k: val.get(k) for k in DEFAULT_DELIVERY if k in val})
    return out


def set_delivery_settings(db, data: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    cur = get_delivery_settings(db)
    for k in DEFAULT_DELIVERY:
        if k in data:
            cur[k] = data[k]
    cur["enabled"] = bool(cur.get("enabled"))
    for k in ("email_channel_id", "webhook_channel_id"):
        cur[k] = str(cur[k]) if cur.get(k) else None
    cur["app_base_url"] = (cur.get("app_base_url") or "").strip().rstrip("/")
    row = db.query(AppSetting).filter(AppSetting.key == DELIVERY_KEY).first()
    if row is None:
        db.add(AppSetting(key=DELIVERY_KEY, value=cur))
    else:
        row.value = cur
    db.commit()
    return cur


def _hm(v: str | None) -> tuple[int, int] | None:
    try:
        h, m = (v or "").split(":")
        h, m = int(h), int(m)
        if 0 <= h < 24 and 0 <= m < 60:
            return h, m
    except (ValueError, AttributeError):
        pass
    return None


def in_quiet_hours(prefs: dict[str, Any], local_now: datetime) -> bool:
    s, e = _hm(prefs.get("quiet_start")), _hm(prefs.get("quiet_end"))
    if not s or not e or s == e:
        return False
    cur = (local_now.hour, local_now.minute)
    if s < e:
        return s <= cur < e
    return cur >= s or cur < e  # 자정을 넘는 구간(22:00~07:00)


def digest_due(prefs: dict[str, Any], last_digest_at: datetime | None, local_now: datetime) -> bool:
    hm = _hm(prefs.get("digest_hour")) or (9, 0)
    if (local_now.hour, local_now.minute) < hm:
        return False
    if last_digest_at is None:
        return True
    last_local = last_digest_at.replace(tzinfo=timezone.utc).astimezone(local_now.tzinfo)
    return last_local.date() < local_now.date()


def _link(base: str, link: str | None) -> str:
    if not link:
        return ""
    return f"{base}{link}" if base else link


def _send(db, channel, kind: str, user, subject: str, body: str, link: str) -> tuple[str, str | None]:
    from app.services.notifier import send_via_channel

    if kind == "email":
        if not user.email:
            return "skipped", "사용자 메일 주소 없음"
        override = {"to": [user.email]}
    else:
        override = {"template": None, "extra_payload": {
            "recipient": user.username, "employee_id": user.employee_id, "email": user.email,
            "display_name": user.display_name, "link": link,
        }}
    log = send_via_channel(db, channel, subject, body, config_override=override)
    return log.status, log.error


def deliver_pending(db, now_utc: datetime | None = None) -> dict[str, int]:
    """대기 중인 외부 발송을 처리한다. 반환: 처리 결과별 건수."""
    from app.models.check_definitions import NotificationChannel
    from app.models.user import User
    from app.models.user_notification import UserNotification, UserNotificationPref

    counts = {"sent": 0, "failed": 0, "skipped": 0, "held": 0}
    now = now_utc or datetime.utcnow()
    local_now = now.replace(tzinfo=timezone.utc).astimezone(service_tz())
    cfg = get_delivery_settings(db)
    pending = (
        db.query(UserNotification)
        .filter(UserNotification.external_status == "pending")
        .order_by(UserNotification.created_at.asc())
        .limit(BATCH_LIMIT)
        .all()
    )
    if not pending:
        return counts

    def _finish(n, status: str, error: str | None = None):
        n.external_status = status
        n.external_error = error
        n.external_sent_at = now if status == "sent" else None
        counts[status] += 1

    channels: dict[str, Any] = {}
    if cfg.get("enabled"):
        for kind, key in (("email", "email_channel_id"), ("webhook", "webhook_channel_id")):
            cid = cfg.get(key)
            if cid:
                ch = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
                if ch is not None and ch.enabled:
                    channels[kind] = ch

    by_user: dict[Any, list] = {}
    for n in pending:
        if n.recipient_user_id is None:
            _finish(n, "skipped", "받는 사람을 사용자로 특정할 수 없음")
        elif n.created_at and now - n.created_at > MAX_PENDING_AGE:
            _finish(n, "skipped", "보류 기간 초과")
        elif not channels:
            _finish(n, "skipped", "관리자가 발송 채널을 지정하지 않음" if cfg.get("enabled") else "외부 발송 꺼짐")
        else:
            by_user.setdefault(n.recipient_user_id, []).append(n)

    base = cfg.get("app_base_url") or ""
    for uid, rows in by_user.items():
        user = db.query(User).filter(User.id == uid).first()
        if user is None or not user.is_active:
            for n in rows:
                _finish(n, "skipped", "비활성 사용자")
            continue
        pref_row = db.query(UserNotificationPref).filter(UserNotificationPref.user_id == uid).first()
        prefs = effective_prefs(pref_row)
        if in_quiet_hours(prefs, local_now):
            counts["held"] += len(rows)
            continue
        if prefs["digest_mode"] == "daily":
            if not digest_due(prefs, pref_row.last_digest_at if pref_row else None, local_now):
                counts["held"] += len(rows)
                continue
            kinds = sorted({k for n in rows for k in (n.external_channels or [])})
            lines = [f"- [{EVENT_CATALOG.get(n.type, {}).get('label', n.type)}] {n.title}"
                     + (f" — {n.body}" if n.body else "")
                     + (f"\n  {_link(base, n.link)}" if n.link else "") for n in rows]
            subject = f"[PEP] 알림 요약 {len(rows)}건"
            body = "\n".join(lines)
            results = []
            for kind in kinds:
                ch = channels.get(kind)
                if ch is None:
                    continue
                try:
                    results.append(_send(db, ch, kind, user, subject, body, _link(base, "/notifications")))
                except Exception as e:  # noqa: BLE001
                    results.append(("failed", str(e)[:300]))
            _apply_results(rows, results, _finish)
            if pref_row is None:
                pref_row = UserNotificationPref(user_id=uid, prefs={})
                db.add(pref_row)
            pref_row.last_digest_at = now
            continue
        for n in rows:
            results = []
            for kind in (n.external_channels or []):
                ch = channels.get(kind)
                if ch is None:
                    continue
                link = _link(base, n.link)
                body = (n.body or "") + (f"\n{link}" if link else "")
                try:
                    results.append(_send(db, ch, kind, user, f"[PEP] {n.title}", body, link))
                except Exception as e:  # noqa: BLE001
                    results.append(("failed", str(e)[:300]))
            _apply_results([n], results, _finish)
    db.commit()
    return counts


def _apply_results(rows, results: list[tuple[str, str | None]], finish) -> None:
    if not results:
        for n in rows:
            finish(n, "skipped", "이 알림의 채널이 지정되지 않음")
        return
    if any(s == "sent" for s, _ in results):
        status, err = "sent", None
    elif any(s == "failed" for s, _ in results):
        status, err = "failed", "; ".join(e or "" for s, e in results if s == "failed")[:500]
    else:
        status, err = "skipped", "; ".join(e or "" for _, e in results)[:500]
    for n in rows:
        finish(n, status, err)
