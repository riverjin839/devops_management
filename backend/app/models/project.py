import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Date, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.database import Base


class Project(Base):
    __tablename__ = "projects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 멀티테넌시 3단계 — NULL = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다 (services/tenant_scope.py).
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=True, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    goal = Column(Text, nullable=True)
    color = Column(String(20), nullable=False, default="blue")
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    status = Column(String(20), nullable=False, default="active")  # active/completed/paused
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    work_items = relationship(
        "WorkItem",
        back_populates="project",
        foreign_keys="WorkItem.project_id",
        lazy="dynamic",
    )
