"""점검 매트릭스(Check Matrix) — 행(점검 항목) × 열(클러스터) 그리드.

기존 CheckSchedule(아침/점심/저녁)을 완전 대체하는 스케줄 체계이며,
core_bundle 행(예: API 응답시간)만 Cluster.check_cron_expr 로 스케줄되고
(DailyChecker.run_daily_check 원자 실행 재사용 — Cluster.status authority 보존),
나머지 행(deep_check/addon/manual)은 이 모듈의 CheckMatrixSchedule 로 항목×클러스터
단위 cron 을 관리한다.

- CheckMatrixItem       — 행 카탈로그(사용자 CRUD).
- CheckMatrixSchedule   — item × cluster cron (core_bundle 행 제외).
- CheckMatrixResult     — 셀의 최신 스냅샷(upsert).
- CheckMatrixResultLog  — 셀의 append-only 이력(트렌드 차트 + 변경 이력, 리텐션 정리 대상).
"""
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Enum, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import backref, relationship

from app.database import Base
from app.models.cluster import StatusEnum


class CheckMatrixSourceType(str, enum.Enum):
    core_bundle = "core_bundle"  # DailyChecker 원자 실행 결과 투영 (cron 은 Cluster.check_cron_expr)
    deep_check = "deep_check"    # deep_checkers.REGISTRY 의 check_type 실행
    addon = "addon"              # Addon.type 매칭 실행 (HealthChecker)
    manual = "manual"            # 자동 실행 없음 — 사용자가 값을 직접 입력


class CheckMatrixItem(Base):
    """점검 매트릭스 행(카탈로그). 사용자가 추가/삭제/재정렬 가능."""
    __tablename__ = "check_matrix_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(150), nullable=False)
    description = Column(Text, nullable=True)
    unit = Column(String(20), nullable=True)  # 예: "ms", "%"

    source_type = Column(Enum(CheckMatrixSourceType), nullable=False)
    # 논리 키 — deep_check: check_type / addon: Addon.type 문자열 / core_bundle·manual: NULL.
    # 클러스터별 실제 인스턴스(DeepCheckDefinition, Addon)는 실행/조회 시점에 이 키로 해석한다.
    source_ref = Column(String(80), nullable=True)

    # core_bundle 행은 삭제 불가(Cluster.status 계산에 필요한 DailyChecker 실행은 행 존재와
    # 무관하게 계속 돌아야 함) — 라우터에서 이 플래그로 삭제를 막고 "그리드에서 숨기기"만 허용.
    is_system = Column(Boolean, nullable=False, default=False)
    enabled = Column(Boolean, nullable=False, default=True)  # false = 그리드에서 숨김

    sort_order = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<CheckMatrixItem(name={self.name}, source_type={self.source_type})>"


class CheckMatrixSchedule(Base):
    """item × cluster cron 설정. core_bundle 행은 여기 쓰지 않고 Cluster.check_cron_expr 사용."""
    __tablename__ = "check_matrix_schedules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    item_id = Column(UUID(as_uuid=True), ForeignKey("check_matrix_items.id", ondelete="CASCADE"), nullable=False)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)

    cron_expr = Column(String(100), nullable=True)  # NULL = 미스케줄(수동 실행만)
    enabled = Column(Boolean, nullable=False, default=True)
    last_run_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    item = relationship("CheckMatrixItem", backref="schedules")
    # passive_deletes=True — Cluster 삭제 시 ORM 이 cluster_id 를 NULL 로 UPDATE 하는 것을
    # 막는다(NOT NULL 이면 NotNullViolation). 정리는 services/cluster_purge.py 담당.
    cluster = relationship("Cluster", backref=backref("check_matrix_schedules", passive_deletes=True))

    __table_args__ = (
        UniqueConstraint("item_id", "cluster_id", name="uq_check_matrix_schedule"),
    )


class CheckMatrixResult(Base):
    """셀의 최신 스냅샷 — item × cluster 당 1행(upsert)."""
    __tablename__ = "check_matrix_results"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    item_id = Column(UUID(as_uuid=True), ForeignKey("check_matrix_items.id", ondelete="CASCADE"), nullable=False)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)

    status = Column(Enum(StatusEnum), nullable=False, default=StatusEnum.pending)
    value = Column(Float, nullable=True)
    message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    checked_at = Column(DateTime, default=datetime.utcnow)

    item = relationship("CheckMatrixItem", backref="latest_results")
    # passive_deletes=True — Cluster 삭제 시 ORM 이 cluster_id 를 NULL 로 UPDATE 하는 것을
    # 막는다(NOT NULL 이면 NotNullViolation). 정리는 services/cluster_purge.py 담당.
    cluster = relationship("Cluster", backref=backref("check_matrix_results", passive_deletes=True))

    __table_args__ = (
        UniqueConstraint("item_id", "cluster_id", name="uq_check_matrix_result"),
    )


class CheckMatrixResultLog(Base):
    """셀의 append-only 이력 — 트렌드 차트 / 변경 이력. 리텐션 설정에 따라 정기 정리."""
    __tablename__ = "check_matrix_result_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    item_id = Column(UUID(as_uuid=True), ForeignKey("check_matrix_items.id", ondelete="CASCADE"), nullable=False)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)

    status = Column(Enum(StatusEnum), nullable=False, default=StatusEnum.pending)
    value = Column(Float, nullable=True)
    message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    checked_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_check_matrix_log_cell", "item_id", "cluster_id", "checked_at"),
        # 리텐션 퍼지 스캔은 item_id/cluster_id 등호 조건이 없으므로 checked_at 단독 인덱스도 필요.
        Index("ix_check_matrix_log_checked_at", "checked_at"),
    )

    def __repr__(self) -> str:
        return f"<CheckMatrixResultLog(item_id={self.item_id}, cluster_id={self.cluster_id}, status={self.status})>"
