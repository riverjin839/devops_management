"""Service Architecture Doc — 서비스 모듈(LakeService)별 아키텍처/플로우 다이어그램 문서.

`/service-architecture` 페이지의 영속 문서. 자동 발견 그래프(collect_topology 스냅샷)와
LLM 생성 콘텐츠, 사용자 수동 편집(노드/엣지/배치/주석)을 한 문서로 관리하며 주기적으로
현행화(sync)된다.

설계 메모:
 - auto_graph 는 sync 마다 통째로 교체되는 스냅샷 → JSONB. 사라진 노드는 삭제 대신
   `stale: true` 마킹(ghost 렌더) — 수동 엣지/주석/배치가 참조할 수 있어서다.
 - 수동 노드/엣지는 개별 CRUD + 감사가 필요해 관계형 행으로 분리
   (ServiceTopologyLink 의 문자열 identity anchoring 패턴 준수 — 양끝은 auto/manual
   node_id 문자열이며 대상이 사라지면 ghost 로 표시).
 - layout/annotations 는 auto 노드에도 붙어야 하므로(행이 없음) 문서 JSONB 맵으로 저장.
 - 셋 다 신규 테이블이라 `create_all` 로 생성되며 `_safe_*` ALTER 가 필요 없다.
 - 백업 서비스는 일반 per-table fault tolerance 로 충분(LOG/SENSITIVE 등록 불요).
 - 현행화 감사는 기존 TopologyAuditLog(entity_type="arch_doc") 를 재사용한다.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, DateTime, Boolean, Float, ForeignKey, Index,
    UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.database import Base


class ServiceArchDoc(Base):
    """서비스 모듈당 1개의 아키텍처 문서. lake_service_id unique."""

    __tablename__ = "service_arch_docs"
    __table_args__ = (
        UniqueConstraint("lake_service_id", name="uq_arch_doc_service"),
        Index("ix_service_arch_docs_cluster", "cluster_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lake_service_id = Column(
        UUID(as_uuid=True), ForeignKey("lake_services.id", ondelete="CASCADE"), nullable=False
    )
    # 목록 조회/감사 FK 용 denormalize (LakeService.cluster_id 스냅샷)
    cluster_id = Column(
        UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False
    )
    # 탐색 스코프 (문서 생성 시점의 LakeService.namespace 스냅샷)
    namespace = Column(String(100), nullable=False)

    # {"nodes": [{id,kind,name,namespace,status,detail?,stale?,stale_since?}],
    #  "edges": [{id,source,target,type,label}], "warnings": [...], "truncated": bool}
    auto_graph = Column(JSONB, nullable=True)
    # [{source,target,flow_count,dropped_count,protocols,ports}] — build_traffic best-effort
    traffic_edges = Column(JSONB, nullable=True)
    # {"summary": str, "components": [{node_id,role}],
    #  "flow_steps": [{order,source,target,description}],
    #  "model": str, "generated_at": iso, "raw_fallback": bool}
    llm_content = Column(JSONB, nullable=True)
    # 뷰별 노드 배치: {"architecture": {node_id: {"x": f, "y": f}}, "flow": {...}}
    layout = Column(JSONB, nullable=False, default=dict, server_default="{}")
    # 노드별 사용자 메모: {node_id: str} + 문서 메모 {"__doc__": str}
    # ("__doc__" — axios 키 변환 제외(LITERAL_KEY_RE) 되는 dunder 센티널)
    annotations = Column(JSONB, nullable=False, default=dict, server_default="{}")
    # 사용자가 수정한 요약 — llm_content.summary 보다 우선 표시
    summary_override = Column(Text, nullable=True)

    # 구조 해시(노드 id/kind + 엣지 src/tgt/type) — status 플래핑은 무시
    source_hash = Column(String(64), nullable=True)
    # 직전 sync 의 diff: {"added": [ids], "removed": [ids], "changed": [ids],
    #                     "detected_at": iso} / null = 변경 없음
    drift = Column(JSONB, nullable=True)
    last_synced_at = Column(DateTime, nullable=True)
    # pending | ok | partial | failed
    last_sync_status = Column(String(20), nullable=False, default="pending", server_default="pending")
    sync_error = Column(Text, nullable=True)
    auto_sync_enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    # none | pending | ok | offline | failed
    llm_status = Column(String(20), nullable=False, default="none", server_default="none")

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
        server_default=func.now(), nullable=False,
    )

    service = relationship("LakeService")
    manual_nodes = relationship(
        "ServiceArchManualNode", back_populates="doc", cascade="all, delete-orphan"
    )
    manual_edges = relationship(
        "ServiceArchManualEdge", back_populates="doc", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ServiceArchDoc(service={self.lake_service_id}, sync={self.last_sync_status})>"


class ServiceArchManualNode(Base):
    """사용자가 수동으로 추가한 노드(외부 DB/API/큐/사용자 등)."""

    __tablename__ = "service_arch_manual_nodes"
    __table_args__ = (
        UniqueConstraint("doc_id", "node_id", name="uq_arch_manual_node"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id = Column(
        UUID(as_uuid=True), ForeignKey("service_arch_docs.id", ondelete="CASCADE"), nullable=False
    )
    # 그래프 identity: "manual:{uuid4hex}" — 서버가 생성
    node_id = Column(String(255), nullable=False)
    label = Column(String(200), nullable=False)
    # external | database | queue | api | user | custom
    kind = Column(String(30), nullable=False, default="external")
    description = Column(Text, nullable=True)
    # {color?, icon?, shape?}
    style = Column(JSONB, nullable=True)
    created_by = Column(String(100), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
        server_default=func.now(), nullable=False,
    )

    doc = relationship("ServiceArchDoc", back_populates="manual_nodes")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ServiceArchManualNode({self.kind}/{self.label})>"


class ServiceArchManualEdge(Base):
    """사용자가 수동으로 그린 엣지. 양끝은 auto/manual node_id 문자열 anchoring
    (대상이 사라지면 ghost 렌더 — ServiceTopologyLink 패턴)."""

    __tablename__ = "service_arch_manual_edges"
    __table_args__ = (
        Index("ix_arch_manual_edges_doc", "doc_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id = Column(
        UUID(as_uuid=True), ForeignKey("service_arch_docs.id", ondelete="CASCADE"), nullable=False
    )
    source_id = Column(String(255), nullable=False)
    target_id = Column(String(255), nullable=False)
    # flow | depends | calls | custom
    edge_type = Column(String(30), nullable=False, default="flow")
    label = Column(String(200), nullable=True)
    description = Column(Text, nullable=True)
    # architecture | flow | both — 어떤 뷰에 표시할지
    view = Column(String(20), nullable=False, default="both", server_default="both")
    # 플로우 뷰 수동 순서
    sort_order = Column(Float, nullable=False, default=0.0, server_default="0")
    created_by = Column(String(100), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
        server_default=func.now(), nullable=False,
    )

    doc = relationship("ServiceArchDoc", back_populates="manual_edges")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ServiceArchManualEdge({self.source_id} -{self.edge_type}-> {self.target_id})>"
