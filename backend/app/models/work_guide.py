import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import deferred
from pgvector.sqlalchemy import Vector
from app.config import settings
from app.database import Base


class WorkGuide(Base):
    __tablename__ = "work_guides"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parent_id = Column(UUID(as_uuid=True), nullable=True)  # 상위 페이지 (계층 구조)
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=True)
    category = Column(String(50), nullable=True)   # 배포, 트러블슈팅, 모니터링, 보안, 기타
    priority = Column(String(20), default='medium')  # high / medium / low
    tags = Column(String(500), nullable=True)        # 쉼표 구분
    status = Column(String(20), default='draft')     # draft / active / archived
    author = Column(String(100), nullable=True)
    sort_order = Column(Integer, default=0)          # 동일 레벨 내 정렬 순서
    confluence_url = Column(Text, nullable=True)     # Confluence 문서 링크
    # 유사 문서 검색용 임베딩(제목+본문) — Celery 비동기로 계산·저장 (동기 쓰기 경로에 없음).
    # deferred() — 기본 SELECT 에 포함되지 않도록 지연 로딩 (work_item.py 의 동일 컬럼 참고).
    embedding = deferred(Column(Vector(settings.embedding_dim), nullable=True))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<WorkGuide(title={self.title})>"
