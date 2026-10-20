"""Authentication endpoints — /auth/login, /auth/refresh, /auth/me, admin user management."""
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
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
from app.services import ldap_service
from app.services import login_rate_limiter
from app.services.ldap_service import LdapError, LdapIdentity

logger = logging.getLogger("k8s_monitor.auth")

router = APIRouter(prefix="/auth", tags=["auth"])

INVALID_LOGIN_DETAIL = "잘못된 사용자명 또는 비밀번호입니다."
DIRECTORY_UNAVAILABLE_DETAIL = (
    "사내 디렉터리(LDAP) 인증을 처리할 수 없습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요."
)


# ── 로그인 방식(auth_source) ────────────────────────────────────────────────
#
# 'ldap' 표식은 users 테이블 컬럼이 아니라 user_settings 의 ``auth_source`` 키에 둔다(마이그레이션 없음,
# 계정 삭제 시 함께 지워짐, 개인 설정 내보내기 허용 목록 밖이라 본인이 고칠 수 없음). LDAP 로그인에
# 성공하면 남기고, 로컬 비밀번호 로그인에 성공하면 지운다 — "마지막으로 성공한 로그인 방식".


def _auth_source(db: Session, user: User) -> str:
    try:
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user.id, UserSetting.key == ldap_service.AUTH_SOURCE_KEY)
            .first()
        )
    except Exception:  # noqa: BLE001 — 표식 조회 실패가 로그인·/me 를 막지 않게
        db.rollback()
        row = None
    if row is not None and isinstance(row.value, dict) and row.value.get("source") == "ldap":
        return "ldap"
    if not user.hashed_password:
        return "external"
    return "local"


def _mark_auth_source(db: Session, user: User, source: str) -> None:
    try:
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user.id, UserSetting.key == ldap_service.AUTH_SOURCE_KEY)
            .first()
        )
        if source == "ldap":
            if row is None:
                db.add(UserSetting(user_id=user.id, key=ldap_service.AUTH_SOURCE_KEY, value={"source": "ldap"}))
            elif row.value != {"source": "ldap"}:
                row.value = {"source": "ldap"}
            else:
                return
        elif row is not None:
            db.delete(row)
        else:
            return
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("auth: 로그인 방식 표식 저장 실패 — %s", type(exc).__name__)


def _user_out(db: Session, user: User, source: str | None = None) -> UserOut:
    out = UserOut.model_validate(user)
    out.auth_source = source or _auth_source(db, user)
    if out.auth_source != "local":
        # 디렉터리·IdP 계정은 PEP 비밀번호를 바꿀 수 없으므로 강제 변경 화면으로 보내지 않는다.
        out.must_change_password = False
    return out


def _login_failure_audit(db: Session, request: Request, username: str, user: User | None, details: dict) -> None:
    audit_logger.record(
        db,
        action="login.failure",
        actor=user if user else None,
        actor_username=username,
        status="failure",
        target_type="user",
        target_id=user.id if user else None,
        details=details,
        request=request,
    )


def _find_user_ci(db: Session, username: str) -> User | None:
    """LDAP 은 대소문자를 가리지 않는다 — 정확히 일치하는 계정이 없으면 대소문자 무시로 1건만 찾는다."""
    rows = db.query(User).filter(func.lower(User.username) == username.lower()).limit(2).all()
    return rows[0] if len(rows) == 1 else None


