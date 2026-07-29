"""AlertNotifyRule — 수신한 알람을 "누구에게, 얼마나 자주" 알릴지 정하는 규칙.

UI-First: 담당자 매핑·중복 억제 창·심각도 재정의를 코드에 박지 않고 화면에서 편집한다.
규칙은 `priority` 오름차순으로 평가하고 **첫 매칭 1건**만 적용한다. 매칭되는 규칙이 없으면
`AppSetting["alert_notify.settings"]` 의 전역 기본값을 쓴다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class AlertNotifyRule(Base):
    __tablename__ = "alert_notify_rules"
    __table_args__ = (
        Index("ix_alert_notify_rules_priority", "enabled", "priority"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(150), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    priority = Column(Integer, nullable=False, default=100)   # 작을수록 먼저 평가

    # ── 매처 (NULL/빈값 = 조건 없음) ─────────────────────────────────────────
    cluster_id = Column(UUID(as_uuid=True), nullable=True)
    module_key = Column(String(64), nullable=True)
    alertname_pattern = Column(String(255), nullable=True)    # 정규식 (부분 매칭)
    namespace_pattern = Column(String(255), nullable=True)    # 정규식 (부분 매칭)
    label_matchers = Column(JSONB, nullable=True)             # {"team": "platform"} — AND 조합
    severity_min = Column(String(16), nullable=True)          # info | warning | critical

    # ── 액션 ─────────────────────────────────────────────────────────────────
    # all   = 전체 사용자 브로드캐스트 (recipient="all")
    # users = recipients 에 나열된 담당자에게만
    # none  = 개인 알림 없이 인박스에만 적재
    notify_mode = Column(String(16), nullable=False, default="all")
    recipients = Column(JSONB, nullable=True)                 # ["hong", "김철수"]
    severity_override = Column(String(16), nullable=True)     # 심각도 재정의
    channel_ids = Column(JSONB, nullable=True)                # NotificationChannel.id 배열(재전파)

    # ── 중복 억제 ────────────────────────────────────────────────────────────
    dedup_window_sec = Column(Integer, nullable=False, default=300)
    # first_only = 창 안에서는 알림을 아예 만들지 않음
    # summarize  = 창 안에서는 기존 알림 문구를 "N회 (최근 M분)" 으로 갱신
    dedup_mode = Column(String(16), nullable=False, default="summarize")

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<AlertNotifyRule(name={self.name}, mode={self.notify_mode})>"
