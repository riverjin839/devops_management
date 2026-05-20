import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, Index
from sqlalchemy.dialects.postgresql import JSONB

from app.database import Base


class AuditLog(Base):
    """누가 / 언제 / 어디서 / 무엇을 했는지에 대한 감사 기록.

    actor_user_id 는 nullable — 로그인 실패처럼 사용자 식별이 안 된 이벤트도 기록한다.
    actor_username 은 스냅샷이라 User 가 나중에 삭제돼도 기록은 유지된다.
    """

    __tablename__ = "audit_logs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    actor_user_id = Column(String(36), nullable=True, index=True)
    actor_username = Column(String(64), nullable=False, default="-")
    action = Column(String(64), nullable=False, index=True)
    target_type = Column(String(32), nullable=True)
    target_id = Column(String(64), nullable=True)
    status = Column(String(16), nullable=False, default="success")  # 'success' | 'failure'
    ip = Column(String(64), nullable=True)
    user_agent = Column(String(255), nullable=True)
    details = Column(JSONB, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (
        Index("ix_audit_logs_action_created_at", "action", "created_at"),
    )
