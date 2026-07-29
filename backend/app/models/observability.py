"""Observability 모듈 카탈로그 — 관측 스택(kube-prometheus-stack 등)의 개별 지표 정의.

설계 원칙 (CLAUDE.md §UI-First):
 - 지표 목록·PromQL·임계값은 **코드가 아니라 DB 행**이다. 운영자가 화면에서 추가/수정한다.
 - 모듈(`kube-prometheus-stack`, `alert-forwarder`, `opensearch-stack`, `fluent-operator`)을
   늘리는 것도 코드 수정이 아니라 행 추가로 끝난다.
 - 클러스터가 PEP 에서 직접 도달되지 않는 환경(`observability_mode='push'`)을 위해
   in-cluster 수집기가 밀어넣은 결과를 `ObservabilitySnapshot` 에 보관한다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class ObservabilityModule(Base):
    """관측 스택 모듈 1개 (화면의 모듈 탭 1개에 대응)."""

    __tablename__ = "observability_modules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(String(64), nullable=False, unique=True, index=True)
    label = Column(String(100), nullable=False)
    description = Column(String(500), nullable=True)
    icon = Column(String(64), nullable=True)              # lucide 아이콘 이름
    # active  = 지표가 정의돼 있어 화면에서 조회 가능
    # planned = 탭은 보이지만 아직 지표 미정의 (준비중 표시)
    status = Column(String(16), nullable=False, default="planned")
    enabled = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<ObservabilityModule(key={self.key}, status={self.status})>"


class ObservabilityMetric(Base):
    """모듈에 속한 개별 지표 1행 (dense 테이블의 한 줄)."""

    __tablename__ = "observability_metrics"
    # 두 인덱스 모두 module_key 가 선행 컬럼이라 컬럼 단독 index=True 는 두지 않는다.
    # (뒀다면 SQLAlchemy 자동 이름 `ix_observability_metrics_module_key` 가 아래 unique
    #  인덱스명과 충돌해 create_all 이 DuplicateTable 로 실패한다 — 이름을 uq_ 로 구분.)
    __table_args__ = (
        Index("ix_observability_metrics_module_sort", "module_key", "sort_order"),
        Index("uq_observability_metrics_module_key", "module_key", "key", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module_key = Column(String(64), nullable=False)
    key = Column(String(100), nullable=False)             # 모듈 내 고유 슬러그
    label = Column(String(150), nullable=False)
    # prometheus | alertmanager | exporter | operator | rules | …  (자유 문자열)
    category = Column(String(50), nullable=False, default="general")
    promql = Column(Text, nullable=False)
    unit = Column(String(20), nullable=False, default="")
    # value | bytes | duration | ratio | bool
    display_type = Column(String(20), nullable=False, default="value")
    thresholds = Column(String(100), nullable=True)       # "warning:70,critical:90"
    # True 면 값이 **낮을수록** 나쁨 (예: up == 0 이 장애)
    invert = Column(Boolean, nullable=False, default=False)
    help = Column(Text, nullable=True)                    # 운영자용 설명 (UI-First: 화면에 노출)
    doc_url = Column(String(1024), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:
        return f"<ObservabilityMetric(module={self.module_key}, key={self.key})>"


class ObservabilitySnapshot(Base):
    """push 모드 클러스터의 수집 결과.

    PEP 가 클러스터의 Prometheus/Alertmanager 에 직접 도달할 수 없을 때, in-cluster 수집기가
    주기적으로 긁어서 `POST /observability/snapshot/ingest` 로 밀어넣는다. 조회 API 는
    클러스터의 `observability_mode` 를 보고 live 대신 이 테이블의 최신 행을 읽는다.
    """

    __tablename__ = "observability_snapshots"
    __table_args__ = (
        Index(
            "ix_obs_snapshots_lookup",
            "cluster_id", "module_key", "kind", "collected_at",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    module_key = Column(String(64), nullable=False, default="kube-prometheus-stack")
    # metrics | rules | targets | alerts | status
    kind = Column(String(20), nullable=False)
    payload = Column(JSONB, nullable=True)
    collected_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    received_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())

    def __repr__(self) -> str:
        return f"<ObservabilitySnapshot(cluster={self.cluster_id}, kind={self.kind})>"
