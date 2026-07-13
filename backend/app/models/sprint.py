import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Date
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.database import Base


class Sprint(Base):
    """스프린트(반복/iteration) — 시간 박스 단위 업무 묶음.

    기본 주기는 2주. work_item.sprint_id 로 항목을 명시적으로 커밋한다.
    status: planning(계획) / active(진행) / completed(완료).
    """

    __tablename__ = "sprints"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    goal = Column(Text, nullable=True)               # 스프린트 목표(선택)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    status = Column(String(20), nullable=False, default="active")  # planning/active/completed
    jira_no = Column(String(100), nullable=True)                   # JIRA 티켓 번호 (선택)
    confluence_link = Column(String(500), nullable=True)           # Confluence 페이지 URL (선택)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    work_items = relationship(
        "WorkItem",
        back_populates="sprint",
        foreign_keys="WorkItem.sprint_id",
        lazy="dynamic",
    )
