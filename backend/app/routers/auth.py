"""Authentication endpoints — /auth/login, /auth/me, admin user management."""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.auth.security import hash_password, verify_password, create_access_token
from app.auth.deps import get_current_user, require_admin
from app.schemas.auth import (
    LoginRequest,
    TokenResponse,
    UserOut,
    CreateUserRequest,
    UpdatePasswordRequest,
    UpdateUserRoleRequest,
    SelfPasswordChangeRequest,
)
from app.services import audit_logger


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not user.is_active or not verify_password(payload.password, user.hashed_password):
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


@router.post("/me/password", response_model=UserOut)
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
    return UserOut(
        id=user.id,
        username=user.username,
        role=user.role,
        display_name=user.display_name,
        is_active=user.is_active,
        must_change_password=False,
        created_at=user.created_at,
    )


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
