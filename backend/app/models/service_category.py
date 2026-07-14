"""ServiceCategory — PEP/APP 서비스 카탈로그의 "상위 카테고리" (Runtime/Catalog/Workflow/
JupyterLab 등). LakeServiceType 이 이 카테고리에 속해 좌측 사이드바(PEP 서비스/APP 서비스)의
2단 네비게이션(카테고리 → 하위 서비스)을 구성한다.

설계:
 - domain: 'pep' | 'app' — 최상위 사이드바 아이콘(PEP 서비스/APP 서비스) 구분.
 - pep 도메인은 부팅 시 builtin 4개(Runtime/Catalog/Workflow/JupyterLab) 자동 seed.
 - app 도메인은 seed 없음 — 운영자가 Settings 에서 직접 추가.
 - builtin 은 영구 삭제 불가 (label/icon/sort_order 는 편집 가능), custom 은 자유 추가/삭제.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, DateTime, Integer, Boolean, Index, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class ServiceCategory(Base):
    """PEP/APP 서비스 카탈로그 상위 카테고리. 운영자가 Settings UI 에서 관리."""
    __tablename__ = "service_categories"
    __table_args__ = (
        UniqueConstraint("domain", "key", name="uq_service_categories_domain_key"),
        Index("ix_service_categories_domain", "domain"),
        Index("ix_service_categories_sort", "domain", "sort_order"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # pep | app — 좌측 사이드바 아이콘("PEP 서비스"/"APP 서비스") 구분
    domain = Column(String(10), nullable=False, default="pep", server_default="pep")
    # slug — 영문 소문자 + 숫자 + 하이픈 (예: runtime, catalog)
    key = Column(String(50), nullable=False)
    label = Column(String(100), nullable=False)
    # lucide-react 컴포넌트 이름 (예: "Cpu", "Database"). null 이면 frontend fallback.
    icon = Column(String(64), nullable=True)
    # builtin (코드에서 seed, domain=pep 4개) — UI 에서 영구 삭제 불가, key/domain readonly
    is_builtin = Column(Boolean, nullable=False, default=False, server_default="false")
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    # UI 정렬 순서 (작을수록 위)
    sort_order = Column(Integer, nullable=False, default=100, server_default="100")

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
        server_default=func.now(), nullable=False,
    )

    def __repr__(self):
        return f"<ServiceCategory(domain={self.domain}, key={self.key}, builtin={self.is_builtin})>"
