"""Cilium 데이터패스(eBPF) — Rust 노드 에이전트(``agents/pep-bpf-agent``) 보고 상태와 수동 수집 실행 이력.

노드마다 뜨는 에이전트가 Cilium 이 고정(pin)해 둔 BPF 맵을 **읽기 전용**으로 열어 항목 수·최대치를 세고
요약만 보고한다(원본 키·값은 노드 밖으로 나오지 않는다). 판정(사용률 임계치·알람·설정 추천)은 백엔드
``services/cilium_datapath/`` 가 하고, 임계치·주기·예산은 화면에서 고친다(AppSetting ``cilium_datapath.settings``).

- ``CiliumBpfAgent``    : 노드당 1행 — 마지막 보고의 맵·프로그램 요약·커널 기능. 다음 보고로 다시 생기는 파생 데이터.
- ``CiliumDatapathRun`` : 화면 「지금 수집」 1회 = 1행 — 대상·전달·완료 노드와 에이전트가 흘린 로그(로그성).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class CiliumBpfAgent(Base):
    __tablename__ = "cilium_bpf_agents"
    __table_args__ = (UniqueConstraint("cluster_id", "node", name="uq_cilium_bpf_agents_cluster_node"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    node = Column(String(253), nullable=False)
    host_ip = Column(String(64), nullable=True)
    agent_version = Column(String(32), nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    collected_at = Column(String(40), nullable=True)      # 에이전트가 적은 수집 시각(RFC3339)
    collect_ms = Column(Integer, nullable=True)
    # 커널 기능 탐지 — {kernel, cap_bpf, cap_sys_admin, kernel_cap_bpf, kernel_drop_reason, btf, bpf_stats_enabled, pin_dirs_found}
    features = Column(JSONB, nullable=False, default=dict)
    # 맵 요약 — [{name, group, map_type, max_entries, entries, partial, members, elapsed_ms, pinned, error, ...}]
    maps = Column(JSONB, nullable=False, default=list)
    maps_skipped = Column(Integer, nullable=False, default=0)
    # 프로그램 요약(이름별) — [{name, prog_type, count, tags, loaded_at, run_time_ns, run_cnt}]
    programs = Column(JSONB, nullable=False, default=list)
    programs_other = Column(Integer, nullable=False, default=0)
    programs_error = Column(Text, nullable=True)
    # 프로그램 비교 기준 — 첫 보고 또는 운영자가 「현재를 기준으로」 누른 시점의 목록(설정 적용 전후 비교용).
    programs_baseline = Column(JSONB, nullable=True)
    baseline_at = Column(DateTime, nullable=True)
    errors = Column(JSONB, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class CiliumDatapathRun(Base):
    __tablename__ = "cilium_datapath_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(16), nullable=False, default="collect")
    # running | succeeded | partial(일부 노드 무응답) | failed(전부 무응답)
    status = Column(String(16), nullable=False, default="running")
    target_nodes = Column(JSONB, nullable=False, default=list)
    claimed_nodes = Column(JSONB, nullable=False, default=list)   # 에이전트가 작업을 받아 간 노드
    done_nodes = Column(JSONB, nullable=False, default=list)      # 보고까지 끝낸 노드
    # [{ts, level, message, node}] — 상한 LOG_LINE_LIMIT 줄
    log_lines = Column(JSONB, nullable=False, default=list)
    summary = Column(JSONB, nullable=False, default=dict)
    requested_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at = Column(DateTime, nullable=True)
