"""
Notifier — Slack / Email / Webhook / K8sEvent fan-out.

Strategy pattern. 모든 채널은 fail-safe — 한 채널 실패가 다른 채널을 막지 않는다.

진입점: ``notify_for_check_log(db, daily_check_log_id)``
  → DailyCheckLog 의 overall_status / cluster_id 를 보고 등록된 채널 중 매치하는 것에 발송.
"""
from __future__ import annotations

import json
import logging
import smtplib
from email.mime.text import MIMEText
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Cluster,
    DailyCheckLog,
    NotificationChannel,
    NotificationChannelType,
    NotificationLog,
    StatusEnum,
)

logger = logging.getLogger(__name__)


_SEVERITY_RANK = {"healthy": 0, "warning": 1, "critical": 2, "pending": 1}


def _rank(status: StatusEnum | str | None) -> int:
    v = status.value if hasattr(status, "value") else str(status or "")
    return _SEVERITY_RANK.get(v, 0)


# ───────────────────────────────────────────────────────────────
# Channel strategies
# ───────────────────────────────────────────────────────────────

class _BaseChannel:
    def __init__(self, channel: NotificationChannel):
        self.channel = channel
        self.config: dict[str, Any] = channel.config or {}

    def send(self, subject: str, body: str) -> tuple[str, str | None]:
        """Return (status, error). status: sent | failed."""
        raise NotImplementedError


class SlackChannel(_BaseChannel):
    def send(self, subject: str, body: str) -> tuple[str, str | None]:
        url = self.config.get("webhook_url") or settings.slack_webhook_url
        if not url:
            return "failed", "no webhook_url configured"
        payload = {"text": f"*{subject}*\n{body}"}
        try:
            with httpx.Client(timeout=10) as cli:
                resp = cli.post(url, json=payload)
                if resp.status_code >= 300:
                    return "failed", f"HTTP {resp.status_code}: {resp.text[:200]}"
                return "sent", None
        except Exception as e:
            return "failed", str(e)[:300]


class EmailChannel(_BaseChannel):
    def send(self, subject: str, body: str) -> tuple[str, str | None]:
        host = self.config.get("smtp_host") or settings.smtp_host
        port = int(self.config.get("smtp_port") or settings.smtp_port)
        user = self.config.get("smtp_user") or settings.smtp_user
        pw = self.config.get("smtp_password") or settings.smtp_password
        sender = self.config.get("from") or settings.smtp_from
        to = self.config.get("to") or []
        if isinstance(to, str):
            to = [to]
        if not host or not to:
            return "failed", "smtp_host or to not configured"
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = sender
        msg["To"] = ", ".join(to)
        try:
            with smtplib.SMTP(host, port, timeout=10) as s:
                if settings.smtp_use_tls:
                    try:
                        s.starttls()
                    except Exception:
                        pass
                if user and pw:
                    s.login(user, pw)
                s.sendmail(sender, to, msg.as_string())
            return "sent", None
        except Exception as e:
            return "failed", str(e)[:300]


class WebhookChannel(_BaseChannel):
    def send(self, subject: str, body: str) -> tuple[str, str | None]:
        url = self.config.get("url")
        if not url:
            return "failed", "no url configured"
        headers = self.config.get("headers") or {}
        payload = self.config.get("template") or {"subject": subject, "body": body}
        try:
            with httpx.Client(timeout=10) as cli:
                resp = cli.post(url, json=payload, headers=headers)
                if resp.status_code >= 300:
                    return "failed", f"HTTP {resp.status_code}: {resp.text[:200]}"
                return "sent", None
        except Exception as e:
            return "failed", str(e)[:300]


