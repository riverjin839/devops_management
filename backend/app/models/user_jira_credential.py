"""사용자별 Jira 자격증명 (Personal Access Token) — 암호화 저장.

폐쇄망 Jira 는 사용자별 PAT 로 인증한다. 각 사용자가 본인 토큰을 1회 등록하면 본인 권한으로
이슈를 조회/반영한다. 토큰은 평문 저장하지 않고 `app.services.secret_box` (SECRET_KEY 기반
Fernet) 로 암호화해 `token_encrypted` 에 보관한다 (batch_job 자격증명 선례와 동일 정책).

Jira **Base URL** 은 조직 공통이라 여기 저장하지 않고 AppSetting(key=`jira_integration`) 에 둔다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, String, Text

from app.database import Base


class UserJiraCredential(Base):
    __tablename__ = "user_jira_credentials"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # User.username (사번/계정) 참조 — 로그인 사용자 1인당 1행.
    username = Column(String(64), nullable=False, unique=True, index=True)
    token_encrypted = Column(Text, nullable=False)        # secret_box.encrypt(PAT)
    # 선택 — Jira 상 displayName/name (assignee 이름 매핑 보조용).
    jira_account = Column(String(150), nullable=True)
    last_verified_at = Column(DateTime, nullable=True)    # 마지막 연결 테스트 성공 시각

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<UserJiraCredential(username={self.username})>"
