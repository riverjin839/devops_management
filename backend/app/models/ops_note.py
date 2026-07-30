import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Boolean
from sqlalchemy.orm import deferred
from pgvector.sqlalchemy import Vector

from app.config import settings
from app.database import Base


class OpsNote(Base):
    """업무 게시판 포스트잇 메모"""
    __tablename__ = "ops_notes"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    service = Column(String(50), nullable=False)       # keycloak / k8s / cilium / jenkins / argocd / nexus / etc
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=True)              # 앞면 내용 (포스트잇 앞)
    back_content = Column(Text, nullable=True)         # 뒷면 내용 (포스트잇 뒤)
    color = Column(String(20), nullable=False, default="yellow")  # yellow / green / blue / pink / purple
    author = Column(String(100), nullable=True)
    pinned = Column(Boolean, nullable=False, default=False)
    confluence_url = Column(Text, nullable=True)       # Confluence 문서 링크
    dl_url = Column(Text, nullable=True)               # DL(Data Lake 등) 참고 링크
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # RAG(근거 인용) 검색용 임베딩(제목+앞뒤면) — work_items/work_guides 와 동일 모델/차원.
    # deferred: 목록 조회 시 벡터를 로드하지 않는다.
    embedding = deferred(Column(Vector(settings.embedding_dim), nullable=True))

    def __repr__(self):
        return f"<OpsNote(service={self.service}, title={self.title})>"
