"""사내 IdP SSO(OIDC) 로그인 진입점 — /auth/oidc/* (D-079·R-7).

public 마운트(auth 와 같음). 로그인 흐름 엔드포인트는 인증 없이 열려 있고, 설정 조회·수정·연결
확인은 엔드포인트가 ``require_admin`` 을 직접 건다.

흐름
1. ``GET /auth/oidc/config`` — 로그인 화면이 버튼을 띄울지(enabled·display_name 만).
2. ``GET /auth/oidc/login?return_to=`` — state·nonce·PKCE verifier 를 임시 저장(10분)하고 브라우저
   바인딩 쿠키를 심은 뒤 IdP authorize URL 로 302.
3. ``GET /auth/oidc/callback?code&state`` — state 1회 소비·쿠키 대조 → 토큰 교환(PKCE) → id_token
   검증 → 사용자 매핑 → 우리 JWT 를 1회용 handoff code(60초)에 넣고 ``/auth/callback?code=`` 로 302.
   실패는 ``/auth/callback?error=<사유코드>``.
4. ``POST /auth/oidc/exchange {code}`` — handoff code 를 TokenResponse(+return_to)로 바꾼다.
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.auth.security import create_access_token
from app.database import get_db
from app.models.user import User
from app.schemas.auth import TokenResponse, UserOut
from app.services import audit_logger, login_rate_limiter
from app.services import oidc_service as oidc
from app.services.oidc_service import OidcError

logger = logging.getLogger("k8s_monitor.oidc")

router = APIRouter(prefix="/auth/oidc", tags=["auth"])

CALLBACK_PATH = "/api/v1/auth/oidc/callback"
FRONTEND_CALLBACK_PATH = "/auth/callback"
BIND_COOKIE = "pep_oidc_bind"
BIND_COOKIE_PATH = "/api/v1/auth/oidc"


# ── 스키마 ───────────────────────────────────────────────────────────────


class OidcPublicConfig(BaseModel):
    enabled: bool
    display_name: str


class OidcSettingsOut(BaseModel):
    enabled: bool
    display_name: str
    issuer: str
    client_id: str
    has_secret: bool
    scopes: str
    username_claim: str
    display_name_claim: str
    email_claim: str
    auto_provision: bool
    default_role: str
    allowed_domains: list[str]
    require_email_verified: bool = True
    public_base_url: str
    # IdP 에 등록할 redirect URI — 공개 주소(설정) 또는 이 요청 기준으로 계산.
    redirect_uri: str


class OidcSettingsUpdate(BaseModel):
    enabled: bool | None = None
    display_name: str | None = Field(None, max_length=64)
    issuer: str | None = Field(None, max_length=512)
    client_id: str | None = Field(None, max_length=255)
    client_secret: str | None = Field(None, max_length=1024)
    clear_client_secret: bool | None = None
    scopes: str | None = Field(None, max_length=512)
    username_claim: str | None = Field(None, max_length=64)
    display_name_claim: str | None = Field(None, max_length=64)
    email_claim: str | None = Field(None, max_length=64)
    auto_provision: bool | None = None
    default_role: str | None = None
    allowed_domains: list[str] | None = None
    require_email_verified: bool | None = None
    public_base_url: str | None = Field(None, max_length=512)


class OidcTestRequest(BaseModel):
    # 비우면 저장된 issuer 로 확인한다(저장 전 입력값을 먼저 확인할 수 있게).
    issuer: str | None = Field(None, max_length=512)


class OidcExchangeRequest(BaseModel):
    code: str = Field(..., min_length=8, max_length=256)


class OidcExchangeResponse(TokenResponse):
    return_to: str = "/"


# ── 주소 계산 ─────────────────────────────────────────────────────────────


def _origin(request: Request, cfg: dict[str, Any]) -> str:
    """브라우저가 보는 PEP 주소. 설정 ``public_base_url`` 우선, 없으면 프록시 헤더 → 요청 기준."""
    base = str(cfg.get("public_base_url") or "").strip().rstrip("/")
    if base:
        return base
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc)
    host = host.split(",")[0].strip()
    return f"{proto}://{host}"


def _redirect_uri(request: Request, cfg: dict[str, Any]) -> str:
    return f"{_origin(request, cfg)}{CALLBACK_PATH}"


def _front_redirect(request: Request, cfg: dict[str, Any], **params: str) -> RedirectResponse:
    resp = RedirectResponse(
        f"{_origin(request, cfg)}{FRONTEND_CALLBACK_PATH}?{urlencode(params)}",
        status_code=status.HTTP_302_FOUND,
    )
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


def _fail(request: Request, db: Session, cfg: dict[str, Any], exc: OidcError, *,
          username: str | None = None, user: User | None = None, clear_cookie: bool = True) -> RedirectResponse:
    # 운영자용 사유(detail)는 감사·로그에만 — 토큰·code·secret 은 OidcError 에 담지 않는다.
    logger.info("oidc login failure: %s — %s", exc.code, exc.detail)
    audit_logger.record(
        db,
        action="login.failure",
        actor=user,
        actor_username=username,
        status="failure",
        target_type="user",
        target_id=user.id if user else None,
        details={"method": "oidc", "reason": exc.code, "detail": exc.detail[:300]},
        request=request,
    )
    resp = _front_redirect(request, cfg, error=exc.code)
    if clear_cookie:
        resp.delete_cookie(BIND_COOKIE, path=BIND_COOKIE_PATH)
    return resp


# ── 공개 엔드포인트 ────────────────────────────────────────────────────────


@router.get("/config", response_model=OidcPublicConfig)
def public_config(db: Session = Depends(get_db)):
    return oidc.public_view(oidc.load_config(db))


@router.get("/login")
def start_login(
    request: Request,
    return_to: str | None = Query(None, max_length=512),
    db: Session = Depends(get_db),
):
    cfg = oidc.load_config(db)
    if not oidc.is_ready(cfg):
        return _front_redirect(request, cfg, error="disabled")
    ip = login_rate_limiter.client_ip(request)
    allowed, _ = login_rate_limiter.check_login_allowed(ip, "")
    if not allowed:
        return _front_redirect(request, cfg, error="rate_limited")
    try:
        meta = oidc.discover(cfg["issuer"])
    except OidcError as exc:
        return _fail(request, db, cfg, exc)
    state = oidc.random_token()
    nonce = oidc.random_token()
    verifier = oidc.random_token(48)  # 64자 — RFC 7636 의 43~128자 범위
    binding = oidc.random_token()
    redirect_uri = _redirect_uri(request, cfg)
    oidc.store_put(
        f"state:{state}",
        {
            "nonce": nonce,
            "verifier": verifier,
            "binding": oidc.binding_hash(binding),
            "redirect_uri": redirect_uri,
            "return_to": oidc.safe_return_to(return_to),
        },
        oidc.STATE_TTL_SECONDS,
    )
    url = oidc.authorize_url(meta, cfg, redirect_uri=redirect_uri, state=state, nonce=nonce, verifier=verifier)
    resp = RedirectResponse(url, status_code=status.HTTP_302_FOUND)
    resp.headers["Cache-Control"] = "no-store"
    resp.set_cookie(
        BIND_COOKIE,
        binding,
        max_age=oidc.STATE_TTL_SECONDS,
        path=BIND_COOKIE_PATH,
        httponly=True,
        samesite="lax",  # IdP → callback 은 최상위 GET 이동이라 Lax 로 전송된다
        secure=redirect_uri.startswith("https://"),
    )
    return resp


@router.get("/callback")
def callback(
    request: Request,
    code: str | None = Query(None, max_length=2048),
    state: str | None = Query(None, max_length=256),
    error: str | None = Query(None, max_length=128),
    db: Session = Depends(get_db),
):
    cfg = oidc.load_config(db)
    if not oidc.is_ready(cfg):
        return _front_redirect(request, cfg, error="disabled")
    ip = login_rate_limiter.client_ip(request)
    allowed, _ = login_rate_limiter.check_login_allowed(ip, "")
    if not allowed:
        return _front_redirect(request, cfg, error="rate_limited")

    # state 는 IdP 오류 응답이어도 먼저 소비한다(같은 state 로 다시 들어오지 못하게).
    record = oidc.store_pop(f"state:{state}") if state else None
    if error:
        return _fail(request, db, cfg, OidcError("idp_error", f"IdP 오류 응답: {error[:64]}"))
    binding = request.cookies.get(BIND_COOKIE) or ""
    if (
        record is None
        or not code
        or not binding
        or oidc.binding_hash(binding) != record.get("binding")
    ):
        # 모르는 state 로 들어온 요청이 진행 중인 정상 로그인의 바인딩 쿠키를 지우지 않게 한다.
        return _fail(request, db, cfg, OidcError("state_invalid", "state 없음·만료·재사용 또는 브라우저 불일치"),
                     clear_cookie=record is not None)

    try:
        meta = oidc.discover(cfg["issuer"])
        tokens = oidc.exchange_code(
            meta, cfg, code=code, redirect_uri=record["redirect_uri"], verifier=record["verifier"],
        )
        claims = oidc.verify_id_token(meta, cfg, tokens["id_token"], nonce=record["nonce"])
    except OidcError as exc:
        return _fail(request, db, cfg, exc)

    needed = [cfg.get("username_claim"), cfg.get("display_name_claim"), cfg.get("email_claim")]
    if oidc.needs_verified_email(cfg):
        needed.append("email_verified")
    if any(n and n not in claims for n in needed):
        extra = oidc.fetch_userinfo(meta, tokens.get("access_token"), str(claims.get("sub")))
        claims = {**extra, **claims}

    username = oidc.claim_str(claims, cfg.get("username_claim"))
    if not username or len(username) > 64:
        return _fail(request, db, cfg, OidcError(
            "claim_missing", f"사용자명 claim '{cfg.get('username_claim')}' 이 없거나 64자를 넘음",
        ))
    email = oidc.claim_str(claims, cfg.get("email_claim"))
    display_name = oidc.claim_str(claims, cfg.get("display_name_claim"))
    if not oidc.domain_allowed(cfg, email):
        login_rate_limiter.record_failure(ip, username)
        return _fail(request, db, cfg, OidcError("domain_not_allowed", "허용 도메인 밖의 이메일"), username=username)
    if oidc.needs_verified_email(cfg) and not oidc.email_verified(claims):
        login_rate_limiter.record_failure(ip, username)
        return _fail(request, db, cfg, OidcError(
            "email_unverified", "허용 도메인 정책이 켜져 있는데 IdP 가 email_verified=true 를 주지 않음",
        ), username=username)

    user = db.query(User).filter(User.username == username).first()
    created = False
    if user is None:
        if not cfg.get("auto_provision"):
            login_rate_limiter.record_failure(ip, username)
            return _fail(request, db, cfg, OidcError("user_not_found", "PEP 계정 없음(자동 생성 꺼짐)"),
                         username=username)
        user = _provision(db, cfg, username=username, display_name=display_name, email=email)
        if user is None:
            return _fail(request, db, cfg, OidcError("provision_failed", "계정 자동 생성 실패"), username=username)
        created = True
    if not user.is_active:
        login_rate_limiter.record_failure(ip, username)
        return _fail(request, db, cfg, OidcError("user_inactive", "비활성 계정"), username=username, user=user)

    # 비어 있는 프로필만 IdP 값으로 채운다(운영자가 고친 값은 덮지 않는다).
    if not created and ((display_name and not user.display_name) or (email and not user.email)):
        user.display_name = user.display_name or display_name
        user.email = user.email or (email[:255] if email else None)
        db.commit()
        db.refresh(user)

    login_rate_limiter.record_success(ip, username)
    token = create_access_token(subject=user.username, role=user.role)
    handoff = oidc.random_token()
    oidc.store_put(
        f"handoff:{handoff}",
        {"access_token": token, "user_id": user.id, "return_to": record.get("return_to") or "/"},
        oidc.HANDOFF_TTL_SECONDS,
    )
    audit_logger.record(
        db,
        action="login.success",
        actor=user,
        status="success",
        target_type="user",
        target_id=user.id,
        details={"method": "oidc", "provisioned": created},
        request=request,
    )
    resp = _front_redirect(request, cfg, code=handoff)
    resp.delete_cookie(BIND_COOKIE, path=BIND_COOKIE_PATH)
    return resp


def _provision(db: Session, cfg: dict[str, Any], *, username: str, display_name: str | None,
               email: str | None) -> User | None:
    role = cfg.get("default_role") if cfg.get("default_role") in oidc.PROVISION_ROLES else "viewer"
    # 담당자 명부 규칙상 로그인 계정은 사번(employee_id)을 가진 행이다 — 비어 있는 사번이면 username
    # 을 사번으로 함께 둬 명부 저장(사번 비움 = 계정 해제)이 이 계정을 지우지 않게 한다.
    emp_taken = db.query(User.id).filter(User.employee_id == username).first() is not None
    user = User(
        username=username,
        hashed_password=None,  # 비밀번호 로그인 불가(verify_password 가 None 해시를 거부)
        role=role,
        display_name=(display_name or username)[:128],
        email=email[:255] if email else None,
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
        details={"username": username, "role": role, "method": "oidc_auto_provision"},
    )
    return user


@router.post("/exchange", response_model=OidcExchangeResponse)
def exchange(payload: OidcExchangeRequest, db: Session = Depends(get_db)):
    cfg = oidc.load_config(db)
    if not oidc.is_ready(cfg):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SSO 로그인이 꺼져 있습니다.")
    data = oidc.store_pop(f"handoff:{payload.code}")
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="로그인 확인 코드가 만료됐거나 이미 사용됐습니다. 다시 로그인하세요.",
        )
    user = db.query(User).filter(User.id == data.get("user_id")).first()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="계정을 사용할 수 없습니다.")
    return OidcExchangeResponse(
        access_token=data["access_token"],
        user=UserOut.model_validate(user),
        return_to=oidc.safe_return_to(data.get("return_to")),
    )


# ── 관리자 설정 ───────────────────────────────────────────────────────────


def _settings_out(request: Request, cfg: dict[str, Any]) -> OidcSettingsOut:
    view = oidc.admin_view(cfg)
    return OidcSettingsOut(**view, redirect_uri=_redirect_uri(request, cfg))


@router.get("/settings", response_model=OidcSettingsOut)
def get_settings(request: Request, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return _settings_out(request, oidc.load_config(db))


@router.put("/settings", response_model=OidcSettingsOut)
def update_settings(
    payload: OidcSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    try:
        cfg, changed = oidc.save_config(db, payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_logger.record(
        db,
        action="settings.oidc.update",
        actor=actor,
        status="success",
        target_type="app_setting",
        target_id=oidc.SETTING_KEY,
        # 바뀐 필드 이름만 — 값(특히 client secret)은 남기지 않는다.
        details={"changed": changed, "enabled": bool(cfg.get("enabled"))},
        request=request,
    )
    return _settings_out(request, cfg)


@router.post("/settings/test")
def test_settings(
    payload: OidcTestRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    issuer = (payload.issuer or "").strip() or str(oidc.load_config(db).get("issuer") or "")
    return oidc.check_connection(issuer)