class K8sEventChannel(_BaseChannel):
    """관리 클러스터 in-cluster API 로 Event 생성."""

    def send(self, subject: str, body: str) -> tuple[str, str | None]:
        try:
            from datetime import datetime as _dt

            from kubernetes import client

            from app.services.k8s_client_pool import get_incluster_api_client
            v1 = client.CoreV1Api(get_incluster_api_client())
            ns = self.config.get("namespace") or settings.mgmt_namespace
            now = _dt.utcnow()
            ev = client.V1Event(
                metadata=client.V1ObjectMeta(generate_name="daily-check-"),
                reason="DailyCheckReview",
                message=f"{subject}\n{body}"[:32000],
                type="Warning",
                first_timestamp=now,
                last_timestamp=now,
                count=1,
                involved_object=client.V1ObjectReference(
                    kind="ConfigMap",
                    name="k8s-monitor-daily-check",
                    namespace=ns,
                ),
            )
            v1.create_namespaced_event(namespace=ns, body=ev)
            return "sent", None
        except Exception as e:
            return "failed", str(e)[:300]


_CHANNEL_MAP = {
    NotificationChannelType.slack: SlackChannel,
    NotificationChannelType.email: EmailChannel,
    NotificationChannelType.webhook: WebhookChannel,
    NotificationChannelType.k8s_event: K8sEventChannel,
}


# ───────────────────────────────────────────────────────────────
# Public entrypoints
# ───────────────────────────────────────────────────────────────

def send_via_channel(
    db: Session,
    channel: NotificationChannel,
    subject: str,
    body: str,
    daily_check_log_id: UUID | str | None = None,
) -> NotificationLog:
    cls = _CHANNEL_MAP.get(channel.channel_type)
    if cls is None:
        status, error = "failed", f"unknown channel type {channel.channel_type}"
    else:
        try:
            status, error = cls(channel).send(subject, body)
        except Exception as e:
            status, error = "failed", str(e)[:300]

    log = NotificationLog(
        channel_id=channel.id,
        daily_check_log_id=daily_check_log_id,
        status=status,
        subject=subject[:500],
        body=body,
        error=error,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def notify_for_check_log(db: Session, daily_check_log_id: UUID | str) -> list[NotificationLog]:
    """DailyCheckLog 의 심각도/클러스터에 매치하는 채널들로 fan-out."""
    log = db.query(DailyCheckLog).filter(DailyCheckLog.id == daily_check_log_id).first()
    if log is None:
        return []
    cluster = db.query(Cluster).filter(Cluster.id == log.cluster_id).first()

    overall_rank = _rank(log.overall_status)

    channels = db.query(NotificationChannel).filter(NotificationChannel.enabled == True).all()  # noqa: E712
    sent_logs: list[NotificationLog] = []
    for ch in channels:
        if ch.cluster_id is not None and ch.cluster_id != log.cluster_id:
            continue
        if _rank(ch.min_severity) > overall_rank:
            # 심각도 미달
            continue
        subject = (
            f"[{(log.overall_status.value if log.overall_status else 'unknown').upper()}] "
            f"{cluster.name if cluster else 'cluster'} daily check"
        )
        body_lines = [
            f"Cluster: {cluster.name if cluster else log.cluster_id}",
            f"Status : {log.overall_status.value if log.overall_status else 'unknown'}",
            f"Nodes  : {log.ready_nodes or 0}/{log.total_nodes or 0} ready",
            f"Checked: {log.checked_at}",
        ]
        if log.ai_summary:
            body_lines += ["", "── AI 요약 ──", log.ai_summary]
        if log.ai_remediation:
            body_lines += ["", "── 조치 권고 ──", log.ai_remediation]
        if log.error_messages:
            body_lines += ["", "── 에러 ──", _format_msgs(log.error_messages)]
        body = "\n".join(body_lines)

        sent_logs.append(
            send_via_channel(db, ch, subject, body, daily_check_log_id=log.id)
        )
    return sent_logs


def _format_msgs(msgs: Any) -> str:
    if msgs is None:
        return ""
    if isinstance(msgs, list):
        return "\n".join(f"- {m}" for m in msgs)
    if isinstance(msgs, str):
        return msgs
    return json.dumps(msgs, default=str, ensure_ascii=False)
