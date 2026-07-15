import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, DateTime, Boolean
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

    def __repr__(self):
        return f"<OpsNote(service={self.service}, title={self.title})>"
