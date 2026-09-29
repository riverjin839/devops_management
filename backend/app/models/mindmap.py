import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Float, Text, ForeignKey, Boolean
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.database import Base


class MindMap(Base):
    __tablename__ = "mindmaps"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 멀티테넌시 3단계 — NULL = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다 (services/tenant_scope.py).
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=True, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    # Confluence 문서 링크 (선택)
    confluence_url = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    nodes = relationship("MindMapNode", back_populates="mindmap", cascade="all, delete-orphan")


class MindMapNode(Base):
    __tablename__ = "mindmap_nodes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    mindmap_id = Column(UUID(as_uuid=True), ForeignKey("mindmaps.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(UUID(as_uuid=True), nullable=True)   # NULL = root node
    label = Column(String(500), nullable=False)
    note = Column(Text, nullable=True)                       # 부연 설명
    color = Column(String(30), nullable=True)                # hex or tailwind token
    x = Column(Float, nullable=True)                         # canvas position
    y = Column(Float, nullable=True)
    collapsed = Column(Boolean, default=False)
    extra = Column(JSONB, nullable=True)                     # 확장 필드
    sort_order = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    mindmap = relationship("MindMap", back_populates="nodes")
