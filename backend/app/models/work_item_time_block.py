"""WorkItemTimeBlock — 업무(work item) 의 날짜별 시간 블록.

하나의 work item 은 `started_at ~ closed_at` 의 전체 기간을 갖고, 그 기간 안에서
**날짜별로 0개 이상의 시간 블록**(예: 6/11 08:00–12:00, 6/13 14:00–15:00)을 가진다.
당일 스케줄(DayScheduleBoard) 캘린더 그리드에서 이동/리사이즈로 편집된다.

설계 메모:
 - 시각은 timezone 모호성을 피하기 위해 **자정 기준 분(minute-of-day, 0..1440)** 정수로 저장.
   날짜는 로컬 `block_date`(Date) 로 분리 저장한다.
 - work item 삭제 시 CASCADE 로 함께 삭제.
 - 신규 테이블이라 create_all 로 생성되며 `_safe_*` ALTER 가 필요 없다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, Date, Text, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class WorkItemTimeBlock(Base):
    __tablename__ = "work_item_time_blocks"
    __table_args__ = (
        Index("ix_witb_item", "work_item_id"),
        Index("ix_witb_date", "block_date"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_item_id = Column(
        UUID(as_uuid=True), ForeignKey("work_items.id", ondelete="CASCADE"), nullable=False
    )
    block_date = Column(Date, nullable=False)        # 로컬 날짜
    start_minute = Column(Integer, nullable=False)   # 자정 기준 분 (0..1439)
    end_minute = Column(Integer, nullable=False)     # 자정 기준 분 (> start_minute, ..1440)
    note = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<WorkItemTimeBlock(item={self.work_item_id}, {self.block_date} {self.start_minute}-{self.end_minute})>"
