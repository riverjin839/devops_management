"""Registered batch jobs and their run history.

A "batch job" is a reusable, scheduled-or-manual operational task scoped to a
cluster (etcd defrag, snapshot save, log rotation, etc.). The actual logic for
each job_type lives in `app/services/batch_jobs/` — this model just stores the
template (target host, parameters, schedule) and execution history.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


class BatchJob(Base):
    __tablename__ = "batch_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=False)
    name = Column(String(150), nullable=False)
    description = Column(String(500), nullable=True)

    # job_type maps to a registered BatchJobExecutor key
    # (e.g. "etcdctl_defrag", "etcdctl_snapshot", ...)
    job_type = Column(String(80), nullable=False)

    # Default target host/credentials are NOT stored; only the host hint is.
    # Credentials must be supplied per-run in the API payload (same pattern as
    # routers/etcdctl.py).
    default_host = Column(String(255), nullable=True)
    default_port = Column(Integer, default=22)
    default_username = Column(String(100), default="root")

    # Per-job_type parameters — schema validated by the executor
    params = Column(JSONB, nullable=True)

    # cron expression (optional) — if set, the periodic dispatcher
    # (`run_batch_job_dispatcher` in celery_app.py) picks it up.
    cron = Column(String(80), nullable=True)
    enabled = Column(Boolean, default=True)

    # SSH credentials for **scheduled** runs only. Manual runs must still
    # supply credentials in the request payload (the unencrypted form
    # never leaves the request). Stored ciphertext only — see
    # `app.services.secret_box`.
    encrypted_password = Column(String, nullable=True)
    encrypted_private_key = Column(String, nullable=True)

    last_status = Column(String(20), default="unknown")  # ok / error / running / unknown
    last_run_at = Column(DateTime, nullable=True)

    # 디스패처(매 분)가 이 잡을 마지막으로 평가한 시각/결과 — "왜 스케줄이 안 돌았는지" 진단용.
    last_schedule_check_at = Column(DateTime, nullable=True)
    last_schedule_note = Column(String(200), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    cluster = relationship("Cluster")
    runs = relationship(
        "BatchJobRun",
        back_populates="job",
        cascade="all, delete-orphan",
        order_by="BatchJobRun.started_at.desc()",
    )

    def __repr__(self) -> str:
        return f"<BatchJob(name={self.name}, type={self.job_type})>"


class BatchJobRun(Base):
    __tablename__ = "batch_job_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("batch_jobs.id"), nullable=False)

    status = Column(String(20), nullable=False)  # ok / error / timeout / running
    trigger = Column(String(20), default="manual")  # manual / schedule / bulk

    # 실행자 — 수동/일괄 실행 시 요청한 사용자. 스냅샷(username)이라 사용자가
    # 나중에 삭제돼도 기록은 유지된다(audit_log.actor_username 과 동일 패턴).
    # 스케줄(trigger="schedule") 실행은 사람이 아니므로 항상 NULL.
    triggered_by_user_id = Column(String(36), nullable=True)
    triggered_by_username = Column(String(64), nullable=True)

    host = Column(String(255), nullable=True)
    executed_command = Column(String(2000), nullable=True)
    exit_code = Column(Integer, nullable=True)
    stdout = Column(String, nullable=True)
    stderr = Column(String, nullable=True)
    error = Column(String(1000), nullable=True)

    # 이 실행에 실제로 사용된 merge 후 파라미터 스냅샷 — job.params 가 나중에
    # 바뀌어도 "그때 어떤 설정으로 실행됐는지"(예: k8s_job_cleanup 의 dry_run
    # 여부)를 그대로 확인할 수 있다. admin 감사/재현 목적.
    params_snapshot = Column(JSONB, nullable=True)

    duration_ms = Column(Integer, default=0)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    job = relationship("BatchJob", back_populates="runs")
