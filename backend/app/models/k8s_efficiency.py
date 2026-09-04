"""K8S 자원 효율화 — 히스토리 샘플 · 추천 · NS 정책 · 실행 로그.

- K8sNamespaceSample / K8sWorkloadSample: Celery 수집 워커가 주기적으로 적재하는 request/limit/
  usage/quota 시계열(로그성 — `log_retention_service` 로 보존기간 정리, backup 은 `LOG_TABLES`).
- K8sRightsizeRecommendation: 컨테이너 request 축소 추천(엔진 산출물). 재생성 시 기존 open 은
  superseded 로 밀린다.
- K8sNamespacePolicy: NS 별 자동화 opt-in(자동 right-size / ResourceQuota 탄력 / CR 어댑터).
- K8sEfficiencyRun: 수집·적용·롤백·쿼터 조정 실행 로그(steps + log_lines 를 단계마다 커밋해
  프론트가 폴링으로 실시간 표시).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import backref, relationship

from app.database import Base


class K8sNamespaceSample(Base):
    """네임스페이스 단위 샘플(1 수집 = NS 당 1행)."""
    __tablename__ = "k8s_ns_samples"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace = Column(String(253), nullable=False)
    sampled_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    pod_count = Column(Integer, nullable=False, default=0)
    workload_count = Column(Integer, nullable=False, default=0)
    no_request_pods = Column(Integer, nullable=False, default=0)
    cpu_req_m = Column(BigInteger, nullable=False, default=0)
    mem_req_b = Column(BigInteger, nullable=False, default=0)
    cpu_lim_m = Column(BigInteger, nullable=False, default=0)
    mem_lim_b = Column(BigInteger, nullable=False, default=0)
    cpu_use_m = Column(BigInteger, nullable=True)
    mem_use_b = Column(BigInteger, nullable=True)
    usage_source = Column(String(16), nullable=False, default="none")   # metrics | prometheus | none
    quota_name = Column(String(253), nullable=True)
    quota_hard_cpu_m = Column(BigInteger, nullable=True)
    quota_hard_mem_b = Column(BigInteger, nullable=True)
    quota_used_cpu_m = Column(BigInteger, nullable=True)
    quota_used_mem_b = Column(BigInteger, nullable=True)

    cluster = relationship("Cluster", backref=backref("k8s_ns_samples", passive_deletes=True))

    __table_args__ = (
        Index("ix_k8s_ns_samples_key", "cluster_id", "namespace", "sampled_at"),
        Index("ix_k8s_ns_samples_at", "sampled_at"),
    )


class K8sWorkloadSample(Base):
    """워크로드 단위 샘플. containers = {name: {rc,rm,lc,lm(파드당 request/limit), uc_avg,um_avg,uc_max,um_max}}."""
    __tablename__ = "k8s_workload_samples"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace = Column(String(253), nullable=False)
    kind = Column(String(64), nullable=False)
    name = Column(String(253), nullable=False)
    sampled_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    pod_count = Column(Integer, nullable=False, default=0)
    cpu_req_m = Column(BigInteger, nullable=False, default=0)
    mem_req_b = Column(BigInteger, nullable=False, default=0)
    cpu_lim_m = Column(BigInteger, nullable=False, default=0)
    mem_lim_b = Column(BigInteger, nullable=False, default=0)
    cpu_use_m = Column(BigInteger, nullable=True)
    mem_use_b = Column(BigInteger, nullable=True)
    containers = Column(JSONB, nullable=False, default=dict)
    pods = Column(JSONB, nullable=True)            # 파드 이름 목록(Prometheus 귀속용)
    managed_by = Column(JSONB, nullable=True)      # {api_version, kind, name} — 오퍼레이터(CR) 관리 시
    optout = Column(Boolean, nullable=False, default=False)

    cluster = relationship("Cluster", backref=backref("k8s_workload_samples", passive_deletes=True))

    __table_args__ = (
        Index("ix_k8s_wl_samples_key", "cluster_id", "namespace", "kind", "name", "sampled_at"),
        Index("ix_k8s_wl_samples_at", "sampled_at"),
    )


class K8sRightsizeRecommendation(Base):
    __tablename__ = "k8s_rightsize_recommendations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace = Column(String(253), nullable=False)
    kind = Column(String(64), nullable=False)
    name = Column(String(253), nullable=False)
    container = Column(String(253), nullable=False)
    resource = Column(String(8), nullable=False)               # cpu | memory
    pod_count = Column(Integer, nullable=False, default=1)
    current_req = Column(BigInteger, nullable=False)           # 파드당(cpu=millicores, memory=bytes)
    target_req = Column(BigInteger, nullable=False)
    current_lim = Column(BigInteger, nullable=True)
    target_lim = Column(BigInteger, nullable=True)
    p95_use = Column(BigInteger, nullable=True)
    usage_source = Column(String(16), nullable=False, default="none")
    samples = Column(Integer, nullable=False, default=0)
    window_days = Column(Integer, nullable=False, default=7)
    savings = Column(BigInteger, nullable=False, default=0)    # (current-target) × pod_count
    reason = Column(JSONB, nullable=True)
    managed_by = Column(JSONB, nullable=True)
    recommend_only = Column(Boolean, nullable=False, default=False)
    hint = Column(String(300), nullable=True)
    status = Column(String(16), nullable=False, default="open")   # open | applied | dismissed | superseded
    applied_run_id = Column(UUID(as_uuid=True), nullable=True)
    dismissed_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    cluster = relationship("Cluster", backref=backref("k8s_rightsize_recommendations", passive_deletes=True))

    __table_args__ = (
        Index("ix_k8s_rs_rec_cluster_status", "cluster_id", "status"),
        Index("ix_k8s_rs_rec_target", "cluster_id", "namespace", "kind", "name", "container", "resource"),
    )


class K8sNamespacePolicy(Base):
    __tablename__ = "k8s_namespace_policies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace = Column(String(253), nullable=False)
    auto_rightsize = Column(Boolean, nullable=False, default=False)
    quota_elastic = Column(Boolean, nullable=False, default=False)
    quota_name = Column(String(253), nullable=True)
    quota_cpu_min_m = Column(BigInteger, nullable=True)
    quota_cpu_max_m = Column(BigInteger, nullable=True)
    quota_mem_min_b = Column(BigInteger, nullable=True)
    quota_mem_max_b = Column(BigInteger, nullable=True)
    rightsize_params = Column(JSONB, nullable=True)   # 전역 기본값 오버라이드(headroom_pct, cooldown_minutes, max_step_pct, ...)
    quota_params = Column(JSONB, nullable=True)       # 전역 quota 기본값 오버라이드
    custom_targets = Column(JSONB, nullable=True)     # [{group,version,plural,name,jsonpath,min,max,label}]
    last_auto_apply_at = Column(DateTime, nullable=True)
    last_quota_adjust_at = Column(DateTime, nullable=True)
    updated_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    cluster = relationship("Cluster", backref=backref("k8s_namespace_policies", passive_deletes=True))

    __table_args__ = (
        UniqueConstraint("cluster_id", "namespace", name="uq_k8s_ns_policy"),
    )


class K8sEfficiencyRun(Base):
    """수집/적용/롤백/쿼터 조정 실행 로그 — steps·log_lines 를 단계마다 커밋해 폴링 스트리밍."""
    __tablename__ = "k8s_efficiency_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    run_type = Column(String(32), nullable=False)      # collect | recommend | rightsize_apply | quota_adjust | custom_scale
    trigger = Column(String(16), nullable=False, default="manual")   # manual | auto | rollback | schedule
    triggered_by = Column(String(64), nullable=True)
    run_state = Column(String(16), nullable=False, default="queued")  # queued | running | succeeded | failed | partial
    dry_run = Column(Boolean, nullable=False, default=False)
    targets = Column(JSONB, nullable=True)
    before = Column(JSONB, nullable=True)
    after = Column(JSONB, nullable=True)
    steps = Column(JSONB, nullable=True)              # [{id,label,status,detail,started_ms,duration_ms}]
    log_lines = Column(Text, nullable=False, default="")
    summary = Column(JSONB, nullable=True)
    error = Column(String(1000), nullable=True)
    rollback_of = Column(UUID(as_uuid=True), nullable=True)
    celery_task_id = Column(String(64), nullable=True)
    queued_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=False, default=0)

    cluster = relationship("Cluster", backref=backref("k8s_efficiency_runs", passive_deletes=True))

    __table_args__ = (
        Index("ix_k8s_eff_runs_cluster_queued", "cluster_id", "queued_at"),
        Index("ix_k8s_eff_runs_queued", "queued_at"),
    )
