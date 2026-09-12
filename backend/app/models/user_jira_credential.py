"""사용자별 Jira 자격증명 — 암호화 저장.

폐쇄망 Jira 는 사용자별 자격증명으로 인증한다. 각 사용자가 본인 자격을 1회 등록하면 본인 권한으로
이슈를 조회/반영한다. 자격은 평문 저장하지 않고 `app.services.secret_box` (SECRET_KEY 기반
Fernet) 로 암호화해 `token_encrypted` 에 보관한다 (batch_job 자격증명 선례와 동일 정책).

**인증 방식 2가지** (`auth_type`):
 - `pat`  — Personal Access Token → `Authorization: Bearer <token>` (DC 8.14+).
 - `cookie` — PAT 발급이 불가한 SSO 환경 대비. 사용자가 사내 브라우저로 Jira 에 로그인한 뒤
   DevTools 에서 세션 쿠키(예: `JSESSIONID=...; seraph.rememberme.cookie=...`) 를 통째로 복사해
   등록하면 `Cookie` 헤더로 REST API 를 호출한다. 세션 만료 시 재등록 필요.

두 방식 모두 비밀값은 `token_encrypted` 에 암호화 저장한다(컬럼 재사용). `auth_type` 로 구분한다.

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
    token_encrypted = Column(Text, nullable=False)        # secret_box.encrypt(PAT 또는 세션 쿠키)
    # 인증 방식: 'pat'(Bearer) | 'cookie'(세션 쿠키 재사용). 구버전 DB 는 PAT 만 썼으므로 기본 'pat'.
    auth_type = Column(String(16), nullable=False, default="pat", server_default="pat")
    # 선택 — Jira 상 displayName (화면 표시용, 사람이 읽기 좋은 이름 우선).
    jira_account = Column(String(150), nullable=True)
    # 선택 — Jira 원본 로그인 계정(username/key). displayName 과 달리 Jira 이슈 생성 시
    # assignee 필드(`{"name": ...}`)에 그대로 쓸 수 있는 값이라 별도 컬럼으로 둔다 —
    # jira_account 는 표시 우선이라 표시명이 있으면 계정명을 덮어써 assignee 매핑에 못 쓴다.
    jira_username = Column(String(150), nullable=True)
    last_verified_at = Column(DateTime, nullable=True)    # 마지막 연결 테스트 성공 시각
    # (선택, 옵트인) 파드 내 SSO 폼 자동 로그인용 로그인 정보 — secret_box.encrypt(JSON
    # {"username","password"}). 세션 만료 시 원클릭 재로그인에 쓰인다. 사용자가 "로그인
    # 정보 저장"을 체크했을 때만 채워지며 API 응답으로는 존재 여부(has_sso_login)만 노출.
    sso_login_encrypted = Column(Text, nullable=True)
    # (선택) 같은 IdP 로 SSO 연동되는 Confluence 세션 쿠키 — 파드 내 SSO 폼 로그인이 Jira 와
    # 함께 캡처해 저장한다(관리자가 Confluence Base URL 을 설정한 경우만). secret_box 암호화.
    confluence_cookie_encrypted = Column(Text, nullable=True)
    # (선택) 내부 ServiceNow ITSM 세션 쿠키 — 1차 구현은 전용 인증 UI 없이, 사내 SSO 로
    # Jira/Confluence 와 같은 도메인을 공유한다고 가정해 Jira 쿠키를 그대로 재사용 시도한 뒤
    # 성공하면 여기로 승격 저장한다(confluence_cookie_encrypted 와 동일한 폴백·승격 전략).
    # 전용 ServiceNow 자격증명(Basic/OAuth 등)은 추후 개선 범위.
    servicenow_cookie_encrypted = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<UserJiraCredential(username={self.username})>"
