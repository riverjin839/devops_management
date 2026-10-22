import uuid
from datetime import datetime, date
from sqlalchemy import Column, String, DateTime, Date, Boolean, Integer, Text, ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.database import Base


class TrendSource(Base):
    __tablename__ = "trend_sources"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)           # "kubernetes", "cilium", "linux"
    source_type = Column(String(20), nullable=False)     # "github_release", "rss"
    url = Column(String(500), nullable=False)            # repo slug or feed URL
    category = Column(String(50), nullable=False)        # 자유 입력 — "k8s", "cilium", "istio" …
    # RSS 항목 종류(release|blog|news). NULL 이면 알려진 피드 표(RSS_SOURCE_META) → 'blog' 순으로 정한다
    # (`trend_service.effective_item_type`). github_release 소스는 항상 'release'.
    item_type = Column(String(20), nullable=True)
    # enabled=False = 비활성화(DELETE 기본 동작). 하드 삭제는 admin 만(?hard=true) — 과거 다이제스트 보존.
    enabled = Column(Boolean, default=True)
    # 최근 수집 로그 — UI 에서 왜 수집 안 되는지 바로 보이게
    last_status = Column(String(20), nullable=True)      # "ok", "error", "empty"
    last_message = Column(Text, nullable=True)           # 에러 사유 혹은 "N개 신규 수집"
    last_item_count = Column(Integer, default=0)
    last_collected_at = Column(DateTime, nullable=True)
    # 마지막으로 가져오기에 성공한 시각(ok/empty) — 정기 수집은 이 시각 이후분만 가져온다(증분).
    last_success_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    items = relationship("TrendItem", back_populates="source", cascade="all, delete-orphan")


class TrendItem(Base):
    __tablename__ = "trend_items"
    __table_args__ = (
        # URL 은 전역 unique — 다이제스트는 "그날 새로 발견된 항목"(정책 ④). 빈 URL 은 저장하지 않지만
        # 구버전 행 호환을 위해 부분 인덱스로 둔다.
        Index("uq_trend_items_url", "url", unique=True, postgresql_where=text("url <> ''")),
        Index("ix_trend_items_summary_status", "summary_status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_id = Column(UUID(as_uuid=True), ForeignKey("trend_sources.id"), nullable=False)
    title = Column(String(500), nullable=False)
    url = Column(String(500), nullable=False)
    published_at = Column(DateTime, nullable=False)
    raw_content = Column(Text, nullable=True)
    summary_ko = Column(Text, nullable=True)             # LLM 한국어 요약 — 실패면 NULL
    # 요약 상태: pending(아직) / ok / failed(사유는 summary_error). failed·pending 은 다음 수집 때 재시도,
    # 같은 항목은 summary_attempts 가 3회가 되면 더 시도하지 않는다.
    summary_status = Column(String(20), nullable=False, default="pending", server_default="pending")
    summary_error = Column(Text, nullable=True)
    summary_attempts = Column(Integer, nullable=False, default=0, server_default="0")
    version = Column(String(50), nullable=True)          # releases: "v1.32.0"
    item_type = Column(String(20), nullable=False)       # "release", "blog", "news"
    digest_date = Column(Date, nullable=False)
    collected_at = Column(DateTime, default=datetime.utcnow)

    source = relationship("TrendSource", back_populates="items")


class TrendDigest(Base):
    __tablename__ = "trend_digests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    digest_date = Column(Date, nullable=False, unique=True)
    overall_summary_ko = Column(Text, nullable=True)     # 종합 요약 — 실패면 NULL(사유는 error_message)
    item_count = Column(Integer, default=0)
    # pending / collecting / summarizing / done / partial(일부 소스·요약 실패) / failed
    status = Column(String(20), default="pending")
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
