"""Authentication endpoints — /auth/login, /auth/refresh, /auth/me, admin user management."""
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.user_setting import UserSetting
from app.auth.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    session_max_seconds,
    token_auth_time,
    utcnow_naive,
    verify_password,
)
from app.auth.deps import get_current_user, oauth2_scheme, require_admin
from app.schemas.auth import (
    LoginRequest,
    TokenResponse,
    UserOut,
    CreateUserRequest,
    UpdatePasswordRequest,
    UpdatePreferencesRequest,
    UpdateUserRoleRequest,
    SelfPasswordChangeRequest,
    PasswordChangeResponse,
)
from app.services import audit_logger
from app.services import login_rate_limiter


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    ip = login_rate_limiter.client_ip(request)
    allowed, reason = login_rate_limiter.check_login_allowed(ip, payload.username)
    if not allowed:
        audit_logger.record(
            db,
            action="login.failure",
            actor=None,
            actor_username=payload.username,
            status="failure",
            target_type="user",
            target_id=None,
            details={"reason": "rate_limited"},
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=reason)

    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not user.is_active or not verify_password(payload.password, user.hashed_password):
        login_rate_limiter.record_failure(ip, payload.username)
        audit_logger.record(
            db,
            action="login.failure",
            actor=user if user else None,
            actor_username=payload.username,
            status="failure",
            target_type="user",
            target_id=user.id if user else None,
            details={"reason": "invalid_credentials" if user else "unknown_user"},
            request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="잘못된 사용자명 또는 비밀번호입니다.",
        )
    login_rate_limiter.record_success(ip, payload.username)
    token = create_access_token(subject=user.username, role=user.role)
    audit_logger.record(
        db,
        action="login.success",
        actor=user,
        status="success",
        target_type="user",
        target_id=user.id,
        request=request,
    )
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(
    token: str = Depends(oauth2_scheme),
    user: User = Depends(get_current_user),
):
    """유효한(만료 전) 토큰을 새 토큰으로 재발급한다 — 슬라이딩 세션.

    auth 라우터는 public 마운트라 인증을 엔드포인트 의존성(``get_current_user``)으로 직접 건다
    — 만료·서명 오류·비활성 사용자·비밀번호 변경 이전 토큰은 거기서 401 이다. 재발급 토큰은
    원래 로그인 시각(``auth_time``)을 유지하고 만료를 ``min(지금 + TTL, auth_time + 상한)`` 으로
    잡으므로, 로그인 후 ``SESSION_MAX_HOURS`` 가 지나면 더는 늘지 않고 401 로 재로그인을 요구한다.
    role 은 DB 의 현재 값으로 다시 싣는다. 몇 시간마다 반복되는 호출이라 감사 로그는 남기지 않는다.
    """
    payload = decode_access_token(token) or {}
    now = int(time.time())
    auth_time = token_auth_time(payload, now=now)
    if auth_time is None or now >= auth_time + session_max_seconds():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="세션 최대 유지 시간이 지났습니다. 다시 로그인하세요.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    new_token = create_access_token(subject=user.username, role=user.role, auth_time=auth_time)
    return TokenResponse(access_token=new_token, user=UserOut.model_validate(user))


