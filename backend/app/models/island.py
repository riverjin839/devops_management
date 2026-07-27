import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB

from app.database import Base


class Island(Base):
    """Your Island — 사용자가 자주 쓰는 PEP 화면을 모아둔 개인 커스텀 화면.

    패널(`panels`)은 기존 라우트 경로를 가리키고, 프론트가 해당 페이지 컴포넌트를
    그대로 임베드해서 렌더한다. `user_settings` 의 JSONB blob 이 아니라 전용 테이블인
    이유는 공유(`is_shared`) 시 다른 사용자가 목록에서 찾을 수 있어야 하기 때문이다.
    """

    __tablename__ = "islands"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # 소유자는 User.id 로 고정(불변). owner_name 은 공유 목록 표기용 스냅샷이라 write 마다 갱신.
    owner_id = Column(String(36), nullable=False, index=True)
    owner_name = Column(String(100), nullable=True)
    name = Column(String(100), nullable=False)
    icon = Column(String(50), nullable=True)          # lucide 아이콘명 (resolveClusterIcon 호환)
    description = Column(Text, nullable=True)
    layout_mode = Column(String(16), nullable=False, default="tabs")  # tabs | sidebar
    # [{"key": "p1", "path": "/ops-checks", "label": null, "icon": null}, ...]
    panels = Column(JSONB, nullable=False, default=list)
    is_shared = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<Island(name={self.name}, owner_id={self.owner_id})>"
