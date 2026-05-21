"""LakeService — K8s 클러스터 위 LAKE 도메인 OSS 서비스 (airflow/spark/iceberg/trino/
starrocks/jupyterlab/superset/polaris) 인스턴스 등록 + 헬스체크 결과 보관.

설계 원칙:
 - service_type 은 정적 enum (코드 catalog) — 신규 서비스 추가 시 Checker 클래스 + registry 등록 필요.
 - cluster_id 는 필수 — LAKE 서비스는 항상 특정 클러스터 안에서 동작.
 - endpoint_url 은 사용자가 입력 — in-cluster Service URL 또는 외부 노출 URL.
 - tls_verify 는 cluster.tls_verify 와 동일 정책 — 폐쇄망 자체 인증서 환경 호환.

기존 자산과의 관계:
 - ServiceEntry (kind=guide/history) 는 service 슬러그(=service_type) 매칭으로 detail 에 표시.
 - Cluster 와 cascade — cluster 삭제 시 LakeService 도 정리.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, DateTime, Boolean, Integer, ForeignKey, Index,
    UniqueConstraint, Enum, func,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.database import Base
from app.models.cluster import StatusEnum


class LakeService(Base):
    """LAKE 서비스 인스턴스. cluster + service_type + name 으로 unique."""
    __tablename__ = "lake_services"
    __table_args__ = (
        UniqueConstraint("cluster_id", "service_type", "name", name="uq_lake_cluster_type_name"),
        Index("ix_lake_services_cluster_status", "cluster_id", "status"),
        Index("ix_lake_services_type", "service_type"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(
        UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False
    )
    # airflow|spark|iceberg|trino|starrocks|jupyterlab|superset|polaris (코드 catalog)
    service_type = Column(String(32), nullable=False)
    # 사용자 정의 인스턴스 이름 — "Prod Airflow", "Lake A"
    name = Column(String(100), nullable=False)
    # catalog|runtime|analytics — service_type 으로 자동 결정 권장 (router 에서 set)
    category = Column(String(20), nullable=False, default="runtime")
    endpoint_url = Column(String(512), nullable=False)
    namespace = Column(String(100), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    # 폐쇄망 자체 인증서 환경 호환 (cluster.tls_verify 와 동일 정책)
    tls_verify = Column(Boolean, nullable=False, default=False, server_default="false")
    # 최신 헬스체크 결과 summary (자세한 history 는 LakeServiceCheck)
    status = Column(Enum(StatusEnum), nullable=False, default=StatusEnum.pending, server_default="pending")
    last_checked_at = Column(DateTime, nullable=True)
    last_message = Column(Text, nullable=True)
    # 사용자 정의 메타 (라벨/태그/노트)
    meta = Column(JSONB, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
        server_default=func.now(), nullable=False,
    )

    cluster = relationship("Cluster")
    checks = relationship(
        "LakeServiceCheck", back_populates="service", cascade="all, delete-orphan",
        order_by="desc(LakeServiceCheck.checked_at)",
    )

    def __repr__(self):
        return f"<LakeService(type={self.service_type}, name={self.name}, status={self.status})>"


class LakeServiceCheck(Base):
    """단일 헬스체크 결과 (수동 또는 스케줄). 시간순 history."""
    __tablename__ = "lake_service_checks"
    __table_args__ = (
        Index("ix_lake_checks_service_checked", "service_id", "checked_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    service_id = Column(
        UUID(as_uuid=True), ForeignKey("lake_services.id", ondelete="CASCADE"), nullable=False
    )
    status = Column(Enum(StatusEnum), nullable=False)
    response_time_ms = Column(Integer, nullable=True)
    message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)
    # manual (사용자 트리거) | scheduled (Celery Beat 도입 후) — 현재 manual 만 사용
    triggered_by = Column(String(20), nullable=False, default="manual", server_default="manual")
    triggered_by_user = Column(String(100), nullable=True)
    checked_at = Column(
        DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False,
    )

    service = relationship("LakeService", back_populates="checks")

    def __repr__(self):
        return f"<LakeServiceCheck(service_id={self.service_id}, status={self.status})>"
