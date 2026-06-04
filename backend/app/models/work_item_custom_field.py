"""WorkItemCustomField — 업무(work item) 테이블/상세의 사용자 정의 필드.

각 업무의 실제 값은 WorkItem.custom_values (JSONB) 에 {field_key: value} 로 저장.
(ClusterCustomField 패턴 미러링)
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from app.database import Base


class WorkItemCustomField(Base):
    __tablename__ = "work_item_custom_fields"
    __table_args__ = (
        UniqueConstraint("key", name="uq_work_item_custom_fields_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(String(64), nullable=False)
    label = Column(String(128), nullable=False)
    data_type = Column(String(32), nullable=False, default="text")  # text/number/date/checkbox/select
    options = Column(JSONB, nullable=True)
    description = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
