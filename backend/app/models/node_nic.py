"""노드 NIC 상태 — 노드 파라미터 에이전트(1.2.0+)가 보고하는 인터페이스별 상태의 마지막 값.

노드당 1행(``cluster_id``+``node``). ``interfaces`` 는 마지막 보고 그대로(본딩/LACP·링크·MTU·ring buffer·
offload·카운터), ``history`` 는 드롭·CRC·링크 끊김 증가율을 계산하려고 남기는 카운터 표본(5분 간격, 최근 1시간 남짓)이다.
판정은 저장하지 않고 조회할 때마다 ``services/nic_watch/analyze.py`` 가 현재 설정으로 다시 계산한다(설정을 바꾸면 바로 반영).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class NodeNicState(Base):
    __tablename__ = "node_nic_states"
    __table_args__ = (UniqueConstraint("cluster_id", "node", name="uq_node_nic_states_cluster_node"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    node = Column(String(253), nullable=False)
    host_ip = Column(String(64), nullable=True)
    agent_version = Column(String(32), nullable=True)
    collected_at = Column(DateTime, nullable=True)     # 에이전트가 읽은 시각(UTC)
    received_at = Column(DateTime, nullable=True)      # PEP 가 받은 시각 — 보고 끊김 판정
    interfaces = Column(JSONB, nullable=False, default=list)
    errors = Column(JSONB, nullable=False, default=list)
    # [{t: ISO8601, c: {iface: {counter: int}}}] — 오래된 것부터
    history = Column(JSONB, nullable=False, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
