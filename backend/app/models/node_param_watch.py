"""노드 OS(커널) 파라미터 감시 — 감시 규칙 + 노드 에이전트 상태.

노드마다 떠 있는 에이전트(DaemonSet, ``python -m app.node_param_agent``)가 ``/proc/sys`` 의 런타임 값과
``/etc/sysctl.d`` 등 영구 설정 값을 주기적으로 보고하면, 백엔드가 아래 규칙으로 판정해
알람 인박스(``alert_events``, source=``node-param-agent``)로 보낸다. 값 자체의 이력은
``cluster_config_snapshots``(component ``node_params:{node}``)와 ``os_param_changes`` 가 들고 있다.

- ``NodeParamWatchRule`` : 무엇을 감시하고 기준값이 무엇인지 — 화면에서 편집한다(UI-First).
  ``cluster_id`` NULL = 모든 클러스터 공통. 같은 파라미터에 클러스터 규칙이 있으면 공통 규칙은 그 클러스터에서 무시된다.
- ``NodeParamAgent`` : 노드별 에이전트의 마지막 보고 상태 — 무응답 감지(워치독)와 화면 표시용.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class NodeParamWatchRule(Base):
    __tablename__ = "node_param_watch_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = 모든 클러스터 공통 규칙
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=True, index=True)
    param = Column(String(300), nullable=False)          # 예: net.core.somaxconn
    # any(변경만 추적) | eq | ne | gte | lte | in
    operator = Column(String(8), nullable=False, default="any")
    expected = Column(String(500), nullable=True)        # in 은 '|' 로 구분
    # 적용 노드 — 노드 이름 glob, 쉼표로 여러 개. 비우면 모든 노드.
    node_pattern = Column(String(500), nullable=True)
    severity = Column(String(16), nullable=False, default="warning")   # info | warning | critical
    alert_on_change = Column(Boolean, nullable=False, default=True)    # 값이 바뀌면 알람
    check_persistent = Column(Boolean, nullable=False, default=True)   # 런타임 ≠ 영구 설정이면 알람
    description = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class NodeParamAgent(Base):
    __tablename__ = "node_param_agents"
    __table_args__ = (UniqueConstraint("cluster_id", "node", name="uq_node_param_agents_cluster_node"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    node = Column(String(253), nullable=False)
    host_ip = Column(String(64), nullable=True)
    agent_version = Column(String(32), nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    param_count = Column(Integer, nullable=False, default=0)
    violation_count = Column(Integer, nullable=False, default=0)
    mismatch_count = Column(Integer, nullable=False, default=0)
    last_change_at = Column(DateTime, nullable=True)      # 마지막으로 값 변경을 감지한 시각
    last_error = Column(Text, nullable=True)              # 에이전트가 보고한 읽기 오류 요약
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
