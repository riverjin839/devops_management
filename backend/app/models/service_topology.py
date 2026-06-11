"""Service Topology — 수동 연계 링크 + 외부 노드.

서비스 토폴로지 메뉴(`/service-topology`)에서 자동 발견된 K8s 그래프 위에
운영자가 직접 그리는 **수동 엣지**와, 그래프 밖의 **외부 시스템 노드**(외부 DB/API/큐 등)를
저장한다.

설계 메모:
 - 온톨로지(OntologyEntity/Relationship)는 entity UUID 행이 필요해 ephemeral 한 K8s
   오브젝트에 부적합하다 → 여기서는 **문자열 identity anchoring**(kind/name) 으로 노드를 가리킨다.
   그래프 빌더가 매 조회마다 `"{kind}/{namespace}/{name}"` 안정 ID 를 만들고, 수동 링크는
   그 양끝을 (kind, name) 으로 참조한다. 대상이 사라지면 그래프 빌더가 ghost 노드로 표시.
 - 둘 다 신규 테이블이라 `create_all` 로 생성되며 `_safe_*` ALTER 가 필요 없다.
 - 백업 서비스는 일반 per-table fault tolerance 로 충분(LOG/SENSITIVE 등록 불요).
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class ServiceTopologyLink(Base):
    """운영자가 수동으로 그린 노드 간 연계(의존/호출/읽기/쓰기/커스텀)."""

    __tablename__ = "service_topology_links"
    __table_args__ = (
        Index("ix_sto_links_cluster_ns", "cluster_id", "namespace"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    namespace = Column(String(253), nullable=False, default="default")

    # 양끝 노드를 (kind, name) 문자열로 anchoring. external 노드는 kind="External".
    source_kind = Column(String(64), nullable=False)
    source_name = Column(String(253), nullable=False)
    target_kind = Column(String(64), nullable=False)
    target_name = Column(String(253), nullable=False)

    # depends_on | calls | reads | writes | custom
    link_type = Column(String(32), nullable=False, default="depends_on")
    label = Column(String(255), nullable=True)
    note = Column(Text, nullable=True)
    created_by = Column(String(64), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ServiceTopologyLink({self.source_kind}/{self.source_name} "
            f"-{self.link_type}-> {self.target_kind}/{self.target_name})>"
        )


class ServiceTopologyExternalNode(Base):
    """그래프 밖의 외부 시스템 노드(외부 DB/API/큐 등)."""

    __tablename__ = "service_topology_external_nodes"
    __table_args__ = (
        Index("ix_sto_ext_cluster_ns", "cluster_id", "namespace"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    namespace = Column(String(253), nullable=False, default="default")

    name = Column(String(253), nullable=False)
    # database | api | queue | other
    node_type = Column(String(32), nullable=False, default="other")
    note = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ServiceTopologyExternalNode({self.node_type}/{self.name})>"
