"""IncidentAnalysis — 알람/K8s 이벤트/수동 트리거로 실행된 AI 장애 분석 결과.

알람(`alert_events`) 또는 K8s 이벤트(`k8s_events`, kubewatch 수신) 수신 시 분석
범위 규칙(AppSetting ``llm_analysis_scope``)에 매칭되면 전용 Celery ``llm`` 큐에서
비동기로 분석해 이 테이블에 남긴다. 두 트리거는 각각 ``alert_event_id`` /
``k8s_event_id`` 중 하나만 채운다(동시에 둘 다 차는 경우 없음).
로그성(무한 증가) 테이블 — backup ``LOG_TABLES`` + retention purge(90일) 대상.
LLM 은 분석 전용이다: 이 결과에는 실행 가능한 필드가 없고, ``suggested_actions``
는 사람이 읽는 조치 가이드 문자열 배열이다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Float, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class IncidentAnalysis(Base):
    __tablename__ = "incident_analyses"
    __table_args__ = (
        Index("ix_incident_analyses_alert_event", "alert_event_id"),
        Index("ix_incident_analyses_k8s_event", "k8s_event_id"),
        Index("ix_incident_analyses_cluster_created", "cluster_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # FK 를 걸지 않는다 — 알람/이벤트가 retention 으로 먼저 지워져도 분석 이력은 조회 가능해야 한다.
    alert_event_id = Column(UUID(as_uuid=True), nullable=True)
    k8s_event_id = Column(UUID(as_uuid=True), nullable=True)
    cluster_id = Column(UUID(as_uuid=True), nullable=True)

    namespace = Column(String(253), nullable=True)
    resource = Column(String(253), nullable=True)

    trigger = Column(String(16), nullable=False, default="alert")   # alert | k8s_event | manual
    # queued | running | done | failed | skipped
    status = Column(String(16), nullable=False, default="queued")

    severity = Column(String(16), nullable=True)
    root_cause = Column(Text, nullable=True)
    suggested_actions = Column(JSONB, nullable=True)                # list[str]
    related_runbooks = Column(JSONB, nullable=True)                 # list[str]
    confidence = Column(Float, nullable=True)
    # Phase 3(RAG)에서 채움 — {title, source_type, ref_id, route, snippet, similarity}[]
    citations = Column(JSONB, nullable=True)

    # 예: "local_llm:internal-llm:corp-qwen3-32b" | "rule_based"
    analyzed_by = Column(String(128), nullable=True)
    matched_rule_id = Column(String(64), nullable=True)

    prompt_tokens = Column(Integer, nullable=True)
    completion_tokens = Column(Integer, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())
    finished_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:
        subject = self.alert_event_id or self.k8s_event_id
        return f"<IncidentAnalysis(subject={subject}, trigger={self.trigger}, status={self.status})>"
