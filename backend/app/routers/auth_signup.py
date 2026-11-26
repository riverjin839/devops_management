"""로그인 화면 가입 신청 + 관리자 승인 — /auth/signup*.

public 마운트(auth 와 같은 위치). 신청 접수(``POST /auth/signup``)와 로그인 화면용 공개 설정
(``GET /auth/signup/config``)만 비인증이고, 설정·신청 목록·승인·거절은 엔드포인트가 ``require_admin`` 을
직접 건다. 규칙·정책은 ``services/signup_service.py``.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.database import get_db
from app.models.signup_request import SignupRequest
from app.models.user import User
from app.services import audit_logger, login_rate_limiter
from app.services import signup_service as signup
from app.services.signup_service import SignupError

router = APIRouter(prefix="/auth/signup", tags=["auth"])

ACCEPTED_DETAIL = "가입 신청이 접수되었습니다. 관리자가 승인하면 입력한 아이디와 비밀번호로 로그인할 수 있습니다."


# ── 스키마 ───────────────────────────────────────────────────────────────


class SignupPublicConfig(BaseModel):
    enabled: bool
    min_password_length: int
    allowed_email_domains: list[str]
    notice: str


class SignupSubmitRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=128)
    display_name: str = Field(..., min_length=1, max_length=128)
    email: str = Field(..., min_length=3, max_length=255)
    department: str | None = Field(None, max_length=128)
    reason: str | None = Field(None, max_length=1000)
    # 봇용 숨김 필드(honeypot) — 사람은 보지 못해 비워 둔다. 값이 오면 접수한 척하고 버린다.
    website: str | None = Field(None, max_length=256)


class SignupSubmitResponse(BaseModel):
    ok: bool = True
    detail: str = ACCEPTED_DETAIL


class SignupSettingsOut(BaseModel):
    enabled: bool
    min_password_length: int
    allowed_email_domains: list[str]
    pending_expire_days: int
    retention_days: int
    max_pending: int
    notice: str
    # 같은 아이디가 디렉터리·IdP 계정과 겹칠 수 있는 구성인지 — 화면이 승인 전 확인 경고를 띄운다.
    ldap_enabled: bool = False
    oidc_enabled: bool = False


class SignupSettingsUpdate(BaseModel):
    enabled: bool | None = None
    min_password_length: int | None = None
    allowed_email_domains: list[str] | None = Field(None, max_length=50)
    pending_expire_days: int | None = None
    retention_days: int | None = None
    max_pending: int | None = None
    notice: str | None = Field(None, max_length=500)


class SignupRequestOut(BaseModel):
    id: str
    username: str
    display_name: str
    email: str
    department: str | None = None
    reason: str | None = None
    status: str
    request_ip: str | None = None
    user_agent: str | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    decision_note: str | None = None
    granted_role: str | None = None
    user_id: str | None = None
    created_at: datetime
    # 대기 신청이 자동 만료되는 시각(대기 상태만).
    expires_at: datetime | None = None

    class Config:
        from_attributes = True


class SignupRequestList(BaseModel):
    items: list[SignupRequestOut]
    counts: dict[str, int]


class ApproveRequest(BaseModel):
    role: str = Field("viewer", pattern=r"^(viewer|operator)$")
    note: str | None = Field(None, max_length=500)


class RejectRequest(BaseModel):
    note: str | None = Field(None, max_length=500)


# ── 공개 ─────────────────────────────────────────────────────────────────


@router.get("/config", response_model=SignupPublicConfig)
def public_config(db: Session = Depends(get_db)):
    return SignupPublicConfig(**signup.public_view(signup.load_config_safe(db)))


@router.post("", response_model=SignupSubmitResponse, status_code=status.HTTP_202_ACCEPTED)
def submit_signup(payload: SignupSubmitRequest, request: Request, db: Session = Depends(get_db)):
    cfg = signup.load_config_safe(db)
    ip = login_rate_limiter.client_ip(request)
    username = payload.username.strip()

    def _fail(err: SignupError) -> NoReturn:
        audit_logger.record(
            db, action="signup.submit", actor=None, actor_username=username[:64], status="failure",
            target_type="signup_request", details={"reason": err.code}, request=request,
        )
        raise HTTPException(status_code=err.status_code, detail=err.detail)

    if not cfg.get("enabled"):
        # 꺼져 있으면 카운터도 올리지 않는다(창구가 닫힌 상태의 요청은 남용이 아니라 오래된 화면일 수 있다).
        _fail(SignupError("disabled", "가입 신청을 받고 있지 않습니다. 관리자에게 계정 발급을 요청하세요.", 403))
    if not signup.check_ip_allowed(ip):
        _fail(SignupError("rate_limited", "가입 신청이 너무 많이 시도되었습니다. 잠시 후 다시 시도하세요.", 429))
    if payload.website:
        audit_logger.record(
            db, action="signup.submit", actor=None, actor_username=username[:64], status="failure",
            target_type="signup_request", details={"reason": "honeypot"}, request=request,
        )
        return SignupSubmitResponse()

    try:
        req = signup.submit(
            db, cfg,
            username=username,
            password=payload.password,
            display_name=payload.display_name,
            email=payload.email,
            department=payload.department,
            reason=payload.reason,
            ip=ip,
            user_agent=request.headers.get("user-agent"),
        )
    except SignupError as err:
        _fail(err)

    audit_logger.record(
        db, action="signup.submit", actor=None, actor_username=req.username, status="success",
        target_type="signup_request", target_id=req.id,
        details={"username": req.username, "email": req.email}, request=request,
    )
    _notify_admins(db, req)
    return SignupSubmitResponse()


def _notify_admins(db: Session, req: SignupRequest) -> None:
    """관리자 알림 종 — 실패해도 신청 접수는 그대로 성공이다."""
    try:
        from app.services.user_notify import notify_broadcast

        notify_broadcast(
            db,
            type="signup_request",
            title=f"가입 신청: {req.display_name} ({req.username})",
            body=f"{req.email}{' · ' + req.department if req.department else ''} — 승인 대기",
            link="/settings?tab=signup",
            roles=("admin",),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


# ── 관리자 ───────────────────────────────────────────────────────────────


def _settings_out(db: Session, cfg: dict) -> SignupSettingsOut:
    ldap_on = oidc_on = False
    try:
        from app.services import ldap_service, oidc_service

        ldap_on = ldap_service.is_ready(ldap_service.load_config(db))
        oidc_on = oidc_service.is_ready(oidc_service.load_config(db))
    except Exception:  # noqa: BLE001 — 경고 표시용일 뿐
        db.rollback()
    return SignupSettingsOut(
        **{k: cfg[k] for k in signup.DEFAULTS}, ldap_enabled=ldap_on, oidc_enabled=oidc_on,
    )


@router.get("/settings", response_model=SignupSettingsOut)
def get_settings(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return _settings_out(db, signup.load_config(db))


@router.put("/settings", response_model=SignupSettingsOut)
def update_settings(
    payload: SignupSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    try:
        cfg, changed = signup.save_config(db, payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_logger.record(
        db, action="settings.signup.update", actor=actor, status="success",
        target_type="app_setting", target_id=signup.SETTING_KEY,
        details={"changed": changed, "enabled": bool(cfg.get("enabled"))}, request=request,
    )
    return _settings_out(db, cfg)


def _out(req: SignupRequest, cfg: dict) -> SignupRequestOut:
    out = SignupRequestOut.model_validate(req)
    if req.status == "pending" and req.created_at:
        out.expires_at = req.created_at + timedelta(days=int(cfg.get("pending_expire_days") or 14))
    return out


@router.get("/requests", response_model=SignupRequestList)
def list_requests(
    status_filter: str = Query("pending", alias="status", pattern=r"^(all|pending|approved|rejected|expired|withdrawn)$"),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = signup.load_config(db)
    signup.sweep(db, cfg)
    q = db.query(SignupRequest)
    if status_filter != "all":
        q = q.filter(SignupRequest.status == status_filter)
    # 대기 신청은 오래된 것부터(먼저 온 순서로 처리), 나머지는 최근 결정부터.
    order = SignupRequest.created_at.asc() if status_filter == "pending" else SignupRequest.created_at.desc()
    items = q.order_by(order).limit(limit).all()
    counts = {s: 0 for s in signup.STATUSES}
    for st, n in db.query(SignupRequest.status, func.count(SignupRequest.id)).group_by(SignupRequest.status).all():
        counts[st] = int(n)
    return SignupRequestList(items=[_out(r, cfg) for r in items], counts=counts)


@router.post("/requests/{request_id}/approve", response_model=SignupRequestOut)
def approve_request(
    request_id: str,
    payload: ApproveRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    try:
        req, user = signup.approve(db, request_id, actor=actor, role=payload.role, note=payload.note)
    except SignupError as err:
        db.rollback()
        audit_logger.record(
            db, action="signup.approve", actor=actor, status="failure", target_type="signup_request",
            target_id=request_id, details={"reason": err.code}, request=request,
        )
        raise HTTPException(status_code=err.status_code, detail=err.detail)
    audit_logger.record(
        db, action="signup.approve", actor=actor, status="success", target_type="signup_request",
        target_id=req.id, details={"username": req.username, "role": req.granted_role, "user_id": user.id},
        request=request,
    )
    audit_logger.record(
        db, action="user.create", actor=actor, status="success", target_type="user", target_id=user.id,
        details={"username": user.username, "role": user.role, "method": "signup_approval"}, request=request,
    )
    try:
        from app.services.user_notify import create_notification

        create_notification(
            db, user=user, type="signup_approved", title="가입이 승인되었습니다",
            body=f"역할: {user.role}. 필요한 권한이 더 있으면 관리자에게 요청하세요.", link="/",
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return _out(req, signup.load_config(db))


@router.post("/requests/{request_id}/reject", response_model=SignupRequestOut)
def reject_request(
    request_id: str,
    payload: RejectRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    try:
        req = signup.reject(db, request_id, actor=actor, note=payload.note)
    except SignupError as err:
        db.rollback()
        raise HTTPException(status_code=err.status_code, detail=err.detail)
    audit_logger.record(
        db, action="signup.reject", actor=actor, status="success", target_type="signup_request",
        target_id=req.id, details={"username": req.username, "has_note": bool(req.decision_note)},
        request=request,
    )
    return _out(req, signup.load_config(db))
