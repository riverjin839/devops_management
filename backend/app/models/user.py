import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, Boolean

from app.database import Base


class User(Base):
    """시스템 담당자 명부 겸 로그인 계정 — 단일 테이블.

    이전에는 담당자 명부(사번/이메일/좌석 등)가 ``app_settings`` 의 JSON blob 이고,
    로그인 계정(이 테이블)은 사번이 있는 담당자에 대해 단방향·생성전용으로만
    provisioning 됐다 — 명부를 고쳐도 이미 만들어진 계정에는 반영되지 않고, 계정
    쪽에서 역할을 바꿔도 명부에는 보이지 않는 두 개의 분리된 신원 저장소였다.
    지금은 이 테이블 자체가 명부다: 담당자 필드와 로그인 필드가 한 행에 함께 있고,
    사번(``employee_id``)이 있는 행만 로그인 가능(``username``/``hashed_password`` 보유).
    """

    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # 로그인 계정이 없는 순수 담당자 행(사번 미보유)은 username/hashed_password 가 NULL.
    username = Column(String(64), nullable=True, unique=True, index=True)
    hashed_password = Column(String(255), nullable=True)
    # 'admin' | 'operator' | 'viewer'. 레거시 데이터의 'user' 값은 마이그레이션에서 'viewer' 로 변환된다.
    # 로그인 계정이 없는 행에서는 의미 없음(로그인 자체가 불가하므로 권한 체크 경로를 타지 않음).
    role = Column(String(16), nullable=False, default="viewer")
    # 담당자 이름 — 로그인 계정이 있든 없든 이 필드가 표시 이름/업무 담당자 식별 키다.
    display_name = Column(String(128), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    must_change_password = Column(Boolean, nullable=False, default=False)
    editor_white_bg = Column(Boolean, nullable=True, default=False)

    # ── 담당자 명부 필드 (구 app_settings.assignees JSON) ──────────────────────
    employee_id = Column(String(64), nullable=True, unique=True, index=True)  # 사번
    email = Column(String(255), nullable=True)
    ip = Column(String(64), nullable=True)
    seat_location = Column(String(64), nullable=True)
    primary_role = Column(String(64), nullable=True)    # 정 담당역할 (업무 직무, auth role 과 무관)
    secondary_role = Column(String(64), nullable=True)  # 부담당 역할

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