@router.post("/me/password", response_model=PasswordChangeResponse)
def change_my_password(
    payload: SelfPasswordChangeRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not verify_password(payload.current_password, user.hashed_password):
        audit_logger.record(
            db,
            action="user.password.change",
            actor=user,
            status="failure",
            target_type="user",
            target_id=user.id,
            details={"reason": "wrong_current_password"},
            request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="현재 비밀번호가 일치하지 않습니다.",
        )
    if payload.current_password == payload.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="새 비밀번호는 기존 비밀번호와 달라야 합니다.",
        )
    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    # 이 시각 이전에 로그인한 토큰(다른 브라우저·탭의 세션, 그리고 이 요청의 토큰)은 무효가 된다.
    user.password_changed_at = utcnow_naive()
    db.commit()
    db.refresh(user)
    audit_logger.record(
        db,
        action="user.password.change",
        actor=user,
        status="success",
        target_type="user",
        target_id=user.id,
        request=request,
    )
    # refresh 후 트랜잭션/세션 이슈로 must_change_password 가 다시 True 로 비치는
    # 일이 없도록 응답을 명시적으로 구성한다 — 프론트엔드 강제 변경 화면을 확실히 해제.
    # 이 요청에 쓴 토큰도 방금 무효가 됐으므로, 현재 비밀번호를 확인한 이 시점을 새 로그인으로
    # 보고 토큰을 다시 발급해 함께 돌려준다 — 프론트가 받아 끼우면 본인 세션은 끊기지 않는다.
    return PasswordChangeResponse(
        id=user.id,
        username=user.username,
        role=user.role,
        display_name=user.display_name,
        is_active=user.is_active,
        must_change_password=False,
        editor_white_bg=bool(user.editor_white_bg),
        created_at=user.created_at,
        access_token=create_access_token(subject=user.username, role=user.role),
    )


@router.patch("/me/preferences", response_model=UserOut)
def update_my_preferences(
    payload: UpdatePreferencesRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.editor_white_bg = payload.editor_white_bg
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)


# ── Admin-only user management ────────────────────────────────────────────


@router.get("/users", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    return [UserOut.model_validate(u) for u in db.query(User).order_by(User.created_at).all()]


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: CreateUserRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="이미 존재하는 사용자명입니다.")
    user = User(
        username=payload.username,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        display_name=payload.display_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    audit_logger.record(
        db,
        action="user.create",
        actor=actor,
        status="success",
        target_type="user",
        target_id=user.id,
        details={"username": user.username, "role": user.role},
        request=request,
    )
    return UserOut.model_validate(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    if user_id == actor.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="자기 자신은 삭제할 수 없습니다.")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="사용자를 찾을 수 없습니다.")
    snapshot = {"username": user.username, "role": user.role}
    # user_settings 는 users 에 FK 가 없다(값이 JSON 이라 사용자별 키만 갖는 경량 저장소) — 계정과
    # 함께 지우지 않으면 고아 행이 쌓이고, 같은 id 가 재사용되면 남의 개인 설정을 물려받는다.
    snapshot["settings_deleted"] = (
        db.query(UserSetting).filter(UserSetting.user_id == user_id).delete(synchronize_session=False)
    )
    db.delete(user)
    db.commit()
    audit_logger.record(
        db,
        action="user.delete",
        actor=actor,
        status="success",
        target_type="user",
        target_id=user_id,
        details=snapshot,
        request=request,
    )
    return None


@router.put("/users/{user_id}/role", response_model=UserOut)
def update_user_role(
    user_id: str,
    payload: UpdateUserRoleRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    if user_id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="자기 자신의 역할은 변경할 수 없습니다.",
        )
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="사용자를 찾을 수 없습니다.")
    before = user.role
    user.role = payload.role
    db.commit()
    db.refresh(user)
    audit_logger.record(
        db,
        action="user.role.update",
        actor=actor,
        status="success",
        target_type="user",
        target_id=user.id,
        details={"username": user.username, "before": before, "after": user.role},
        request=request,
    )
    return UserOut.model_validate(user)


@router.post("/users/{user_id}/password", response_model=UserOut)
def admin_reset_password(
    user_id: str,
    payload: UpdatePasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="사용자를 찾을 수 없습니다.")
    user.hashed_password = hash_password(payload.new_password)
    # 재설정 이전에 로그인한 그 사용자의 세션(토큰)을 모두 끊는다.
    user.password_changed_at = utcnow_naive()
    db.commit()
    db.refresh(user)
    audit_logger.record(
        db,
        action="user.password.reset",
        actor=actor,
        status="success",
        target_type="user",
        target_id=user.id,
        details={"username": user.username},
        request=request,
    )
    return UserOut.model_validate(user)
