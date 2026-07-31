"""AI 챗봇 대화 지속성 — 대화(conversation) + 메시지(message).

AgentChat 이 새로고침 후에도 대화를 이어가고, 서버가 최근 메시지로 멀티턴
히스토리를 구성하기 위한 저장소. 로그성(무한 증가) — backup LOG_TABLES +
retention purge(180일) 대상. 메시지에는 실행 가능한 필드가 없다 (분석 전용).
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class AgentConversation(Base):
    __tablename__ = "agent_conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # username — user 테이블 FK 를 걸지 않는다 (사용자 삭제가 대화 이력을 막지 않게).
    username = Column(String(128), nullable=False, index=True)
    title = Column(String(120), nullable=False, default="새 대화")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class AgentMessage(Base):
    __tablename__ = "agent_messages"
    __table_args__ = (
        Index("ix_agent_messages_conversation_created", "conversation_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    role = Column(String(16), nullable=False)          # user | assistant
    content = Column(Text, nullable=False, default="")
    citations = Column(JSONB, nullable=True)           # RAG 근거 인용
    requests = Column(JSONB, nullable=True)            # need_more_info 정보요청
    model = Column(String(128), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())
