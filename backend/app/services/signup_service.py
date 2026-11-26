"""로그인 화면 가입 신청 + 관리자 승인 — 설정·검증·상태 전이.

설정 원천은 AppSetting ``auth.signup``(Settings ▸ 가입 신청). 기본은 **꺼짐** — 설치 직후 누구나 신청할 수
있는 창구가 열리지 않게, 관리자가 정책을 보고 직접 켠다.

상용 서비스 관점의 결정(요약 — 근거는 각 함수 주석):

* 신청은 ``users`` 가 아니라 ``signup_requests`` 에 쌓는다(명부 오염 방지). 승인하면 그때 계정을 만든다.
* 비밀번호는 신청 시점에 bcrypt 해시로만 보관한다. 승인 뒤에는 계정으로 옮기고 신청 행에서는 지운다.
* 가입 비밀번호 정책은 관리자 계정 생성(최소 4자)보다 엄격하다 — 외부에서 들어오는 계정이라서.
* 남용 방지: IP 당 시간 창 제출 횟수(Redis, 로그인 레이트리밋과 같은 fail-open 규칙) · 전체 대기 건수 상한 ·
  봇용 숨김 필드(honeypot) · 예약 아이디 차단.
* 대기 신청은 ``pending_expire_days`` 가 지나면 만료되고, 결정된 신청은 ``retention_days`` 뒤에 행째 지운다.
  별도 Beat 없이 목록 조회·신청 제출 때 정리한다(``sweep``).
* 승인으로 줄 수 있는 역할은 viewer·operator 뿐이다. admin 승격은 계정 생성 뒤 사용자 관리에서 따로 한다.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.security import hash_password, verify_password
from app.models.app_setting import AppSetting
from app.models.signup_request import SignupRequest
from app.models.user import User

logger = logging.getLogger("k8s_monitor.signup")

SETTING_KEY = "auth.signup"

STATUSES = ("pending", "approved", "rejected", "expired", "withdrawn")
GRANT_ROLES = ("viewer", "operator")

# IP 당 제출 허용치(성공·실패 모두 센다) — 정상 사용자는 한두 번이면 끝난다.
IP_MAX_SUBMITS = 5
IP_WINDOW_SECONDS = 60 * 60

MIN_PW_FLOOR, MAX_PW_CEIL = 8, 64
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
DOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# 시스템·관리 계정으로 오인될 수 있는 이름 — 대소문자 무시, 정확히 일치.
RESERVED_USERNAMES = frozenset({
    "admin", "administrator", "root", "system", "sysadmin", "superuser", "su", "operator", "viewer",
    "pep", "support", "security", "audit", "api", "service", "daemon", "null", "undefined", "anonymous",
    "guest", "test", "kubernetes", "k8s", "kube-admin", "kubeadmin", "postgres", "redis", "celery",
})

# 흔한 비밀번호 — 정책 길이를 채워도 통과시키지 않는다(소문자 비교).
_COMMON_PASSWORDS = frozenset({
    "password1234", "password123!", "qwerty123456", "1q2w3e4r5t", "1q2w3e4r5t6y", "qwer1234!@#$",
    "asdf1234!@#$", "abcd1234!@#$", "admin1234567", "p@ssw0rd1234", "welcome12345", "iloveyou1234",
    "1234567890ab", "a1234567890", "zaq12wsxcde3", "passw0rd123", "changeme1234",
})

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "min_password_length": 10,
    # 비우면 제한 없음. 채우면 이메일 도메인이 목록 중 하나(하위 도메인 포함)여야 신청을 받는다.
    "allowed_email_domains": [],
    "pending_expire_days": 14,
    "retention_days": 90,
    "max_pending": 100,
    # 신청 폼 위에 보이는 안내(소속·사유 작성 요령, 승인 소요 시간 등).
    "notice": "",
}

_LIMITS = {
    "min_password_length": (MIN_PW_FLOOR, MAX_PW_CEIL),
    "pending_expire_days": (1, 365),
    "retention_days": (1, 3650),
    "max_pending": (1, 10000),
}


class SignupError(ValueError):
    """사용자에게 그대로 보여 줄 수 있는 문구 + HTTP 상태 + 감사용 코드."""

    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


# ── 설정 ──────────────────────────────────────────────────────────────────


def load_config(db: Session) -> dict[str, Any]:
    row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
    cfg = dict(DEFAULTS)
    if row is not None and isinstance(row.value, dict):
        for k in DEFAULTS:
            if k in row.value:
                cfg[k] = row.value[k]
    return cfg


def load_config_safe(db: Session) -> dict[str, Any]:
    """공개 경로용 — 설정 행을 못 읽으면 꺼진 기본값(신청 창구 닫힘, fail-closed)."""
    try:
        return load_config(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("signup: 설정 조회 실패 — 가입 신청 비활성으로 처리: %s", type(exc).__name__)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return dict(DEFAULTS)


def _norm_domains(values: list[Any]) -> list[str]:
    out: list[str] = []
    for v in values:
        d = str(v or "").strip().lower().lstrip("@")
        if not d:
            continue
        if not DOMAIN_RE.match(d):
            raise ValueError(f"이메일 도메인 형식이 올바르지 않습니다: {d[:80]}")
        if d not in out:
            out.append(d)
    return out


def merge_config(cfg: dict[str, Any], patch: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    out = dict(cfg)
    changed: list[str] = []
    for key, value in patch.items():
        if key not in DEFAULTS or value is None:
            continue
        if key == "enabled":
            value = bool(value)
        elif key in _LIMITS:
            lo, hi = _LIMITS[key]
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{key} 는 숫자여야 합니다.") from None
            if not lo <= value <= hi:
                raise ValueError(f"{key} 는 {lo}~{hi} 사이여야 합니다.")
        elif key == "allowed_email_domains":
            if not isinstance(value, list):
                raise ValueError("allowed_email_domains 는 목록이어야 합니다.")
            value = _norm_domains(value)
        elif key == "notice":
            value = str(value).strip()[:500]
        if out.get(key) != value:
            out[key] = value
            changed.append(key)
    return out, changed


def save_config(db: Session, patch: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    cfg, changed = merge_config(load_config(db), patch)
    row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=cfg))
    else:
        row.value = cfg
    db.commit()
    return cfg, changed


def public_view(cfg: dict[str, Any]) -> dict[str, Any]:
    """로그인 화면이 보는 값 — 켜짐 여부와 폼 검증에 필요한 정책만(상한·보존 기간 등 운영값 제외)."""
    return {
        "enabled": bool(cfg.get("enabled")),
        "min_password_length": int(cfg.get("min_password_length") or DEFAULTS["min_password_length"]),
        "allowed_email_domains": list(cfg.get("allowed_email_domains") or []),
        "notice": str(cfg.get("notice") or ""),
    }


# ── 입력 검증 ─────────────────────────────────────────────────────────────


def _clean(value: str | None, *, max_len: int, field: str, required: bool, multiline: bool = False) -> str | None:
    v = (value or "").strip()
    probe = v.replace("\r\n", "\n").replace("\n", "").replace("\t", "") if multiline else v
    if _CONTROL.search(probe):
        raise SignupError("invalid_input", f"{field} 에 사용할 수 없는 문자가 있습니다.")
    if required and not v:
        raise SignupError("invalid_input", f"{field} 을(를) 입력하세요.")
    if len(v) > max_len:
        raise SignupError("invalid_input", f"{field} 은(는) {max_len}자 이하로 입력하세요.")
    return v or None


def validate_username(username: str) -> str:
    u = (username or "").strip()
    if not USERNAME_RE.match(u):
        raise SignupError(
            "invalid_username",
            "아이디는 영문·숫자로 시작하는 3~64자이며 영문·숫자·. _ - 만 쓸 수 있습니다.",
        )
    if u.lower() in RESERVED_USERNAMES:
        raise SignupError("reserved_username", "사용할 수 없는 아이디입니다. 다른 아이디를 입력하세요.")
    return u


def validate_email(email: str, cfg: dict[str, Any]) -> str:
    e = (email or "").strip()
    if len(e) > 255 or not EMAIL_RE.match(e):
        raise SignupError("invalid_email", "이메일 형식이 올바르지 않습니다.")
    domains = cfg.get("allowed_email_domains") or []
    if domains:
        host = e.rsplit("@", 1)[1].lower()
        if not any(host == d or host.endswith("." + d) for d in domains):
            raise SignupError(
                "email_domain_not_allowed",
                f"허용된 이메일 도메인({', '.join(domains)})의 주소로만 신청할 수 있습니다.",
            )
    return e


def password_problems(password: str, *, username: str, min_length: int) -> list[str]:
    """정책 위반 사유 목록(빈 목록 = 통과). 프론트의 실시간 체크리스트와 같은 규칙."""
    problems: list[str] = []
    pw = password or ""
    if len(pw) < min_length:
        problems.append(f"{min_length}자 이상이어야 합니다.")
    if len(pw) > 128:
        problems.append("128자 이하여야 합니다.")
    if not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw):
        problems.append("영문과 숫자를 모두 포함해야 합니다.")
    if re.search(r"\s", pw):
        problems.append("공백을 포함할 수 없습니다.")
    if username and len(username) >= 3 and username.lower() in pw.lower():
        problems.append("아이디를 포함할 수 없습니다.")
    if pw.lower() in _COMMON_PASSWORDS or re.fullmatch(r"(.)\1+", pw):
        problems.append("너무 흔하거나 단순한 비밀번호입니다.")
    return problems


# ── 레이트리밋(IP) ────────────────────────────────────────────────────────


def check_ip_allowed(ip: str) -> bool:
    """제출 1회를 세고 허용 여부를 돌려준다. Redis 가 없으면 허용(fail-open — 대기 건수 상한이 2차 방어선)."""
    from app.services import login_rate_limiter

    allowed, _ = login_rate_limiter.incr_window(f"signup:ip:{ip}", IP_MAX_SUBMITS, IP_WINDOW_SECONDS)
    return allowed


# ── 정리(만료·보존) ───────────────────────────────────────────────────────


def sweep(db: Session, cfg: dict[str, Any] | None = None) -> dict[str, int]:
    """기한 지난 대기 신청을 만료 처리하고, 보존 기간이 지난 결정 행을 지운다. 실패해도 호출자를 막지 않는다."""
    cfg = cfg or load_config(db)
    now = datetime.utcnow()
    result = {"expired": 0, "purged": 0}
    try:
        expire_before = now - timedelta(days=int(cfg.get("pending_expire_days") or DEFAULTS["pending_expire_days"]))
        result["expired"] = (
            db.query(SignupRequest)
            .filter(SignupRequest.status == "pending", SignupRequest.created_at < expire_before)
            .update(
                {SignupRequest.status: "expired", SignupRequest.decided_at: now,
                 SignupRequest.decision_note: "승인 대기 기한이 지나 자동 만료되었습니다."},
                synchronize_session=False,
            )
        )
        purge_before = now - timedelta(days=int(cfg.get("retention_days") or DEFAULTS["retention_days"]))
        result["purged"] = (
            db.query(SignupRequest)
            .filter(SignupRequest.status != "pending", SignupRequest.decided_at.isnot(None),
                    SignupRequest.decided_at < purge_before)
            .delete(synchronize_session=False)
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("signup: 정리 실패 — %s", type(exc).__name__)
    return result


# ── 상태 전이 ─────────────────────────────────────────────────────────────


def _username_taken(db: Session, username: str) -> bool:
    lowered = username.lower()
    if db.query(User.id).filter(func.lower(User.username) == lowered).first() is not None:
        return True
    # 담당자 명부의 사번과 같은 값도 막는다 — 로그인 계정은 사번=아이디 규칙이라 승인 때 충돌한다.
    if db.query(User.id).filter(func.lower(User.employee_id) == lowered).first() is not None:
        return True
    return (
        db.query(SignupRequest.id)
        .filter(SignupRequest.status == "pending", func.lower(SignupRequest.username) == lowered)
        .first()
        is not None
    )


def submit(
    db: Session,
    cfg: dict[str, Any],
    *,
    username: str,
    password: str,
    display_name: str,
    email: str,
    department: str | None,
    reason: str | None,
    ip: str | None,
    user_agent: str | None,
) -> SignupRequest:
    if not cfg.get("enabled"):
        raise SignupError("disabled", "가입 신청을 받고 있지 않습니다. 관리자에게 계정 발급을 요청하세요.", 403)
    u = validate_username(username)
    name = _clean(display_name, max_len=128, field="이름", required=True)
    mail = validate_email(email, cfg)
    dept = _clean(department, max_len=128, field="소속", required=False)
    why = _clean(reason, max_len=1000, field="신청 사유", required=False, multiline=True)
    problems = password_problems(password, username=u, min_length=int(cfg.get("min_password_length") or 10))
    if problems:
        raise SignupError("weak_password", "비밀번호 정책: " + " ".join(problems))

    sweep(db, cfg)
    pending = db.query(func.count(SignupRequest.id)).filter(SignupRequest.status == "pending").scalar() or 0
    if pending >= int(cfg.get("max_pending") or DEFAULTS["max_pending"]):
        raise SignupError(
            "queue_full", "현재 처리 대기 중인 신청이 많아 접수할 수 없습니다. 잠시 후 다시 시도하세요.", 503,
        )
    if _username_taken(db, u):
        # 아이디 중복은 알려 준다(가입 UX). 이 응답으로 계정 존재를 캐는 시도는 IP 레이트리밋으로 묶는다.
        raise SignupError("username_taken", "이미 사용 중이거나 승인 대기 중인 아이디입니다.", 409)

    req = SignupRequest(
        username=u,
        display_name=name,
        email=mail,
        department=dept,
        reason=why,
        password_hash=hash_password(password),
        status="pending",
        request_ip=(ip or "")[:64] or None,
        user_agent=(user_agent or "")[:255] or None,
    )
    db.add(req)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise SignupError("username_taken", "이미 사용 중이거나 승인 대기 중인 아이디입니다.", 409) from None
    db.refresh(req)
    return req


def _get_pending(db: Session, request_id: str) -> SignupRequest:
    req = db.query(SignupRequest).filter(SignupRequest.id == request_id).with_for_update().first()
    if req is None:
        raise SignupError("not_found", "가입 신청을 찾을 수 없습니다.", 404)
    if req.status != "pending":
        raise SignupError("already_decided", f"이미 처리된 신청입니다(상태: {req.status}).", 409)
    return req


def approve(db: Session, request_id: str, *, actor: User, role: str, note: str | None) -> tuple[SignupRequest, User]:
    if role not in GRANT_ROLES:
        raise SignupError("invalid_role", "승인 시 부여할 수 있는 역할은 viewer·operator 입니다.")
    req = _get_pending(db, request_id)
    if not req.password_hash:
        raise SignupError("no_password", "신청 비밀번호가 없어 승인할 수 없습니다. 거절 후 다시 신청받으세요.", 409)
    lowered = req.username.lower()
    if db.query(User.id).filter(func.lower(User.username) == lowered).first() is not None:
        raise SignupError(
            "username_taken", "그사이 같은 아이디의 계정이 만들어졌습니다. 이 신청은 거절 처리하세요.", 409,
        )
    emp_taken = db.query(User.id).filter(func.lower(User.employee_id) == lowered).first() is not None
    user = User(
        username=req.username,
        hashed_password=req.password_hash,
        role=role,
        display_name=req.display_name,
        email=req.email,
        # 담당자 명부 규칙상 로그인 계정은 사번(employee_id)을 가진 행 — LDAP·OIDC 자동 생성과 같은 규칙.
        employee_id=None if emp_taken else req.username,
        is_active=True,
        must_change_password=False,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise SignupError("username_taken", "같은 아이디의 계정이 이미 있습니다. 이 신청은 거절 처리하세요.", 409) from None
    now = datetime.utcnow()
    req.status = "approved"
    req.decided_by = actor.username
    req.decided_at = now
    req.decision_note = (note or "").strip()[:500] or None
    req.granted_role = role
    req.user_id = user.id
    req.password_hash = None  # 해시는 계정으로 옮겼다 — 신청 기록에는 남기지 않는다.
    db.commit()
    db.refresh(req)
    db.refresh(user)
    return req, user


def reject(db: Session, request_id: str, *, actor: User, note: str | None) -> SignupRequest:
    req = _get_pending(db, request_id)
    req.status = "rejected"
    req.decided_by = actor.username
    req.decided_at = datetime.utcnow()
    req.decision_note = (note or "").strip()[:500] or None
    # 해시는 보존 기간 동안 남긴다 — 신청자가 로그인을 시도하면 본인 확인 후 거절 사유를 보여 주기 위해.
    db.commit()
    db.refresh(req)
    return req


# ── 로그인 화면 안내 ──────────────────────────────────────────────────────


def login_status_hint(db: Session, username: str, password: str) -> tuple[str, str] | None:
    """계정이 없는 아이디로 로그인했을 때, 그 아이디의 최근 신청과 비밀번호가 맞으면 (상태, 안내 문구).

    비밀번호가 일치할 때만 알려 주므로 신청 여부를 캐는 오라클이 되지 않는다. 실패는 None(일반 로그인 실패).
    """
    try:
        req = (
            db.query(SignupRequest)
            .filter(func.lower(SignupRequest.username) == username.lower(),
                    SignupRequest.status.in_(("pending", "rejected", "expired")),
                    SignupRequest.password_hash.isnot(None))
            .order_by(SignupRequest.created_at.desc())
            .first()
        )
    except Exception:  # noqa: BLE001 — 안내 조회 실패가 로그인 응답을 바꾸지 않게
        db.rollback()
        return None
    if req is None or not verify_password(password, req.password_hash):
        return None
    if req.status == "pending":
        return "pending", "가입 신청이 관리자 승인을 기다리고 있습니다. 승인되면 이 아이디로 로그인할 수 있습니다."
    if req.status == "rejected":
        note = f" 사유: {req.decision_note}" if req.decision_note else ""
        return "rejected", f"가입 신청이 거절되었습니다.{note} 다시 신청하거나 관리자에게 문의하세요."
    return "expired", "가입 신청이 승인 대기 기한을 넘겨 만료되었습니다. 다시 신청하세요."
