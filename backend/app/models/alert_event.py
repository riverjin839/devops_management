"""AlertEvent — 외부(Alertmanager / 사내 alert-forwarder)에서 수신한 인시던트 알람.

`k8s_events`(kubewatch 로 받는 K8s Event)와 별개다. 알람은 fingerprint 로 동일성이 정의되고
firing → resolved 로 상태가 바뀌며, 같은 알람이 짧은 시간에 반복 수신되므로 행을 늘리지 않고
`occurrences` 를 증가시키는 upsert 로 관리한다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base

# 심각도 정렬용 — 규칙의 severity_min 비교에 사용
SEVERITY_ORDER = {"info": 0, "warning": 1, "critical": 2}


class AlertEvent(Base):
    __tablename__ = "alert_events"
    __table_args__ = (
        Index("ix_alert_events_cluster_received", "cluster_id", "received_at"),
        Index("ix_alert_events_status_severity", "status", "severity"),
        Index("ix_alert_events_fingerprint_starts", "fingerprint", "starts_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # FK 를 걸지 않는다 — 알람 라벨로 클러스터를 못 찾아도 수신은 성공해야 한다(k8s_events 와 동일).
    cluster_id = Column(UUID(as_uuid=True), nullable=True, index=True)

    # alertmanager | forwarder | manual
    source = Column(String(32), nullable=False, default="alertmanager")
    fingerprint = Column(String(64), nullable=False, index=True)
    alertname = Column(String(255), nullable=False, index=True)

    severity = Column(String(16), nullable=False, default="warning")   # info | warning | critical
    # payload = 수신 페이로드가 준 값, rule = 알림 규칙의 severity_override 가 바꾼 값
    severity_source = Column(String(16), nullable=False, default="payload")
    status = Column(String(16), nullable=False, default="firing")      # firing | resolved

    namespace = Column(String(253), nullable=True)
    resource = Column(String(253), nullable=True)                      # pod / node / instance
    summary = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)

    labels = Column(JSONB, nullable=True)
    annotations = Column(JSONB, nullable=True)

    starts_at = Column(DateTime, nullable=True)
    ends_at = Column(DateTime, nullable=True)
    generator_url = Column(String(1024), nullable=True)

    # 같은 fingerprint+starts_at 으로 몇 번 수신됐는지
    occurrences = Column(Integer, nullable=False, default=1)
    # 실제로 개인 알림(종)을 몇 번 만들었는지 / 마지막으로 만든 시각
    notify_count = Column(Integer, nullable=False, default=0)
    last_notified_at = Column(DateTime, nullable=True)
    # 중복 억제 창 안에서 알림을 만들지 않고 넘긴 횟수
    suppressed_count = Column(Integer, nullable=False, default=0)

    acked = Column(Boolean, nullable=False, default=False)
    ack_by = Column(String(128), nullable=True)
    ack_at = Column(DateTime, nullable=True)

    # AI 자동 분석 연결 (incident_analyses) — FK 없음(분석 실패/삭제가 알람에 영향 없도록).
    # analysis_status: null(미대상) | queued | running | done | failed | skipped
    analysis_id = Column(UUID(as_uuid=True), nullable=True)
    analysis_status = Column(String(16), nullable=True)

    raw = Column(JSONB, nullable=True)
    received_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<AlertEvent(alertname={self.alertname}, status={self.status}, sev={self.severity})>"
