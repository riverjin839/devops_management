"""NS 마이그레이션 — 개발 클러스터의 네임스페이스 리소스를 운영 클러스터로 옮긴다.

- NsMigrationProfile: 소스/타깃·리소스 종류·치환 규칙 프리셋(화면에서 저장·재사용 — UI-First).
- NsMigrationRun: 계획(plan)·적용(apply) 실행 로그. steps·log_lines 를 단계마다 커밋해 프론트가
  폴링으로 실시간 표시한다(`services/k8s_efficiency/runs.py` RunLogger 재사용). 로그성 — 365일 보존.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class NsMigrationProfile(Base):
    __tablename__ = "ns_migration_profiles"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(128), nullable=False)
    source_cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    target_cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    source_namespace = Column(String(253), nullable=False)
    target_namespace = Column(String(253), nullable=False)
    kinds = Column(JSONB, nullable=False, default=list)       # ["ServiceAccount", "Deployment", ...]
    include_secrets = Column(Boolean, nullable=False, default=False)
    rules = Column(JSONB, nullable=False, default=list)       # [{type, from, to, kind?, name?}]
    options = Column(JSONB, nullable=False, default=dict)     # {keep_node_ports, force_conflicts}
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class NsMigrationRun(Base):
    """계획/적용 실행 1회 — K8sEfficiencyRun 과 같은 steps·log_lines 구조(RunLogger 호환)."""
    __tablename__ = "ns_migration_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    target_cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    source_namespace = Column(String(253), nullable=False)
    target_namespace = Column(String(253), nullable=False)
    mode = Column(String(16), nullable=False, default="plan")        # plan | apply
    dry_run = Column(Boolean, nullable=False, default=True)          # plan 이면 True(서버 dry-run 만)
    spec = Column(JSONB, nullable=True)                               # kinds/include_secrets/rules/options 스냅샷
    triggered_by = Column(String(64), nullable=True)
    run_state = Column(String(16), nullable=False, default="queued")  # queued | running | succeeded | failed | partial
    steps = Column(JSONB, nullable=True)
    log_lines = Column(Text, nullable=False, default="")
    items = Column(JSONB, nullable=True)                              # 리소스별 계획/결과(diff 포함, Secret 값 마스킹)
    summary = Column(JSONB, nullable=True)
    error = Column(String(1000), nullable=True)
    celery_task_id = Column(String(64), nullable=True)
    queued_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_ns_migration_runs_queued", "queued_at"),
    )
