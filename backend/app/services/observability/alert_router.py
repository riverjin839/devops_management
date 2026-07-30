"""수신 알람 → 저장(upsert) → 알림 라우팅 + 중복 억제.

동작 요약
---------
1. `AlertNotifyRule` 을 `priority` 오름차순으로 평가해 **첫 매칭 1건**을 채택.
   매칭이 없으면 `AppSetting["alert_notify.settings"]` 의 전역 기본값을 쓴다.
2. 규칙에 `severity_override` 가 있으면 심각도를 재정의한다(`severity_source='rule'`).
3. `status='firing'` 이고 심각도가 `severity_min` 이상일 때만 알림 후보.
4. **중복 억제** — 같은 fingerprint 의 마지막 알림이 `dedup_window_sec` 이내면
   - `first_only` : 새 알림을 만들지 않고 `suppressed_count` 만 올린다.
   - `summarize`  : 새 알림을 만들지 않되 기존 알림 문구를 "N회 (최근 M분)" 으로 갱신한다.
   창이 지난 뒤 다시 오면 새 알림 1건을 만든다.
5. `notify_mode` 에 따라 `UserNotification` 을 만든다.
   `all` = recipient "all" 1행 / `users` = recipients 각각 / `none` = 만들지 않음(인박스만).

이 모듈은 ingest 경로에서 호출되므로 **개별 실패가 수신 자체를 깨면 안 된다** — 알림 생성
단계는 try/except 로 감싸고, 실패해도 알람 저장은 유지한다.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.alert_event import SEVERITY_ORDER, AlertEvent
from app.models.alert_notify_rule import AlertNotifyRule
from app.models.user_notification import UserNotification
from app.services.observability.alert_ingest import ParsedAlert

_log = logging.getLogger(__name__)

ALERT_SETTINGS_KEY = "alert_notify.settings"

DEFAULT_ALERT_SETTINGS: dict[str, Any] = {
    # 매칭 규칙이 없을 때의 기본 동작
    "default_notify_mode": "all",       # all | users | none
    "default_recipients": [],
    "default_severity_min": "warning",  # 이 이상만 알림
    "dedup_window_sec": 300,            # 5분
    "dedup_mode": "summarize",          # first_only | summarize
    "retention_days": 90,
}


# ── AppSetting 기반 전역 설정 (resource_count_service 패턴) ────────────────────

def get_alert_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == ALERT_SETTINGS_KEY).first()
    stored = (row.value if row and isinstance(row.value, dict) else None) or {}
    merged = {**DEFAULT_ALERT_SETTINGS, **stored}
    # 방어적 정규화 — 잘못된 값이 저장돼 있어도 엔진이 죽지 않게
    if merged.get("default_notify_mode") not in ("all", "users", "none"):
        merged["default_notify_mode"] = DEFAULT_ALERT_SETTINGS["default_notify_mode"]
    if merged.get("dedup_mode") not in ("first_only", "summarize"):
        merged["dedup_mode"] = DEFAULT_ALERT_SETTINGS["dedup_mode"]
    if merged.get("default_severity_min") not in SEVERITY_ORDER:
        merged["default_severity_min"] = DEFAULT_ALERT_SETTINGS["default_severity_min"]
    try:
        merged["dedup_window_sec"] = max(0, int(merged.get("dedup_window_sec") or 0))
    except (TypeError, ValueError):
        merged["dedup_window_sec"] = DEFAULT_ALERT_SETTINGS["dedup_window_sec"]
    try:
        merged["retention_days"] = max(1, int(merged.get("retention_days") or 90))
    except (TypeError, ValueError):
        merged["retention_days"] = DEFAULT_ALERT_SETTINGS["retention_days"]
    if not isinstance(merged.get("default_recipients"), list):
        merged["default_recipients"] = []
    return merged


def set_alert_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == ALERT_SETTINGS_KEY).first()
    prev = (row.value if row and isinstance(row.value, dict) else {}) or {}
    merged = {**DEFAULT_ALERT_SETTINGS, **prev, **{k: v for k, v in patch.items() if v is not None}}
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=ALERT_SETTINGS_KEY, value=merged))
    db.commit()
    return get_alert_settings(db)


# ── 규칙 매칭 ────────────────────────────────────────────────────────────────

def _regex_matches(pattern: Optional[str], value: Optional[str]) -> bool:
    """빈 패턴 = 조건 없음(통과). 잘못된 정규식은 부분 문자열 매칭으로 폴백."""
    if not pattern or not str(pattern).strip():
        return True
    if not value:
        return False
    try:
        return re.search(pattern, value) is not None
    except re.error:
        return pattern.lower() in value.lower()


def _rule_matches(rule: AlertNotifyRule, alert: ParsedAlert, cluster_id: Optional[UUID]) -> bool:
    if rule.cluster_id and cluster_id != rule.cluster_id:
        return False
    if rule.module_key and str(alert.labels.get("module") or "") != rule.module_key:
        return False
    if not _regex_matches(rule.alertname_pattern, alert.alertname):
        return False
    if not _regex_matches(rule.namespace_pattern, alert.namespace):
        return False
    if rule.label_matchers and isinstance(rule.label_matchers, dict):
        for key, expected in rule.label_matchers.items():
            actual = alert.labels.get(key)
            if actual is None or str(actual) != str(expected):
                return False
    if rule.severity_min:
        want = SEVERITY_ORDER.get(rule.severity_min, 0)
        if SEVERITY_ORDER.get(alert.severity, 0) < want:
            return False
    return True


def resolve_policy(
    db: Session, alert: ParsedAlert, cluster_id: Optional[UUID]
) -> tuple[Optional[AlertNotifyRule], dict[str, Any]]:
    """알람에 적용할 (규칙, 유효 정책) 을 반환. 규칙이 없으면 (None, 전역기본값)."""
    settings = get_alert_settings(db)
    policy = {
        "notify_mode": settings["default_notify_mode"],
        "recipients": list(settings["default_recipients"]),
        "severity_min": settings["default_severity_min"],
        "dedup_window_sec": settings["dedup_window_sec"],
        "dedup_mode": settings["dedup_mode"],
        "severity_override": None,
        "channel_ids": [],
    }

    try:
        rules = (
            db.query(AlertNotifyRule)
            .filter(AlertNotifyRule.enabled.is_(True))
            .order_by(AlertNotifyRule.priority.asc(), AlertNotifyRule.created_at.asc())
            .all()
        )
    except Exception as e:  # noqa: BLE001
        _log.warning("alert route: 규칙 조회 실패 — 전역 기본값 사용 (%s)", e)
        return None, policy

    for rule in rules:
        if not _rule_matches(rule, alert, cluster_id):
            continue
        policy.update({
            "notify_mode": rule.notify_mode or policy["notify_mode"],
            "recipients": list(rule.recipients or []),
            "severity_min": rule.severity_min or policy["severity_min"],
            "dedup_window_sec": (
                rule.dedup_window_sec if rule.dedup_window_sec is not None else policy["dedup_window_sec"]
            ),
            "dedup_mode": rule.dedup_mode or policy["dedup_mode"],
            "severity_override": rule.severity_override,
            "channel_ids": list(rule.channel_ids or []),
        })
        return rule, policy

    return None, policy


# ── 저장 (upsert) ────────────────────────────────────────────────────────────

def upsert_alert_event(
    db: Session, alert: ParsedAlert, cluster_id: Optional[UUID], severity: str, severity_source: str
) -> tuple[AlertEvent, bool]:
    """(fingerprint, starts_at) 기준 upsert. (행, 신규여부) 를 반환한다.

    같은 알람이 반복 수신되면 행을 늘리지 않고 `occurrences` 를 올린다.
    `resolved` 수신이면 같은 fingerprint 의 열린(firing) 행을 종료시킨다.
    """
    now = datetime.utcnow()

    query = db.query(AlertEvent).filter(AlertEvent.fingerprint == alert.fingerprint)
    if alert.starts_at is not None:
        existing = query.filter(AlertEvent.starts_at == alert.starts_at).first()
    else:
        # startsAt 이 없는 페이로드는 "가장 최근에 열린 같은 알람"에 합류시킨다.
        existing = (
            query.filter(AlertEvent.status == "firing")
            .order_by(AlertEvent.received_at.desc())
            .first()
        )

    if existing is None and alert.status == "resolved":
        # 해소 알림만 먼저 도착한 경우 — 열려 있는 같은 알람을 찾아 종료시킨다.
        existing = (
            query.filter(AlertEvent.status == "firing")
            .order_by(AlertEvent.received_at.desc())
            .first()
        )

    if existing is not None:
        existing.status = alert.status
        existing.severity = severity
        existing.severity_source = severity_source
        existing.occurrences = (existing.occurrences or 0) + 1
        existing.updated_at = now
        existing.received_at = now
        if alert.ends_at:
            existing.ends_at = alert.ends_at
        elif alert.status == "resolved" and not existing.ends_at:
            existing.ends_at = now
        # 나중에 도착한 페이로드가 더 풍부할 수 있으므로 비어 있던 필드만 채운다.
        existing.summary = existing.summary or alert.summary
        existing.description = existing.description or alert.description
        existing.namespace = existing.namespace or alert.namespace
        existing.resource = existing.resource or alert.resource
        existing.generator_url = existing.generator_url or alert.generator_url
        if alert.labels:
            existing.labels = alert.labels
        if alert.annotations:
            existing.annotations = alert.annotations
        existing.raw = alert.raw
        return existing, False

    row = AlertEvent(
        cluster_id=cluster_id,
        source=alert.source,
        fingerprint=alert.fingerprint,
        alertname=alert.alertname,
        severity=severity,
        severity_source=severity_source,
        status=alert.status,
        namespace=alert.namespace,
        resource=alert.resource,
        summary=alert.summary,
        description=alert.description,
        labels=alert.labels or {},
        annotations=alert.annotations or {},
        starts_at=alert.starts_at or now,
        ends_at=alert.ends_at or (now if alert.status == "resolved" else None),
        generator_url=alert.generator_url,
        occurrences=1,
        raw=alert.raw,
        received_at=now,
        updated_at=now,
    )
    db.add(row)
    return row, True


# ── 알림 생성 + 중복 억제 ────────────────────────────────────────────────────

def _notification_title(event: AlertEvent, repeat: int) -> str:
    prefix = f"[{event.severity.upper()}]"
    suffix = f" ×{repeat}" if repeat > 1 else ""
    return f"{prefix} {event.alertname}{suffix}"[:200]


def _notification_body(event: AlertEvent, repeat: int, window_sec: int) -> str:
    target = " / ".join([p for p in [event.namespace, event.resource] if p])
    base = event.summary or event.description or ""
    parts = [p for p in [target, base] if p]
    text = " — ".join(parts) if parts else event.alertname
    if repeat > 1:
        minutes = max(1, round(window_sec / 60))
        text = f"{text} (최근 {minutes}분간 {repeat}회)"
    return text


def _resolve_recipients(db: Session, policy: dict[str, Any]) -> list[str]:
    """알림을 받을 recipient 목록. `all` 은 활성 사용자 전체로 **팬아웃**한다.

    공유 `recipient="all"` 행을 쓰지 않는 이유는 `services/user_notify.notify_broadcast`
    docstring 참고 — 조회에서 매칭되지 않았고 읽음 처리가 개인별로 안 됐다.
    """
    mode = policy.get("notify_mode")
    if mode == "none":
        return []
    if mode == "all":
        from app.models.user import User

        return [
            (u.username or u.display_name or "").strip()
            for u in db.query(User).filter(User.is_active.is_(True)).all()
            if (u.username or u.display_name or "").strip()
        ]
    return [str(r).strip() for r in (policy.get("recipients") or []) if str(r).strip()]


def apply_notification(db: Session, event: AlertEvent, policy: dict[str, Any]) -> str:
    """알림 생성/억제를 수행하고 결과 사유를 문자열로 반환(테스트·로그용).

    반환값: created | suppressed | summarized | skipped_mode | skipped_severity | skipped_resolved
    """
    if event.status != "firing":
        return "skipped_resolved"

    min_sev = SEVERITY_ORDER.get(policy.get("severity_min") or "warning", 1)
    if SEVERITY_ORDER.get(event.severity, 0) < min_sev:
        return "skipped_severity"

    recipients = _resolve_recipients(db, policy)
    if not recipients:
        return "skipped_mode"

    now = datetime.utcnow()
    window = int(policy.get("dedup_window_sec") or 0)
    within_window = bool(
        window > 0 and event.last_notified_at and (now - event.last_notified_at) <= timedelta(seconds=window)
    )

    if within_window:
        event.suppressed_count = (event.suppressed_count or 0) + 1
        if policy.get("dedup_mode") == "first_only":
            return "suppressed"
        # summarize — 창 안에서 만들어 둔 기존 알림 문구를 최신 횟수로 갱신한다.
        repeat = event.occurrences or 1
        updated = (
            db.query(UserNotification)
            .filter(
                UserNotification.type == "alert",
                UserNotification.link == f"/alerts?id={event.id}",
                UserNotification.created_at >= now - timedelta(seconds=window),
            )
            .all()
        )
        for notif in updated:
            notif.title = _notification_title(event, repeat)
            notif.body = _notification_body(event, repeat, window)
        return "summarized" if updated else "suppressed"

    repeat = event.occurrences or 1
    for recipient in recipients:
        db.add(UserNotification(
            recipient=recipient,
            type="alert",
            title=_notification_title(event, repeat),
            body=_notification_body(event, repeat, window),
            link=f"/alerts?id={event.id}",
        ))
    event.notify_count = (event.notify_count or 0) + 1
    event.last_notified_at = now
    return "created"


def _fanout_channels(db: Session, event: AlertEvent, channel_ids: list) -> None:
    """규칙이 지정한 기존 NotificationChannel 로 재전파 (Slack/webhook/email).

    실패해도 알람 수신에는 영향이 없도록 전부 삼킨다.
    """
    if not channel_ids:
        return
    try:
        import asyncio

        from app.models.deep_check import NotificationChannel
        from app.services.notifier import send_via_channel

        subject = _notification_title(event, event.occurrences or 1)
        body = _notification_body(event, event.occurrences or 1, 0)
        for cid in channel_ids:
            channel = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
            if not channel or not channel.enabled:
                continue
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(send_via_channel(db, channel, subject, body))
            finally:
                loop.close()
    except Exception as e:  # noqa: BLE001
        _log.warning("alert route: 채널 재전파 실패 — 무시 (%s)", e)


# ── entrypoint ───────────────────────────────────────────────────────────────

def route_and_notify(
    db: Session, alert: ParsedAlert, cluster_id: Optional[UUID]
) -> dict[str, Any]:
    """알람 1건을 저장하고 알림 정책을 적용한다.

    호출자는 이 함수 뒤에 `db.commit()` 을 한다(여러 건을 한 트랜잭션으로 처리하기 위함).
    """
    rule, policy = resolve_policy(db, alert, cluster_id)

    severity = alert.severity
    severity_source = "payload"
    override = policy.get("severity_override")
    if override in SEVERITY_ORDER:
        severity = override
        severity_source = "rule"

    event, created = upsert_alert_event(db, alert, cluster_id, severity, severity_source)
    # 신규 행은 id 가 필요하므로(알림 link) flush 로 PK 를 확정한다.
    db.flush()

    try:
        outcome = apply_notification(db, event, policy)
    except Exception as e:  # noqa: BLE001
        _log.warning("alert route: 알림 생성 실패 — 알람 저장은 유지 (%s)", e)
        outcome = "error"

    if outcome == "created":
        _fanout_channels(db, event, policy.get("channel_ids") or [])

    # AI 자동 분석 훅 — scope 매칭 시 전용 llm 큐로 enqueue. 어떤 실패도
    # 알람 수신을 막지 않는다 (maybe_enqueue_analysis 자체가 절대 raise 안 함).
    try:
        from app.services.observability.analysis_hook import maybe_enqueue_analysis
        analysis_outcome = maybe_enqueue_analysis(db, event)
    except Exception as e:  # noqa: BLE001
        _log.warning("alert route: 자동 분석 훅 실패 — 무시 (%s)", e)
        analysis_outcome = "error"

    return {
        "id": str(event.id),
        "alertname": event.alertname,
        "severity": event.severity,
        "status": event.status,
        "created": created,
        "occurrences": event.occurrences,
        "notify": outcome,
        "rule": rule.name if rule else None,
        "analysis": analysis_outcome,
    }
