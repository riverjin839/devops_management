import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Index, String, Text, func

from app.database import Base


class SignupRequest(Base):
    """로그인 화면의 가입 신청 1건 = 1행 — 관리자가 승인하면 ``users`` 에 계정이 만들어진다.

    신청 단계에서 ``users`` 에 비활성 행을 미리 넣지 않는다: users 는 담당자 명부를 겸하고 로그인·권한·
    알림 팬아웃·테넌트 판정이 모두 그 테이블을 보므로, 검증되지 않은 외부 입력이 명부에 섞이지 않게
    별도 테이블에 둔다. 비밀번호는 신청 시점에 bcrypt 해시로만 저장하고(평문 미보관), 승인되면 해시를
    계정으로 옮긴 뒤 이 행에서는 지운다. 거절·만료 행은 로그인 화면에서 본인에게 결과를 알려 주려고
    해시를 보존 기간 동안만 남긴다(``services/signup_service.py`` 의 정리 규칙).

    status: ``pending`` | ``approved`` | ``rejected`` | ``expired`` | ``withdrawn``
    """

    __tablename__ = "signup_requests"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = Column(String(64), nullable=False, index=True)
    display_name = Column(String(128), nullable=False)
    email = Column(String(255), nullable=False)
    department = Column(String(128), nullable=True)
    reason = Column(Text, nullable=True)
    password_hash = Column(String(255), nullable=True)
    status = Column(String(16), nullable=False, default="pending", index=True)

    # 신청 출처 — 관리자가 승인 전에 확인한다(사내망 밖 IP 등).
    request_ip = Column(String(64), nullable=True)
    user_agent = Column(String(255), nullable=True)

    # 결정
    decided_by = Column(String(64), nullable=True)      # 결정한 관리자 username(스냅샷 — FK 없음)
    decided_at = Column(DateTime, nullable=True)
    decision_note = Column(String(500), nullable=True)  # 거절 사유(본인에게 표시) / 승인 메모
    granted_role = Column(String(16), nullable=True)    # 승인 시 부여한 역할
    user_id = Column(String(36), nullable=True)         # 승인으로 만들어진 users.id(계정 삭제 뒤에도 기록 유지 — FK 없음)

    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        # 같은 아이디(대소문자 무시)의 대기 신청은 하나만 — 동시 제출 경쟁도 DB 가 막는다.
        Index(
            "uq_signup_requests_pending_username",
            func.lower(username),
            unique=True,
            postgresql_where=(status == "pending"),
        ),
    )
