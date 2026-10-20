from datetime import datetime
from pydantic import BaseModel, Field


ROLE_PATTERN = r"^(admin|operator|viewer)$"


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    id: str
    # 로그인 없는 순수 담당자 명부 행(사번 미보유)은 username 이 없다 — users 테이블이
    # 담당자 명부를 겸하므로 GET /auth/users 목록에 그런 행도 함께 나올 수 있다.
    username: str | None = None
    role: str
    display_name: str | None = None
    is_active: bool
    must_change_password: bool = False
    editor_white_bg: bool = False
    created_at: datetime
    # 로그인 방식 — 'local'(PEP 비밀번호) | 'ldap'(마지막 로그인이 사내 디렉터리) | 'external'(로컬
    # 비밀번호 없는 SSO 계정). /auth/login·/auth/me·/auth/refresh 만 채우고 목록 응답 등은 None.
    # 'local' 이 아니면 본인 비밀번호 변경이 막힌다(사내 디렉터리·IdP 에서 변경).
    auth_source: str | None = None

    class Config:
        from_attributes = True


class PasswordChangeResponse(UserOut):
    """본인 비밀번호 변경 응답 — 기존 토큰이 무효가 되므로 새로 발급한 토큰을 함께 싣는다."""

    access_token: str | None = None
    token_type: str = "bearer"


class UpdatePreferencesRequest(BaseModel):
    editor_white_bg: bool


class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=4, max_length=128)
    role: str = Field("viewer", pattern=ROLE_PATTERN)
    display_name: str | None = Field(None, max_length=128)


class UpdateUserRoleRequest(BaseModel):
    role: str = Field(..., pattern=ROLE_PATTERN)


class UpdatePasswordRequest(BaseModel):
    """Admin-driven password reset (force re-change on next login)."""

    new_password: str = Field(..., min_length=4, max_length=128)


class SelfPasswordChangeRequest(BaseModel):
    """Self-service password change. Requires the current password."""

    current_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=4, max_length=128)


TokenResponse.model_rebuild()
