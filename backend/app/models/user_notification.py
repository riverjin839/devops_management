import uuid
from datetime import datetime

from sqlalchemy import (
    Column, Date, DateTime, Boolean, ForeignKey, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class UserNotification(Base):
    """사용자 개인 인앱 알림 (알림 종).

    받는 사람은 `recipient_user_id`(users.id) 로 판정한다. `recipient` 는 표시·구버전 호환용
    문자열(username)이다 — 예전 행은 `recipient_user_id` 가 비어 있고 문자열로만 매칭된다
    (`routers/notifications._mine_filter`). display_name 은 중복될 수 있어 새 행의 판정에 쓰지 않는다.
    """

    __tablename__ = "user_notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recipient = Column(String(128), nullable=False, index=True)
    recipient_user_id = Column(String(36), nullable=True, index=True)  # users.id (문자열 UUID)
    type = Column(String(40), nullable=False, default="info")  # work_item_comment 등
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=True)
    link = Column(String(255), nullable=True)
    work_item_id = Column(UUID(as_uuid=True), nullable=True)
    is_read = Column(Boolean, nullable=False, default=False, index=True)
    read_at = Column(DateTime, nullable=True)
    # 같은 알림을 두 번 만들지 않기 위한 키(예: 마감 알림 `due_today:<item>:<date>`). 사용자별로 유일.
    dedupe_key = Column(String(200), nullable=True, index=True)
    # 외부 채널(메일·메신저) 발송 상태 — None=외부 발송 대상 아님, pending=대기, sent/failed/skipped.
    external_status = Column(String(20), nullable=True, index=True)
    external_channels = Column(JSONB, nullable=True)   # ["email", "webhook"] — 생성 시점 설정 스냅샷
    external_error = Column(Text, nullable=True)
    external_sent_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())


class UserNotificationPref(Base):
    """사용자별 알림 설정 — 이벤트 종류 × 채널(앱/메일/메신저), 요약 발송, 방해 금지 시간.

    `prefs` = {event_type: {"inapp": bool, "email": bool, "webhook": bool}} — 빠진 키는
    `services/user_notify.EVENT_CATALOG` 의 기본값을 쓴다.
    """

    __tablename__ = "user_notification_prefs"

    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    prefs = Column(JSONB, nullable=False, default=dict)
    digest_mode = Column(String(20), nullable=False, default="immediate")  # immediate | daily
    digest_hour = Column(String(5), nullable=False, default="09:00")       # HH:MM (서비스 시간대)
    quiet_start = Column(String(5), nullable=True)                         # HH:MM — 외부 채널만 보류
    quiet_end = Column(String(5), nullable=True)
    last_digest_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class WorkAlarmDismissal(Base):
    """업무 일정 알람(지연·오늘·내일 마감)의 라인별 '오늘 그만 보기'.

    일정 알람은 업무 상태로 그때그때 판정하므로 행이 없다 — 숨김만 (사용자, 업무, 날짜) 로 기록한다.
    다음 날에도 미완료면 다시 보인다. 로그성(30일 보존).
    """

    __tablename__ = "work_alarm_dismissals"
    __table_args__ = (UniqueConstraint("user_id", "work_item_id", "alarm_date", name="uq_work_alarm_dismissal"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    work_item_id = Column(UUID(as_uuid=True), ForeignKey("work_items.id", ondelete="CASCADE"), nullable=False)
    alarm_date = Column(Date, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
