import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, Boolean, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class UserNotification(Base):
    """사용자 개인 인앱 알림 (알림 종). recipient 는 username 또는 display_name 으로 저장되며
    조회 시 현재 사용자의 username/display_name 집합과 매칭한다."""

    __tablename__ = "user_notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recipient = Column(String(128), nullable=False, index=True)
    type = Column(String(40), nullable=False, default="info")  # work_item_comment 등
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=True)
    link = Column(String(255), nullable=True)
    work_item_id = Column(UUID(as_uuid=True), nullable=True)
    is_read = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
