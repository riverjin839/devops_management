import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Integer, Boolean, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
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
    # 다중 대상 클러스터 — 같은 업무를 여러 클러스터에서 수행할 때. cluster_id/cluster_name 은
    # 대표(첫 번째)로 유지(기존 단일 표시/필터 호환), cluster_ids/cluster_names 가 전체 목록.
    cluster_ids = Column(JSONB, nullable=True)    # list[str(uuid)]
    cluster_names = Column(JSONB, nullable=True)  # list[str] — cluster_ids 와 1:1
    custom_values = Column(JSONB, nullable=True)   # {field_key: value} — 사용자 정의 필드 값
    # 전체 참석(회의 등) — true 면 모든 사용자의 개인 일정(Work To Do)에 표시.
    all_attendees = Column(Boolean, nullable=False, default=False, server_default="false")

    # 공통 의미 — 통일된 이름
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    # 스프린트(반복) 소속 (nullable) — 명시적으로 이번/다음 스프린트에 커밋.
    sprint_id = Column(UUID(as_uuid=True), ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True, index=True)
    title = Column(String(200), nullable=True)                  # 짧은 제목 (nullable — 구버전 호환)
    category = Column(String(100), nullable=False)             # issue_area / task_category
    content = Column(Text, nullable=False)                     # issue_content / task_content
    resolution = Column(Text, nullable=True)                   # action_content / result_content
    started_at = Column(DateTime, nullable=False)              # occurred_at / scheduled_at
    closed_at = Column(DateTime, nullable=True)                # resolved_at / completed_at

    # 공통 — 기타
    remarks = Column(Text, nullable=True)
    service = Column(String(64), nullable=True, index=True)
    # Phase B (knowledge-workitem-linkage) — service 하위 component (예: k8s→api-server).
    # 자유 텍스트지만 frontend 의 COMPONENT_BY_SERVICE 가 추천 enum 을 제공.
    component = Column(String(64), nullable=True, index=True)
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

    # 등록자(생성자) username — 생성 시 actor 로 기록. 담당자가 아니어도 본인이 만든
    # work item 은 수정/삭제할 수 있도록 ownership 판정에 사용 (nullable: 구버전 호환).
    created_by = Column(String(100), nullable=True, index=True)

    # ── Jira 연동 (가져온 이슈) ──────────────────────────────────────────────
    # jira_issue_id = Jira 내부 불변 ID (정규 dedup 키, 부분 UNIQUE). jira_issue_key 는
    # 표시용(PROJ-123, rename 가능). watchers = 이 이슈를 가져온 PEP username 목록 →
    # "Jira 이슈 1건 = work_item 1건" 으로 사람별 중복 없이 다인 가시성 제공.
    jira_issue_id = Column(String(50), nullable=True)
    jira_issue_key = Column(String(50), nullable=True, index=True)
    jira_url = Column(Text, nullable=True)
    jira_status = Column(String(100), nullable=True)        # 원본 Jira 상태명 (표시/transition)
    jira_synced_at = Column(DateTime, nullable=True)        # 마지막 동기화 시각
    jira_updated_at = Column(DateTime, nullable=True)       # Jira updated (충돌 감지)
    jira_watchers = Column(JSONB, nullable=True)            # list[str] — 가져온 PEP username

    # G-I2: server_default 추가 — DB 직접 INSERT (마이그레이션 backfill 등) 시에도 NULL 방지.
    # `default=datetime.utcnow` 는 ORM 레벨, `server_default=func.now()` 는 DB 레벨.
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        server_default=func.now(),
    )

    cluster = relationship("Cluster", back_populates="work_items", foreign_keys=[cluster_id])
    project = relationship("Project", back_populates="work_items", foreign_keys=[project_id])
    sprint = relationship("Sprint", back_populates="work_items", foreign_keys=[sprint_id])
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
