"""
Deep Check models — Super Pod 결과 + 사용자 정의 체크 정의 + 알림 채널.

기존 DailyCheckLog 는 그대로 유지하며, 그 위에 다음을 추가한다:

* DeepCheckDefinition — UI 에서 편집 가능한 체크 정의 (cluster_id NULL = 글로벌).
* DeepCheckResult     — Super Pod (또는 in-cluster CronJob) 가 push 한 결과.
                        같은 daily_check_log_id 로 묶어 한 회차의 deep 결과를 연결.
* NotificationChannel — Slack / Email / Webhook / K8sEvent 채널 정의.
* NotificationLog     — 발송 이력.
"""
import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base
from app.models.cluster import StatusEnum


class DeepCheckDefinition(Base):
    """사용자 편집 가능한 deep-check 정의.

    metric_cards 와 동일한 패턴: UI 에서 enable/disable, 임계값/파라미터 수정 가능.
    cluster_id 가 NULL 이면 글로벌 (모든 클러스터에 적용), 값이 있으면 해당 클러스터 전용.
    """

    __tablename__ = "deep_check_definitions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=True)

    check_type = Column(String(50), nullable=False)
    # registry 에서 매핑되는 type key: cert_expiry / etcd_defrag / cni_flow / pvc_health /
    # image_pull / audit_rbac. 추가 체커가 들어오면 여기 enum 을 확장.

    name = Column(String(150), nullable=False)
    description = Column(Text, nullable=True)

    enabled = Column(Boolean, default=True, nullable=False)

    schedule_cron = Column(String(100), nullable=True)
    # NULL 이면 체크매트릭스(CheckMatrixSchedule) 쪽 cron 만 적용.
    # 값을 주면 매분 check-matrix 디스패처가 이 정의를 단독으로 due 평가해 실행한다
    # (글로벌 정의는 전체 클러스터 대상). custom_* 정의의 주 스케줄 수단.

    last_run_at = Column(DateTime, nullable=True)
    # schedule_cron 디스패치 anchor — 마지막 자동 실행 시각(UTC).

    thresholds = Column(JSONB, nullable=True)
    # 예: {"warning_days": 30, "critical_days": 7}
    params = Column(JSONB, nullable=True)
    # 예: {"namespace": "kube-system", "exclude_pods": [...]}

    sort_order = Column(Integer, default=0)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    cluster = relationship("Cluster", backref="deep_check_definitions")

    def __repr__(self) -> str:
        return f"<DeepCheckDefinition(name={self.name}, type={self.check_type})>"


class DeepCheckResult(Base):
    """Super Pod 가 산출한 deep-check 결과 한 행.

    한 번의 daily check 사이클당 0..N 개 result 가 daily_check_log_id 로 묶인다.
    """

    __tablename__ = "deep_check_results"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=False)
    daily_check_log_id = Column(
        UUID(as_uuid=True),
        ForeignKey("daily_check_logs.id"),
        nullable=True,
    )
    definition_id = Column(
        UUID(as_uuid=True),
        ForeignKey("deep_check_definitions.id"),
        nullable=True,
    )

    check_type = Column(String(50), nullable=False)
    status = Column(Enum(StatusEnum), nullable=False)
    message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    duration_ms = Column(Integer, default=0)

    # AI 요약은 회차(=daily_check_log_id) 레벨로 저장하되, 개별 result 가 별도로
    # remediation 을 가질 수 있도록 별도 필드도 둠.
    ai_summary = Column(Text, nullable=True)
    ai_remediation = Column(Text, nullable=True)

    checked_at = Column(DateTime, default=datetime.utcnow)

    cluster = relationship("Cluster", backref="deep_check_results")

    def __repr__(self) -> str:
        return (
            f"<DeepCheckResult(cluster_id={self.cluster_id}, "
            f"type={self.check_type}, status={self.status})>"
        )


class NotificationChannelType(str, enum.Enum):
    slack = "slack"
    email = "email"
    webhook = "webhook"
    k8s_event = "k8s_event"


class NotificationChannel(Base):
    """Slack/Email/Webhook/K8sEvent 알림 채널 정의."""

    __tablename__ = "notification_channels"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    channel_type = Column(Enum(NotificationChannelType), nullable=False)

    enabled = Column(Boolean, default=True, nullable=False)

    # 필터 — 어떤 클러스터/심각도일 때 발송할지.
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id"), nullable=True)
    min_severity = Column(String(20), default="warning")  # warning | critical

    config = Column(JSONB, nullable=True)
    # slack: {"webhook_url": "..."}
    # email: {"smtp_host": "...", "to": ["..."]}
    # webhook: {"url": "...", "headers": {...}}
    # k8s_event: {"namespace": "k8s-monitor"}

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<NotificationChannel(name={self.name}, type={self.channel_type})>"


class NotificationLog(Base):
    """알림 발송 이력."""

    __tablename__ = "notification_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    channel_id = Column(
        UUID(as_uuid=True),
        ForeignKey("notification_channels.id"),
        nullable=True,
    )
    daily_check_log_id = Column(
        UUID(as_uuid=True),
        ForeignKey("daily_check_logs.id"),
        nullable=True,
    )

    status = Column(String(20), nullable=False)  # sent | failed | skipped
    subject = Column(String(500), nullable=True)
    body = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    sent_at = Column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<NotificationLog(channel_id={self.channel_id}, status={self.status})>"
