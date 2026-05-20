import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Integer, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.database import Base


class WorkItem(Base):
    """이슈와 작업을 통합한 단일 work item 모델.

    `type` 디스크리미네이터로 issue/task 를 구분한다. 마이그레이션 측면에서 기존
    `tasks` 테이블이 그대로 `work_items` 로 rename 되고 의미가 같은 컬럼은 통일된
    이름으로 RENAME 되었다 (예: task_content+issue_content → content,
    task_category+issue_area → category, scheduled_at+occurred_at → started_at,
    completed_at+resolved_at → closed_at, result_content+action_content → resolution).
    `detail_content` 는 issue 전용으로 nullable, task 전용 필드 (priority, module,
    type_label, effort_hours, done_condition, parent_id) 도 모두 nullable.
    `issue_id` FK 는 `related_work_item_id` 로 rename 되어 동일 테이블 내 다른
    work item 을 가리킨다.
    """

    __tablename__ = "work_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 디스크리미네이터 — 'task' | 'issue' | 'meeting' | 'training' | 'etc'
    type = Column(String(20), nullable=False, default="task", index=True)

    # 공통 필드 — 담당자
    assignee = Column(String(100), nullable=False)
    primary_assignee = Column(String(100), nullable=False)
    secondary_assignee = Column(String(100), nullable=True)

    # 공통 필드 — 클러스터
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=True)
    cluster_name = Column(String(100), nullable=True)

    # 공통 의미 — 통일된 이름
    category = Column(String(100), nullable=False)             # issue_area / task_category
    content = Column(Text, nullable=False)                     # issue_content / task_content
    resolution = Column(Text, nullable=True)                   # action_content / result_content
    started_at = Column(DateTime, nullable=False)              # occurred_at / scheduled_at
    closed_at = Column(DateTime, nullable=True)                # resolved_at / completed_at

    # 공통 — 기타
    remarks = Column(Text, nullable=True)
    service = Column(String(64), nullable=True, index=True)
    confluence_url = Column(Text, nullable=True)

    # Issue 전용 (nullable)
    detail_content = Column(Text, nullable=True)

    # Task 전용 (nullable; issue 에도 향후 자유롭게 활용 가능)
    priority = Column(String(20), nullable=False, default="medium")  # high/medium/low
    kanban_status = Column(String(20), nullable=False, default="todo")
    module = Column(String(50), nullable=True)
    type_label = Column(String(20), nullable=True)             # feature/bug/chore/docs/security
    effort_hours = Column(Integer, nullable=True)
    done_condition = Column(Text, nullable=True)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("work_items.id", ondelete="CASCADE"), nullable=True)
    related_work_item_id = Column(UUID(as_uuid=True), ForeignKey("work_items.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    cluster = relationship("Cluster", back_populates="work_items", foreign_keys=[cluster_id])
    subtasks = relationship(
        "WorkItem",
        back_populates="parent",
        foreign_keys="WorkItem.parent_id",
        cascade="all, delete-orphan",
        single_parent=True,
    )
    parent = relationship(
        "WorkItem",
        back_populates="subtasks",
        foreign_keys="WorkItem.parent_id",
        remote_side="WorkItem.id",
    )
    related = relationship("WorkItem", foreign_keys=[related_work_item_id], remote_side="WorkItem.id")

    def __repr__(self):
        return f"<WorkItem(type={self.type}, category={self.category}, assignee={self.assignee})>"
