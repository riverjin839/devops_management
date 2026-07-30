"""LLM API 키 저장소 — 사내 LLM 서비스(OpenAI-호환) 인증용.

키 원문은 AppSetting JSONB(``llm_settings``)에 절대 넣지 않는다 (CLAUDE.md
자격증명 규칙). 프로필은 ``api_key_ref = "credential:<name>"`` 로 이 테이블을
참조하고, 값은 ``EncryptedText`` 로 투명 암호화된다 (user_jira_credentials 와
동일 패턴). export 시 backup_service.SENSITIVE_COLUMNS 로 기본 마스킹된다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, String
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base
from app.models._crypto_types import EncryptedText


class LlmCredential(Base):
    __tablename__ = "llm_credentials"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(64), nullable=False, unique=True, index=True)
    api_key = Column(EncryptedText, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
