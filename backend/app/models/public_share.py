"""로그인 없는 공개 화면(일일 리포트·외부 서비스)의 공유 링크 — 만료 기한이 있는 접근 토큰.

화면별 공개 방식이 `link`(공유 링크만)이면 공개 API 가 `?t=<토큰>` 을 요구한다. 토큰 원문은
발급 응답에서 한 번만 보여주고 DB 에는 SHA-256 해시만 저장한다. 판정은 `services/public_pages.py`.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class PublicShareLink(Base):
    __tablename__ = "public_share_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    label = Column(String(200), nullable=False)
    page = Column(String(32), nullable=False, default="all")   # all | daily_report | external_services
    cluster_ids = Column(JSONB, nullable=True)                 # 비어 있으면 그 화면의 공개 클러스터 전체
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    token_prefix = Column(String(8), nullable=False)           # 목록에서 링크를 구분하는 앞 8자
    expires_at = Column(DateTime, nullable=False)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    revoked_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    use_count = Column(Integer, nullable=False, default=0)
