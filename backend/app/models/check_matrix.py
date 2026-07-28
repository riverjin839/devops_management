"""점검 매트릭스(Check Matrix) — 행(점검 항목) × 열(클러스터) 그리드.

기존 CheckSchedule(아침/점심/저녁)을 완전 대체하는 스케줄 체계이며,
core_bundle 행(예: API 응답시간)만 Cluster.check_cron_expr 로 스케줄되고
(DailyChecker.run_daily_check 원자 실행 재사용 — Cluster.status authority 보존),
나머지 행(deep_check/addon/manual)은 이 모듈의 CheckMatrixSchedule 로 항목×클러스터
단위 cron 을 관리한다.

- CheckMatrixItem       — 행 카탈로그(사용자 CRUD).
- CheckMatrixSchedule   — item × cluster cron (core_bundle 행 제외).
- CheckMatrixResult     — 셀의 최신 스냅샷(upsert).
- CheckMatrixResultLog  — 셀의 append-only 값 이력(트렌드 차트 + 변경 이력, 리텐션 정리 대상).
- CheckMatrixRun        — **수행 1건**의 실행 로그(누가/무엇으로 트리거했고 어떤 명령이
                          어떤 출력과 함께 돌았는지). ResultLog 가 "값의 역사"라면 Run 은
                          "실행의 역사"다 — queued/running 같은 판정 이전 상태와 skipped
                          (대상 미존재)까지 남기므로 트렌드 차트를 오염시키지 않는다.
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


class CheckMatrixTrigger(str, enum.Enum):
    """수행을 일으킨 주체 — 실행 로그 필터/집계용."""
    cron = "cron"                      # Celery Beat cron 디스패치(자동)
    manual_cell = "manual_cell"        # 셀 1개 개별 수행
    manual_cluster = "manual_cluster"  # 클러스터(열) 단위 일괄 수행
    manual_item = "manual_item"        # 공통 점검 항목(행) 단위 일괄 수행
    manual_entry = "manual_entry"      # 수동 입력(manual 항목 값 기입)


class CheckMatrixRunState(str, enum.Enum):
    """수행 자체의 생명주기 — 점검 판정(StatusEnum)과 별개."""
    queued = "queued"
    running = "running"
    success = "success"
    failed = "failed"
    skipped = "skipped"  # 이 클러스터에 실행 대상(정의/애드온)이 없어 수행하지 않음


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


class CheckMatrixRun(Base):
    """수행 1건의 실행 로그 — cron 자동 실행과 수동 실행(셀/클러스터/항목)을 모두 남긴다.

    ``details`` 에는 체커가 돌려준 원본 details 에 더해 실행 관찰값이 들어간다:
      - ``_steps``    : 체커의 단계 트레이스(ExecutionStep) — 실행 단계 타임라인 렌더용.
      - ``_commands`` : 실제로 대상 클러스터에 나간 명령 목록(kubectl/HTTP)과 종료 코드·
                        stdout/stderr 발췌. "PEP 가 내 클러스터에 무슨 명령을 쐈나"의 근거.
      - ``_runbook``  : 실행 시점에 해석된 실행 계획(대상 정의/애드온·파라미터).
    """
    __tablename__ = "check_matrix_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 클러스터/항목 단위 일괄 수행 1회를 묶는 키. 셀 단독 수행이면 자기 자신만 묶인다.
    batch_id = Column(UUID(as_uuid=True), nullable=True)

    item_id = Column(UUID(as_uuid=True), ForeignKey("check_matrix_items.id", ondelete="CASCADE"), nullable=False)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)

    trigger = Column(Enum(CheckMatrixTrigger), nullable=False, default=CheckMatrixTrigger.cron)
    # 사용자 삭제 후에도 로그는 남아야 하므로 FK 를 걸지 않고 표시용 이름만 보존한다.
    triggered_by = Column(String(100), nullable=True)

    run_state = Column(Enum(CheckMatrixRunState), nullable=False, default=CheckMatrixRunState.queued)
    # 점검 판정 결과 — queued/running/skipped 이면 NULL.
    status = Column(Enum(StatusEnum), nullable=True)
    value = Column(Float, nullable=True)
    message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    error = Column(Text, nullable=True)

    duration_ms = Column(Integer, nullable=True)
    queued_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)

    item = relationship("CheckMatrixItem", backref="runs")
    cluster = relationship("Cluster", backref="check_matrix_runs")

    __table_args__ = (
        Index("ix_check_matrix_runs_cell", "item_id", "cluster_id", "queued_at"),
        Index("ix_check_matrix_runs_queued_at", "queued_at"),
        Index("ix_check_matrix_runs_batch", "batch_id"),
    )

    def __repr__(self) -> str:
        return f"<CheckMatrixRun(item_id={self.item_id}, cluster_id={self.cluster_id}, state={self.run_state})>"
