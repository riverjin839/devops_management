"""운영 점검(Ops Checks) 통합 실행 기록.

여러 점검 소스(deep_check / addon / batch_job / playbook)를 하나의 리스트에서
골라 일괄(batch) 실행할 때, 그 한 번의 실행 묶음과 항목별 진행/결과/로그를
한 곳에 저장한다. 콘솔 UI 는 ``OpsCheckRunItem`` 의 status(queued→running→
done/error) 를 폴링해 진행률을 보여주고, ``details`` 로 항목별 로그를 연다.

기존 DeepCheckResult / CheckLog / BatchJobRun 등 소스별 결과는 그대로 유지하고,
운영 점검 콘솔은 그 위에 "실행 묶음" 레이어만 얹는다.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base
from app.models.cluster import StatusEnum


class OpsCheckRun(Base):
    """운영 점검 한 번의 실행 묶음 (선택한 N개 항목)."""

    __tablename__ = "ops_check_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=False)

    # pending → running → done | cancelled
    status = Column(String(20), default="pending", nullable=False)
    trigger = Column(String(20), default="manual")  # manual | alert | schedule
    triggered_by = Column(String(100), nullable=True)

    total = Column(Integer, default=0)
    ok_count = Column(Integer, default=0)
    warn_count = Column(Integer, default=0)
    crit_count = Column(Integer, default=0)
    error_count = Column(Integer, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    cluster = relationship("Cluster")
    items = relationship(
        "OpsCheckRunItem",
        back_populates="run",
        cascade="all, delete-orphan",
        order_by="OpsCheckRunItem.created_at",
    )

    def __repr__(self) -> str:
        return f"<OpsCheckRun(cluster_id={self.cluster_id}, status={self.status}, total={self.total})>"


class OpsCheckRunItem(Base):
    """실행 묶음 안의 점검 항목 1개 — 진행 상태 + 결과 + 로그(details)."""

    __tablename__ = "ops_check_run_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(
        UUID(as_uuid=True),
        ForeignKey("ops_check_runs.id", ondelete="CASCADE"),
        nullable=False,
    )

    # 소스 식별 — deep_check | addon | batch_job | playbook
    source = Column(String(20), nullable=False)
    # 소스별 원본 항목 id (DeepCheckDefinition.id / Addon.id / BatchJob.id / Playbook.id)
    item_ref_id = Column(String(100), nullable=False)
    check_type = Column(String(80), nullable=True)
    name = Column(String(200), nullable=True)

    # 실행 진행 상태 — queued → running → done | error
    status = Column(String(20), default="queued", nullable=False)
    # 점검 판정 결과 — healthy | warning | critical | pending (실행 완료 후)
    result_status = Column(Enum(StatusEnum), nullable=True)

    message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    duration_ms = Column(Integer, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)

    run = relationship("OpsCheckRun", back_populates="items")

    def __repr__(self) -> str:
        return f"<OpsCheckRunItem(source={self.source}, ref={self.item_ref_id}, status={self.status})>"
