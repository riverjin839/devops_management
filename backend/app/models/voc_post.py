import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime
from app.database import Base


class VocPost(Base):
    """사용자 VOC(Voice of Customer) 게시판 글.

    사용자가 문의/개선/불만/제안을 남기고 관리자가 답변·상태를 관리한다. 전체 공개 board 로,
    수정/삭제는 작성자 본인(`created_by`)과 관리자만 가능하다(라우터에서 검사).
    """
    __tablename__ = "voc_posts"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=True)
    category = Column(String(20), nullable=False, default="문의")   # 문의 / 개선 / 불만 / 제안
    status = Column(String(20), nullable=False, default="접수")     # 접수 / 검토중 / 완료

    author = Column(String(100), nullable=True)         # 표시명(display_name)
    created_by = Column(String(100), nullable=True)     # 소유권 판정용 username

    admin_reply = Column(Text, nullable=True)
    admin_reply_by = Column(String(100), nullable=True)
    admin_reply_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<VocPost(category={self.category}, title={self.title})>"