def _provision_ldap_user(db: Session, cfg: dict, username: str, ident: LdapIdentity) -> User | None:
    role = cfg.get("default_role") if cfg.get("default_role") in ldap_service.PROVISION_ROLES else "viewer"
    # 담당자 명부 규칙상 로그인 계정은 사번(employee_id)을 가진 행이다 — OIDC 자동 생성과 같은 규칙.
    emp_taken = db.query(User.id).filter(User.employee_id == username).first() is not None
    user = User(
        username=username,
        hashed_password=None,  # 로컬 비밀번호 없음 — 로그인은 LDAP 로만
        role=role,
        display_name=(ident.display_name or username)[:128],
        email=ident.email,
        employee_id=None if emp_taken else username,
        is_active=True,
        must_change_password=False,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # 동시 첫 로그인 경쟁 — 다른 요청이 먼저 만들었으면 그 행을 쓴다.
        return db.query(User).filter(User.username == username).first()
    db.refresh(user)
    audit_logger.record(
        db,
        action="user.create",
        actor=user,
        status="success",
        target_type="user",
        target_id=user.id,
        details={"username": username, "role": role, "method": "ldap_auto_provision"},
    )
    return user


def _login_order(cfg: dict, user: User | None) -> list[str]:
    """시도할 로그인 방식 순서. LDAP 이 꺼져 있으면 로컬만(기존 동작 그대로)."""
    if not ldap_service.is_ready(cfg):
        return ["local"]
    has_local = user is not None and bool(user.hashed_password)
    if not has_local:
        # 로컬 비밀번호가 없는 계정(OIDC·LDAP 생성)이나 아직 없는 계정은 LDAP 만.
        return ["ldap"]
    if user is not None and user.role == "admin" and cfg.get("protect_local_admins", True) is not False:
        return ["local"]
    if ldap_service.priority(cfg) == "ldap_first":
        return ["ldap", "local"]
    return ["local", "ldap"]


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
    cfg = ldap_service.load_config_safe(db)
    ldap_on = ldap_service.is_ready(cfg)
    order = _login_order(cfg, user)

    if user is not None and not user.is_active:
        login_rate_limiter.record_failure(ip, payload.username)
        details = (
            {"method": order[0], "reason": "user_inactive"} if ldap_on else {"reason": "invalid_credentials"}
        )
        _login_failure_audit(db, request, payload.username, user, details)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=INVALID_LOGIN_DETAIL)

    method: str | None = None
    ident: LdapIdentity | None = None
    attempts: list[dict] = []
    ldap_detail = ""
    for m in order:
        if m == "local":
            if user is not None and user.hashed_password and verify_password(payload.password, user.hashed_password):
                method = "local"
                break
            attempts.append({"method": "local", "reason": "invalid_credentials" if user else "unknown_user"})
        else:
            try:
                ident = ldap_service.authenticate(cfg, payload.username, payload.password)
            except LdapError as exc:
                attempts.append({"method": "ldap", "reason": exc.code})
                ldap_detail = exc.detail
                logger.info("ldap login failure: %s — %s", exc.code, exc.detail)
                continue
            method = "ldap"
            break

    provisioned = False
    if method == "ldap" and ident is not None:
        reject: str | None = None
        if user is None:
            user = _find_user_ci(db, payload.username)
            if user is not None and "ldap" not in _login_order(cfg, user):
                # 대소문자만 다른 이름으로 보호 대상(로컬 admin) 계정에 LDAP 로 들어오지 못하게.
                reject = "local_admin_protected"
        if reject is None and user is None:
            if not cfg.get("auto_provision"):
                reject = "user_not_provisioned"
            else:
                user = _provision_ldap_user(db, cfg, payload.username, ident)
                provisioned = user is not None
                if user is None:
                    reject = "provision_failed"
        if reject is None and user is not None and not user.is_active:
            reject = "user_inactive"
        if reject is not None:
            attempts.append({"method": "ldap", "reason": reject})
            method = None

    if method is None:
        last = attempts[-1] if attempts else {"method": "local", "reason": "unknown_user"}
        if ldap_on:
            details: dict = {"method": last["method"], "reason": last["reason"], "attempts": attempts}
            if ldap_detail:
                details["detail"] = ldap_detail[:300]
        else:
            details = {"reason": last["reason"]}
        _login_failure_audit(db, request, payload.username, user, details)
        # 디렉터리 쪽 인프라 실패뿐이라면(자격증명은 확인조차 못 했다) 401 이 아니라 503 — 사용자가
        # 비밀번호를 틀렸다고 오해하지 않게 하고, 레이트리밋 실패 카운트에도 넣지 않는다.
        infra_only = bool(attempts) and all(
            a["method"] == "ldap" and a["reason"] in ldap_service.INFRA_CODES for a in attempts
        )
        if infra_only:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=DIRECTORY_UNAVAILABLE_DETAIL)
        login_rate_limiter.record_failure(ip, payload.username)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=INVALID_LOGIN_DETAIL)

    assert user is not None
    if method == "ldap" and ident is not None and not provisioned and (
        (ident.display_name and not user.display_name) or (ident.email and not user.email)
    ):
        # 비어 있는 프로필만 디렉터리 값으로 채운다(운영자가 고친 값은 덮지 않는다).
        user.display_name = user.display_name or ident.display_name
        user.email = user.email or ident.email
        db.commit()
        db.refresh(user)
    # LDAP 이 꺼진 뒤의 로컬 로그인도 예전 'ldap' 표식을 지워야 비밀번호 변경이 다시 열린다.
    _mark_auth_source(db, user, method)

    login_rate_limiter.record_success(ip, payload.username)
    token = create_access_token(subject=user.username, role=user.role)
    success_details: dict | None = None
    if method == "ldap":
        success_details = {"method": "ldap", "provisioned": provisioned}
    elif ldap_on:
        success_details = {"method": "local"}
    audit_logger.record(
        db,
        action="login.success",
        actor=user,
        status="success",
        target_type="user",
        target_id=user.id,
        details=success_details,
        request=request,
    )
    return TokenResponse(access_token=token, user=_user_out(db, user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _user_out(db, user)


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(
    token: str = Depends(oauth2_scheme),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
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
    return TokenResponse(access_token=new_token, user=_user_out(db, user))


@router.post("/me/password", response_model=PasswordChangeResponse)
def change_my_password(
    payload: SelfPasswordChangeRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    source = _auth_source(db, user)
    if source != "local":
        # 사내 디렉터리(LDAP)·SSO 계정의 비밀번호는 PEP 가 아니라 디렉터리·IdP 에서 바꾼다.
        audit_logger.record(
            db,
            action="user.password.change",
            actor=user,
            status="failure",
            target_type="user",
            target_id=user.id,
            details={"reason": "directory_account" if source == "ldap" else "no_local_password"},
            request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "사내 디렉터리(LDAP) 계정입니다. 비밀번호는 사내 디렉터리에서 변경하세요."
                if source == "ldap"
                else "SSO 계정에는 PEP 비밀번호가 없습니다. 비밀번호는 사내 IdP 에서 변경하세요."
            ),
        )
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
        auth_source="local",
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
