import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB

from app.database import Base


class TopologyAuditLog(Base):
    __tablename__ = "topology_audit_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(20), nullable=False)  # node|port|link
    entity_id = Column(String(100), nullable=True)
    action = Column(String(30), nullable=False)  # create|update|delete|sync|force_fix
    # 전체 스코프 문자열("infra_topology.force_fix" = 24자)을 그대로 기록한다 — 예전 String(20) 은 노드 삭제
    # 감사 로그 INSERT 가 항상 StringDataRightTruncation 으로 실패해 삭제가 500 이었다.
    scope = Column(String(40), nullable=False)
    status = Column(String(20), nullable=False, default="success")  # success|partial|failed
    reason = Column(Text, nullable=True)
    before_data = Column(JSONB, nullable=True)
    after_data = Column(JSONB, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
