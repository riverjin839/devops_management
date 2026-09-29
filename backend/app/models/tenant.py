"""테넌트(팀) · 멤버십 · 클러스터 바인딩 — 멀티테넌시 1단계.

PEP 는 역할(admin/operator/viewer)만으로 권한을 나눠 왔고, operator 면 모든 클러스터에
exec/etcdctl/리소스 변경을 할 수 있었다. 이 모델은 "누가 어느 클러스터를 조작할 수 있나"를
표현한다.

규칙 (``services/cluster_access.py`` 가 판정):
- 바인딩이 **하나도 없는** 클러스터는 지금처럼 열려 있다 (기존 설치 호환 — opt-in 격리).
- 바인딩이 하나라도 있는 클러스터는 바인딩된 테넌트의 멤버만 접근할 수 있다.
  ``access='operate'`` 면 실행·변경까지, ``'read'`` 면 조회만(실행 불가).
- admin 은 항상 허용. 전역 role 게이트(``require_operator`` 등)는 그대로 먼저 적용된다 —
  테넌트 멤버십은 권한을 **좁힐** 뿐 넓히지 않는다(viewer 를 operate 테넌트에 넣어도 실행 불가).
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base

CLUSTER_ACCESS_LEVELS = ("read", "operate")


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False, unique=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TenantMember(Base):
    __tablename__ = "tenant_members"
    __table_args__ = (UniqueConstraint("tenant_id", "user_id", name="uq_tenant_members_tenant_user"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ClusterBinding(Base):
    __tablename__ = "cluster_bindings"
    __table_args__ = (UniqueConstraint("tenant_id", "cluster_id", name="uq_cluster_bindings_tenant_cluster"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    # 'read' | 'operate' — CLUSTER_ACCESS_LEVELS
    access = Column(String(16), nullable=False, default="operate", server_default="operate")
    created_at = Column(DateTime, default=datetime.utcnow)
