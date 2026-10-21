import uuid
from datetime import datetime
from sqlalchemy import Column, String, Boolean, DateTime, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.database import Base


class Playbook(Base):
    __tablename__ = "playbooks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    # 신 모델: DB 에 저장된 Playbook 파일/Inventory 를 참조 (선택)
    playbook_file_id = Column(
        UUID(as_uuid=True), ForeignKey("ansible_playbook_files.id"), nullable=True,
    )
    inventory_id = Column(
        UUID(as_uuid=True), ForeignKey("ansible_inventories.id"), nullable=True,
    )
    # 구 모델: 실행호스트 경로 직접 지정 — 기존 데이터 호환을 위해 유지(둘 다 nullable).
    playbook_path = Column(String(500), nullable=True)   # path on execution host
    inventory_path = Column(String(500), nullable=True)  # optional inventory override
    extra_vars = Column(JSONB, nullable=True)            # --extra-vars JSON
    tags = Column(String(255), nullable=True)            # --tags filter
    # ansible-playbook 실행 제한 시간(초). NULL = 전역 기본(CHECK_TIMEOUT_SECONDS, 30초).
    # 예전엔 항상 30초 고정이라 실제 운영 플레이북 대부분이 "timed out" 으로 실패했다 — 화면에서 정한다(UI-First).
    timeout_seconds = Column(Integer, nullable=True)
    status = Column(String(20), default="unknown")       # healthy/warning/critical/unknown/running
    show_on_dashboard = Column(Boolean, default=False)   # Dashboard 카드 표시 여부
    last_run_at = Column(DateTime, nullable=True)
    last_result = Column(JSONB, nullable=True)           # parsed ansible JSON callback output
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    cluster = relationship("Cluster", back_populates="playbooks")
    playbook_file = relationship("AnsiblePlaybookFile", lazy="joined")
    inventory = relationship("AnsibleInventory", lazy="joined")
    runs = relationship(
        "PlaybookRun",
        back_populates="playbook",
        cascade="all, delete-orphan",
        order_by="PlaybookRun.started_at.desc()",
    )

    def __repr__(self):
        return f"<Playbook(name={self.name}, status={self.status})>"


class PlaybookRun(Base):
    """Playbook 실행 1건의 append-only 이력 — D-066.

    이전에는 ``Playbook.last_result`` 1행 덮어쓰기만 있어 실행할 때마다 이전 기록이
    사라졌다(이력 테이블 부재). ``BatchJobRun`` 과 동일한 철학(실행자 스냅샷·트리거
    구분·상세 결과 보존)으로 신설 — 다만 Ansible 실행은 kubectl/SSH 계열처럼 단계별
    trace(steps/commands)를 남기지 않으므로 그 두 컬럼은 없고 대신 ``stats``(호스트별
    통계)·``raw_output``(stdout/stderr 발췌)을 ``playbook_executor.PlaybookResult`` 와
    동일한 shape 로 보존한다.
    """
    __tablename__ = "playbook_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    playbook_id = Column(UUID(as_uuid=True), ForeignKey("playbooks.id"), nullable=False)

    # healthy / warning / critical (playbook_executor.PlaybookResult.status 와 동일 어휘 —
    # BatchJobRun.status 의 ok/error 체계와 다르다, Ansible 실행 결과는 StatusEnum 과 1:1).
    # + running(백그라운드 실행 중, R1) / cancelled(사용자 취소, R2).
    status = Column(String(20), nullable=False)
    # manual(UI "실행" 버튼) / check_matrix(매트릭스 셀 cron·수동 실행 경유).
    trigger = Column(String(20), default="manual")

    # 실행자 스냅샷 — 사용자가 나중에 삭제돼도 기록은 유지된다(BatchJobRun 과 동일 패턴).
    # check_matrix 트리거(cron)는 사람이 아니므로 항상 NULL.
    triggered_by_user_id = Column(String(36), nullable=True)
    triggered_by_username = Column(String(64), nullable=True)

    message = Column(String(1000), nullable=True)
    stats = Column(JSONB, nullable=True)
    raw_output = Column(Text, nullable=True)  # stdout/stderr 발췌 — playbook_executor 가 이미 캡핑

    duration_ms = Column(Integer, default=0)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    # R1 실시간 로그 — 실행 중 ansible 콜백 이벤트를 [ts, level, message] 로 쌓는다(상한
    # ``playbook_run_jobs.LOG_LINE_LIMIT``). 화면은 ``GET /playbooks/runs/{id}?since=N`` 으로 이어 읽는다.
    log_lines = Column(JSONB, nullable=True)
    # R2 취소 — 다른 replica 가 요청을 받아도 실행 스레드가 이 플래그를 보고 프로세스를 끊는다.
    cancel_requested = Column(Boolean, default=False, nullable=False)
    cancelled_by = Column(String(64), nullable=True)

    playbook = relationship("Playbook", back_populates="runs")

    def __repr__(self):
        return f"<PlaybookRun(playbook_id={self.playbook_id}, status={self.status})>"
