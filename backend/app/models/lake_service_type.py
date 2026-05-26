"""LakeServiceType — DB-driven LAKE 서비스 type 카탈로그.

설계:
 - builtin 8개 (airflow/spark/iceberg/trino/starrocks/jupyterlab/superset/polaris) 는
   부팅 시 자동 seed (is_builtin=true). 삭제 불가, enable/disable 만 가능.
 - custom type 은 운영자가 Settings 에서 추가 (is_builtin=false). 자유 add/edit/delete.
 - 같은 service_type slug 중복 X (unique constraint).

Probe 매핑:
 - builtin: services/lake_checkers/LAKE_CHECKER_REGISTRY 의 클래스
 - custom : GenericHealthzChecker (default_path 동적)
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, DateTime, Integer, Boolean, Index, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class LakeServiceType(Base):
    """LAKE 서비스 type 카탈로그 row. 운영자가 Settings UI 에서 관리."""
    __tablename__ = "lake_service_types"
    __table_args__ = (
        UniqueConstraint("service_type", name="uq_lake_service_types_slug"),
        Index("ix_lake_types_enabled", "enabled"),
        Index("ix_lake_types_sort", "sort_order"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # slug — 영문 소문자 + 숫자 + 하이픈 (예: airflow, my-custom-svc)
    service_type = Column(String(32), nullable=False)
    label = Column(String(100), nullable=False)
    # catalog | runtime | analytics | other (자유 string 이지만 frontend 가 4종 권장)
    category = Column(String(20), nullable=False, default="other", server_default="other")
    default_path = Column(String(255), nullable=False, default="/health", server_default="/health")
    description = Column(Text, nullable=True)
    # lucide-react 컴포넌트 이름 (예: "Database", "Workflow"). null 이면 frontend fallback.
    icon = Column(String(64), nullable=True)
    # builtin (코드에서 seed) — UI 에서 영구 삭제 불가, label/category/default_path 도 readonly
    is_builtin = Column(Boolean, nullable=False, default=False, server_default="false")
    # disable 시 LakeServicesPage 등록 모달 select 에서 제외 (기존 인스턴스 영향 X)
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    # UI 정렬 순서 (작을수록 위)
    sort_order = Column(Integer, nullable=False, default=100, server_default="100")

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
        server_default=func.now(), nullable=False,
    )

    def __repr__(self):
        return f"<LakeServiceType(slug={self.service_type}, builtin={self.is_builtin}, enabled={self.enabled})>"
