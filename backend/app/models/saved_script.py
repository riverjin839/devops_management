"""노드 일괄 실행(bulk-exec)에서 재사용하는 사용자별 저장 스크립트.

SSH 로 실행할 bash/python 스크립트를 사용자가 이름 붙여 저장·수정·재사용한다.
실행 자체(bulk_exec.py)는 여전히 상태를 남기지 않는다 — 여기 저장되는 건 스크립트
"본문"뿐이고, 인증 정보(비밀번호/키)는 절대 포함하지 않는다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class SavedScript(Base):
    __tablename__ = "saved_scripts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # username — user 테이블 FK 를 걸지 않는다 (사용자 삭제가 저장된 스크립트를 막지 않게).
    username = Column(String(128), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    language = Column(String(16), nullable=False, default="bash")  # bash | python
    content = Column(Text, nullable=False, default="")
    description = Column(String(500), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
