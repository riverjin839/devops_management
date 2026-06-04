import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class WorkItemComment(Base):
    """업무(work item) 댓글 — 협업용 코멘트 스레드."""

    __tablename__ = "work_item_comments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_item_id = Column(
        UUID(as_uuid=True),
        ForeignKey("work_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author = Column(String(100), nullable=True)        # 작성자 username
    author_name = Column(String(128), nullable=True)   # 표시 이름(display_name)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
