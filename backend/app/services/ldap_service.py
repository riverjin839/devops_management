"""사내 디렉터리(LDAP/AD) 비밀번호 로그인 — 설정·바인드·사용자 검색·연결 확인 (R-7).

기존 ``POST /auth/login`` 하나로 처리한다. LDAP 이 켜져 있으면 설정된 우선순위(``local_first`` /
``ldap_first``)에 따라 로컬 비밀번호와 LDAP 바인드를 차례로 시도한다(라우터 ``auth.py``). 환경값(서버
주소·바인드 방식·검색 base/filter·속성 이름·허용 그룹·자동 생성 정책)은 코드가 아니라 Settings ▸ 접근
제어 화면에서 고친다 — ``AppSetting`` 키 ``auth.ldap`` (UI-First).

바인드 방식
- ``direct``: ``bind_dn_template`` 의 ``{username}`` 을 채워 그 이름으로 바로 바인드한다.
  DN 형식(``uid={username},ou=people,dc=…``)이면 ``escape_rdn`` 으로, UPN·도메인 형식
  (``{username}@corp.example``)이면 구분 문자(``@``·``\\``·``,``·``=`` 등)가 든 사용자명을 거절한다.
- ``search``: 서비스 계정(``service_bind_dn`` + 암호화 저장 비밀번호)으로 바인드해 ``user_search_base``
  아래에서 ``user_search_filter`` 로 사용자를 정확히 1명 찾고, 그 DN 으로 다시 바인드해 비밀번호를 확인한다.
  필터 값은 ``escape_filter_chars`` 로 escape 한다.

보안 요점
- 빈(또는 공백·NUL 이 든) 비밀번호는 서버에 보내지 않고 거절한다 — LDAP 의 "unauthenticated bind"
  (DN + 빈 비밀번호)는 많은 서버가 **성공**으로 응답해 비밀번호 확인으로 오인되기 때문이다.
- 서비스 계정 비밀번호는 ``secret_box`` 로 암호화해 ``bind_password_encrypted`` 에만 둔다. 조회 응답에는
  ``has_bind_password`` 만 싣는다. 로그·감사·응답 어디에도 평문 비밀번호를 넣지 않는다.
- referral 은 따라가지 않는다(``auto_referrals=False``) — 다른 호스트로 자격증명을 보내지 않게.
- ``ldaps://`` 와 StartTLS 는 기본으로 인증서를 검증한다(사설 CA 는 화면에 PEM 을 붙여 넣는다).

Fail-safe: ``ldap3`` 는 지연 import 한다. 모듈이 없거나 서버가 죽어 있어도 예외를 ``LdapError`` (사유
코드)로 감싸 돌려준다 — 앱과 로컬 로그인은 그대로 동작하고 HTTP 500 을 올리지 않는다.
"""
from __future__ import annotations

import logging
import re
import ssl
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from app.models.app_setting import AppSetting
from app.services import secret_box

logger = logging.getLogger("k8s_monitor.ldap")

SETTING_KEY = "auth.ldap"
# 이 계정이 마지막으로 LDAP 로 로그인했다는 표식 — ``user_settings`` 키(개인 설정 내보내기 허용 목록 밖).
AUTH_SOURCE_KEY = "auth_source"

PROVISION_ROLES = ("viewer", "operator")
PRIORITIES = ("local_first", "ldap_first")
BIND_MODES = ("direct", "search")
USERNAME_TOKEN = "{username}"
MIN_TIMEOUT, MAX_TIMEOUT = 1, 60

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    # 여러 개면 순서대로 시도한다(앞 서버에 연결되지 않을 때만 다음 서버).
    "server_urls": [],
    "start_tls": False,
    "tls_verify": True,
    # 사설 CA 인증서(PEM). 비우면 시스템 신뢰 저장소를 쓴다. 비밀값이 아니다.
    "ca_cert_pem": "",
    "timeout_seconds": 5,
    "bind_mode": "direct",
    "bind_dn_template": "",
    "service_bind_dn": "",
    "bind_password_encrypted": None,
    "user_search_base": "",
    "user_search_filter": "(sAMAccountName={username})",
    "display_name_attribute": "displayName",
    "email_attribute": "mail",
    "group_attribute": "memberOf",
    # 비우면 그룹 제한 없음. 채우면 사용자 항목의 group_attribute 값 중 하나가 일치해야 들인다(직접 소속만).
    "allowed_groups": [],
    "auto_provision": False,
    "default_role": "viewer",
    "priority": "local_first",
    # 로컬 비밀번호가 있는 admin 계정은 LDAP 로 로그인하지 않는다 — 디렉터리에 같은 이름의 계정
    # (admin·administrator 등)이 있어도 PEP 관리자 권한을 얻지 못하게. 끄면 admin 도 LDAP 를 시도한다.
    "protect_local_admins": True,
}

# 감사 로그·로그에 남기는 사유 코드(클라이언트에는 일반 문구만 돌려준다).
ERROR_CODES = (
    "disabled",
    "module_missing",
    "config_invalid",
    "server_unreachable",
    "tls_failed",
    "service_bind_failed",
    "empty_password",
    "invalid_username",
    "invalid_credentials",
    "user_not_found",
    "multiple_users",
    "search_failed",
    "group_denied",
    "ldap_error",
)
# 사용자 자격증명 탓이 아닌(인프라·설정) 실패 — 레이트리밋 실패 카운트에서 뺀다.
INFRA_CODES = frozenset({"module_missing", "config_invalid", "server_unreachable", "tls_failed",
                         "service_bind_failed", "search_failed", "ldap_error", "disabled"})

# AD 바인드 실패 메시지의 ``data XXX`` 하위 코드 — 운영자용 상세(감사)에만 쓴다.
_AD_SUBCODES = {
    "525": "AD: 사용자 없음",
    "52e": "AD: 비밀번호 불일치",
    "530": "AD: 허용되지 않은 로그인 시간",
    "531": "AD: 허용되지 않은 워크스테이션",
    "532": "AD: 비밀번호 만료",
    "533": "AD: 비활성 계정",
    "701": "AD: 계정 만료",
    "773": "AD: 비밀번호 재설정 필요",
    "775": "AD: 계정 잠김",
}

# UPN·도메인 형식 템플릿에 들어가면 다른 계정·도메인을 가리키게 되는 문자.
_UPN_FORBIDDEN = re.compile(r"[@\\/,=+<>#;\"*()\s]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class LdapError(Exception):
    """사유 코드(``code``)와 운영자용 설명(``detail`` — 비밀값 미포함)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code if code in ERROR_CODES else "ldap_error"
        self.detail = detail

    @property
    def infra(self) -> bool:
        return self.code in INFRA_CODES


@dataclass
class LdapIdentity:
    dn: str
    display_name: str | None = None
    email: str | None = None
    groups: list[str] = field(default_factory=list)
    server: str = ""


# ── ldap3 지연 import ─────────────────────────────────────────────────────


def _ldap3() -> SimpleNamespace | None:
    """쓰는 ldap3 심볼만 모은 namespace. 미설치면 None (테스트가 가짜로 바꿔 끼운다)."""
    try:
        import ldap3
        from ldap3.core import exceptions as exc
        from ldap3.utils.conv import escape_filter_chars
        from ldap3.utils.dn import escape_rdn
    except Exception:  # noqa: BLE001 — 미설치·깨진 설치 모두 "모듈 없음"으로 본다
        return None
    return SimpleNamespace(
        Server=ldap3.Server,
        Connection=ldap3.Connection,
        Tls=ldap3.Tls,
        SIMPLE=ldap3.SIMPLE,
        ANONYMOUS=ldap3.ANONYMOUS,
        SUBTREE=ldap3.SUBTREE,
        BASE=ldap3.BASE,
        NO_INFO=ldap3.NONE,
        LDAPException=exc.LDAPException,
        escape_filter_chars=escape_filter_chars,
        escape_rdn=escape_rdn,
    )


def module_available() -> bool:
    return _ldap3() is not None


def _require_lib() -> SimpleNamespace:
    lib = _ldap3()
    if lib is None:
        raise LdapError("module_missing", "ldap3 모듈이 설치돼 있지 않음(requirements.txt 의 ldap3)")
    return lib


# ── 설정 ─────────────────────────────────────────────────────────────────


def load_config(db: Session) -> dict[str, Any]:
    row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
    cfg = dict(DEFAULTS)
    if row is not None and isinstance(row.value, dict):
        for k in DEFAULTS:
            if k in row.value:
                cfg[k] = row.value[k]
    return cfg


def load_config_safe(db: Session) -> dict[str, Any]:
    """로그인 경로용 — 설정 행을 못 읽어도 로컬 로그인을 막지 않게 꺼진 기본값을 돌려준다."""
    try:
        return load_config(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ldap: 설정 조회 실패 — LDAP 로그인 비활성으로 처리: %s", type(exc).__name__)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return dict(DEFAULTS)


def _has_token(value: Any) -> bool:
    return USERNAME_TOKEN in str(value or "")


def is_ready(cfg: dict[str, Any]) -> bool:
    """로그인에 쓸 수 있는 상태 — 켜져 있고 서버·바인드 방식에 필요한 값이 채워져 있다."""
    if not cfg.get("enabled") or not cfg.get("server_urls"):
        return False
    if cfg.get("bind_mode") == "search":
        return bool(str(cfg.get("user_search_base") or "").strip()) and _has_token(cfg.get("user_search_filter"))
    return _has_token(cfg.get("bind_dn_template"))


def priority(cfg: dict[str, Any]) -> str:
    p = cfg.get("priority")
    return p if p in PRIORITIES else "local_first"


def admin_view(cfg: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in cfg.items() if k != "bind_password_encrypted"}
    out["has_bind_password"] = bool(cfg.get("bind_password_encrypted"))
    out["module_available"] = module_available()
    return out


def _split_list(raw: Any) -> list[str]:
    # 그룹 DN 에는 쉼표가 들어가므로 문자열은 줄 단위로만 나눈다.
    if isinstance(raw, str):
        raw = raw.splitlines()
    out: list[str] = []
    for item in raw or []:
        v = str(item).strip()
        if v and v not in out:
            out.append(v)
    return out


def _normalize_urls(raw: Any) -> list[str]:
    if isinstance(raw, str):
        raw = re.split(r"[\s,]+", raw)
    out: list[str] = []
    for item in raw or []:
        v = str(item).strip().rstrip("/")
        if not v:
            continue
        p = urlparse(v)
        if p.scheme not in ("ldap", "ldaps") or not p.hostname:
            raise ValueError(f"서버 주소 '{v[:80]}' 는 ldap:// 또는 ldaps:// 로 시작해야 합니다.")
        if p.path not in ("", "/") or p.query or p.fragment or p.username or p.password:
            raise ValueError(f"서버 주소 '{v[:80]}' 에는 호스트와 포트만 넣습니다(경로·계정 정보 불가).")
        try:
            _ = p.port
        except ValueError:
            raise ValueError(f"서버 주소 '{v[:80]}' 의 포트가 올바르지 않습니다.")
        if v not in out:
            out.append(v)
    if len(out) > 10:
        raise ValueError("서버 주소는 10개까지 넣을 수 있습니다.")
    return out


def _normalize_dn(dn: str) -> str:
    """그룹 DN 비교용 — 대소문자·쉼표 주변 공백 차이를 무시한다."""
    return re.sub(r"\s*,\s*", ",", str(dn or "").strip()).lower()


def merge_config(cfg: dict[str, Any], patch: dict[str, Any], *, require_ready: bool = True
                 ) -> tuple[dict[str, Any], list[str]]:
    """``patch`` 의 키만 바꾼 새 설정과 바뀐 필드 이름 목록(값 미포함)을 돌려준다. 저장하지 않는다.

    ``bind_password``: 문자열이 오면 교체(암호화), ``clear_bind_password=True`` 면 삭제, 없으면 유지.
    잘못된 값은 ``ValueError``(사람 문구)로 거절한다.
    """
    cfg = dict(cfg)
    changed: list[str] = []

    def _set(key: str, value: Any) -> None:
        if cfg.get(key) != value:
            cfg[key] = value
            changed.append(key)

    def _given(key: str) -> bool:
        return key in patch and patch[key] is not None

    for key in ("enabled", "start_tls", "tls_verify", "auto_provision", "protect_local_admins"):
        if _given(key):
            _set(key, bool(patch[key]))
    if _given("server_urls"):
        _set("server_urls", _normalize_urls(patch["server_urls"]))
    if _given("ca_cert_pem"):
        pem = str(patch["ca_cert_pem"]).strip()
        if pem and "-----BEGIN CERTIFICATE-----" not in pem:
            raise ValueError("CA 인증서는 -----BEGIN CERTIFICATE----- 로 시작하는 PEM 이어야 합니다.")
        _set("ca_cert_pem", pem)
    if _given("timeout_seconds"):
        try:
            t = int(patch["timeout_seconds"])
        except (TypeError, ValueError):
            raise ValueError("타임아웃은 초 단위 정수여야 합니다.")
        if not MIN_TIMEOUT <= t <= MAX_TIMEOUT:
            raise ValueError(f"타임아웃은 {MIN_TIMEOUT}~{MAX_TIMEOUT}초 사이로 넣습니다.")
        _set("timeout_seconds", t)
    if _given("bind_mode"):
        mode = str(patch["bind_mode"]).strip()
        if mode not in BIND_MODES:
            raise ValueError("바인드 방식은 direct(직접 바인드) 또는 search(검색 후 재바인드)만 고를 수 있습니다.")
        _set("bind_mode", mode)
    for key, limit in (("bind_dn_template", 512), ("service_bind_dn", 512), ("user_search_base", 512),
                       ("user_search_filter", 512)):
        if _given(key):
            v = str(patch[key]).strip()
            if len(v) > limit or _CONTROL.search(v):
                raise ValueError(f"{key} 값이 너무 길거나 제어 문자가 들어 있습니다.")
            _set(key, v)
    for key in ("display_name_attribute", "email_attribute", "group_attribute"):
        if _given(key):
            v = str(patch[key]).strip()
            if v and not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,63}", v):
                raise ValueError(f"{key} 는 LDAP 속성 이름(영문·숫자·-)이어야 합니다.")
            _set(key, v)
    if _given("allowed_groups"):
        groups = _split_list(patch["allowed_groups"])
        if any(_CONTROL.search(g) or len(g) > 512 for g in groups):
            raise ValueError("허용 그룹 DN 에 제어 문자가 들어 있거나 너무 깁니다.")
        _set("allowed_groups", groups)
    if _given("default_role"):
        role = str(patch["default_role"]).strip()
        if role not in PROVISION_ROLES:
            raise ValueError("자동 생성 계정의 기본 역할은 viewer 또는 operator 만 고를 수 있습니다.")
        _set("default_role", role)
    if _given("priority"):
        p = str(patch["priority"]).strip()
        if p not in PRIORITIES:
            raise ValueError("우선순위는 local_first 또는 ldap_first 만 고를 수 있습니다.")
        _set("priority", p)

    if patch.get("clear_bind_password"):
        if cfg.get("bind_password_encrypted"):
            cfg["bind_password_encrypted"] = None
            changed.append("bind_password")
    elif isinstance(patch.get("bind_password"), str) and patch["bind_password"]:
        if _CONTROL.search(patch["bind_password"]):
            raise ValueError("서비스 계정 비밀번호에 제어 문자가 들어 있습니다.")
        cfg["bind_password_encrypted"] = secret_box.encrypt(patch["bind_password"])
        changed.append("bind_password")

    # 교차 검증 — 켜져 있든 아니든 앞뒤가 맞지 않는 조합은 저장하지 않는다.
    urls = cfg.get("server_urls") or []
    if cfg.get("start_tls") and any(u.lower().startswith("ldaps://") for u in urls):
        raise ValueError("ldaps:// 주소에는 StartTLS 를 함께 쓸 수 없습니다(이미 TLS 연결입니다).")
    for key in ("bind_dn_template", "user_search_filter"):
        v = str(cfg.get(key) or "")
        if v and not _has_token(v):
            raise ValueError(f"{key} 에 {USERNAME_TOKEN} 자리를 넣으세요.")
    flt = str(cfg.get("user_search_filter") or "")
    if flt and not (flt.startswith("(") and flt.endswith(")") and flt.count("(") == flt.count(")")):
        raise ValueError("사용자 검색 필터는 괄호로 감싼 LDAP 필터여야 합니다. 예: (sAMAccountName={username})")
    if (require_ready and cfg.get("enabled") and cfg.get("bind_mode") == "search"
            and cfg.get("service_bind_dn") and not cfg.get("bind_password_encrypted")):
        raise ValueError("서비스 계정 DN 을 넣었으면 비밀번호도 저장하세요(빈 비밀번호 바인드는 거부됩니다).")
    if require_ready and cfg.get("enabled") and not is_ready(cfg):
        if cfg.get("bind_mode") == "search":
            raise ValueError("LDAP 로그인을 켜려면 서버 주소·사용자 검색 base·필터를 먼저 입력하세요.")
        raise ValueError("LDAP 로그인을 켜려면 서버 주소와 바인드 DN 템플릿을 먼저 입력하세요.")
    return cfg, changed


def save_config(db: Session, patch: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    cfg, changed = merge_config(load_config(db), patch)
    row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=cfg))
    else:
        row.value = cfg
    db.commit()
    return cfg, changed


def bind_password(cfg: dict[str, Any]) -> str | None:
    try:
        return secret_box.decrypt(cfg.get("bind_password_encrypted"))
    except ValueError:
        logger.warning("ldap: 서비스 계정 비밀번호 복호화 실패 — SECRET_KEY 가 바뀌었을 수 있다(다시 저장 필요)")
        return None


# ── 입력 검사·escape ─────────────────────────────────────────────────────


def password_acceptable(password: str | None) -> bool:
    """빈 값·공백뿐·NUL 이 든 비밀번호는 서버에 보내지 않는다(익명/unauthenticated bind 성공 오인 방지)."""
    return bool(password) and bool(password.strip()) and "\x00" not in password


def _check_username(username: str) -> str:
    u = (username or "").strip()
    if not u or len(u) > 64 or _CONTROL.search(u):
        raise LdapError("invalid_username", "사용자명이 비었거나 제어 문자가 들어 있음")
    return u


def bind_name(lib: SimpleNamespace, cfg: dict[str, Any], username: str) -> str:
    """직접 바인드에 쓸 이름. DN 템플릿이면 RDN escape, UPN·도메인 템플릿이면 구분 문자를 거절한다."""
    template = str(cfg.get("bind_dn_template") or "")
    u = _check_username(username)
    if "=" in template:
        return template.replace(USERNAME_TOKEN, lib.escape_rdn(u))
    if _UPN_FORBIDDEN.search(u):
        raise LdapError("invalid_username", "UPN/도메인 형식 바인드에 쓸 수 없는 문자가 든 사용자명")
    return template.replace(USERNAME_TOKEN, u)


def search_filter(lib: SimpleNamespace, cfg: dict[str, Any], username: str) -> str:
    u = _check_username(username)
    # str.format 이 아니라 replace — 필터 안의 다른 중괄호가 KeyError·포맷 주입이 되지 않게.
    return str(cfg.get("user_search_filter") or "").replace(USERNAME_TOKEN, lib.escape_filter_chars(u))


# ── 연결 ─────────────────────────────────────────────────────────────────


def _timeout(cfg: dict[str, Any]) -> int:
    try:
        t = int(cfg.get("timeout_seconds") or DEFAULTS["timeout_seconds"])
    except (TypeError, ValueError):
        t = DEFAULTS["timeout_seconds"]
    return max(MIN_TIMEOUT, min(MAX_TIMEOUT, t))


def _make_server(lib: SimpleNamespace, cfg: dict[str, Any], url: str) -> Any:
    p = urlparse(url)
    use_ssl = p.scheme == "ldaps"
    tls = None
    if use_ssl or cfg.get("start_tls"):
        kwargs: dict[str, Any] = {
            "validate": ssl.CERT_REQUIRED if cfg.get("tls_verify", True) is not False else ssl.CERT_NONE,
        }
        pem = str(cfg.get("ca_cert_pem") or "").strip()
        if pem:
            kwargs["ca_certs_data"] = pem
        tls = lib.Tls(**kwargs)
    return lib.Server(
        p.hostname, port=p.port, use_ssl=use_ssl, tls=tls, get_info=lib.NO_INFO,
        connect_timeout=_timeout(cfg),
    )


def _open(lib: SimpleNamespace, cfg: dict[str, Any], server: Any, *, user: str | None,
          password: str | None) -> Any:
    """연결을 열고(필요하면 StartTLS) 아직 바인드하지 않은 Connection 을 돌려준다.

    연결 실패는 ``server_unreachable``, TLS 협상 실패는 ``tls_failed`` 로 올린다.
    """
    kwargs: dict[str, Any] = {
        "auto_bind": False,
        "read_only": True,
        "raise_exceptions": False,
        "auto_referrals": False,
        "receive_timeout": _timeout(cfg),
    }
    if user:
        kwargs.update(user=user, password=password, authentication=lib.SIMPLE)
    else:
        kwargs.update(authentication=lib.ANONYMOUS)
    try:
        conn = lib.Connection(server, **kwargs)
    except lib.LDAPException as exc:
        raise LdapError("ldap_error", f"연결 객체 생성 실패: {type(exc).__name__}")
    try:
        conn.open()
    except ssl.SSLError as exc:
        raise LdapError("tls_failed", f"TLS 협상 실패: {type(exc).__name__}")
    except (lib.LDAPException, OSError) as exc:
        text = str(exc)
        if "ssl" in text.lower() or "certificate" in text.lower():
            raise LdapError("tls_failed", f"TLS 협상 실패: {type(exc).__name__}")
        raise LdapError("server_unreachable", f"연결 실패: {type(exc).__name__}")
    if cfg.get("start_tls"):
        try:
            ok = conn.start_tls()
        except (lib.LDAPException, ssl.SSLError, OSError) as exc:
            _close(conn)
            raise LdapError("tls_failed", f"StartTLS 실패: {type(exc).__name__}")
        if not ok:
            _close(conn)
            raise LdapError("tls_failed", "StartTLS 거부됨")
    return conn


def _close(conn: Any) -> None:
    try:
        conn.unbind()
    except Exception:  # noqa: BLE001
        pass


def _bind(lib: SimpleNamespace, conn: Any) -> tuple[bool, str]:
    """(성공 여부, 운영자용 사유). 서버가 끊기면 ``server_unreachable``."""
    try:
        ok = bool(conn.bind())
    except (lib.LDAPException, OSError) as exc:
        name = type(exc).__name__
        if "Password" in name:
            return False, "빈 비밀번호 거부"
        raise LdapError("server_unreachable", f"바인드 중 연결 끊김: {name}")
    if ok:
        return True, ""
    result = getattr(conn, "result", None) or {}
    code = result.get("result")
    message = str(result.get("message") or "")
    m = re.search(r"data ([0-9a-fA-F]{3})", message)
    sub = _AD_SUBCODES.get(m.group(1).lower()) if m else None
    return False, f"LDAP result {code} {result.get('description') or ''}".strip() + (f" · {sub}" if sub else "")


def _connect_any(lib: SimpleNamespace, cfg: dict[str, Any], *, user: str | None, password: str | None,
                 log: list[dict[str, Any]] | None = None) -> tuple[Any, Any, str]:
    """서버 목록을 순서대로 시도해 처음 연결되는 서버의 (Connection, Server, url) 을 돌려준다."""
    urls = list(cfg.get("server_urls") or [])
    if not urls:
        raise LdapError("config_invalid", "서버 주소가 없음")
    last: LdapError | None = None
    for url in urls:
        t0 = time.perf_counter()
        try:
            server = _make_server(lib, cfg, url)
            conn = _open(lib, cfg, server, user=user, password=password)
        except LdapError as exc:
            last = exc
            if log is not None:
                log.append({"name": "connect", "ok": False, "detail": f"{url} — {exc.detail}"})
            logger.info("ldap: %s 연결 실패 — %s", url, exc.detail)
            continue
        except Exception as exc:  # noqa: BLE001
            last = LdapError("server_unreachable", f"연결 실패: {type(exc).__name__}")
            if log is not None:
                log.append({"name": "connect", "ok": False, "detail": f"{url} — {last.detail}"})
            continue
        if log is not None:
            tls = "ldaps" if url.lower().startswith("ldaps://") else ("StartTLS" if cfg.get("start_tls") else "평문")
            log.append({"name": "connect", "ok": True,
                        "detail": f"{url} · {tls} · {int((time.perf_counter() - t0) * 1000)}ms"})
        return conn, server, url
    assert last is not None
    if len(urls) > 1:
        raise LdapError(last.code, f"서버 {len(urls)}곳 모두 실패 — 마지막: {last.detail}")
    raise last


def _first(values: Any) -> str | None:
    if isinstance(values, (list, tuple)):
        values = values[0] if values else None
    if isinstance(values, bytes):
        try:
            values = values.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if values is None:
        return None
    s = str(values).strip()
    return s or None


def _all(values: Any) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, (list, tuple)):
        values = [values]
    out = []
    for v in values:
        s = _first(v)
        if s:
            out.append(s)
    return out


def _attr_names(cfg: dict[str, Any]) -> list[str]:
    names = [cfg.get("display_name_attribute"), cfg.get("email_attribute"), cfg.get("group_attribute")]
    return [n for n in dict.fromkeys(str(n).strip() for n in names if n) if n]


def _entries(conn: Any) -> list[dict[str, Any]]:
    out = []
    for item in getattr(conn, "response", None) or []:
        if isinstance(item, Mapping) and item.get("type") == "searchResEntry" and item.get("dn"):
            out.append(item)
    return out


def _search_user(lib: SimpleNamespace, cfg: dict[str, Any], conn: Any, username: str) -> dict[str, Any]:
    flt = search_filter(lib, cfg, username)
    base = str(cfg.get("user_search_base") or "")
    try:
        ok = conn.search(search_base=base, search_filter=flt, search_scope=lib.SUBTREE,
                         attributes=_attr_names(cfg), size_limit=2)
    except (lib.LDAPException, OSError) as exc:
        raise LdapError("search_failed", f"사용자 검색 실패: {type(exc).__name__}")
    entries = _entries(conn)
    result = getattr(conn, "result", None) or {}
    # size_limit 초과(4)는 2건 이상이라는 뜻 — 결과 판정은 항목 수로 한다.
    if not ok and not entries and result.get("result") not in (0, 4, 32, None):
        raise LdapError("search_failed", f"사용자 검색 실패: LDAP result {result.get('result')} "
                                         f"{result.get('description') or ''}".strip())
    if not entries:
        raise LdapError("user_not_found", "검색 결과 없음")
    if len(entries) > 1:
        raise LdapError("multiple_users", "검색 결과가 2건 이상 — 필터를 좁히세요")
    return entries[0]


def _read_self(lib: SimpleNamespace, cfg: dict[str, Any], conn: Any, dn: str, username: str) -> dict[str, Any] | None:
    """직접 바인드 뒤 사용자 본인 연결로 속성을 읽는다(실패해도 로그인은 계속 — 속성만 빈다)."""
    try:
        if "=" in dn:
            ok = conn.search(search_base=dn, search_filter="(objectClass=*)", search_scope=lib.BASE,
                             attributes=_attr_names(cfg), size_limit=1)
        elif cfg.get("user_search_base") and _has_token(cfg.get("user_search_filter")):
            ok = conn.search(search_base=str(cfg["user_search_base"]), search_filter=search_filter(lib, cfg, username),
                             search_scope=lib.SUBTREE, attributes=_attr_names(cfg), size_limit=2)
        else:
            return None
    except Exception as exc:  # noqa: BLE001
        logger.info("ldap: 사용자 속성 조회 실패 — %s", type(exc).__name__)
        return None
    entries = _entries(conn)
    if not ok and not entries:
        return None
    return entries[0] if len(entries) == 1 else None


def _identity(cfg: dict[str, Any], entry: dict[str, Any] | None, dn: str, url: str) -> LdapIdentity:
    attrs = (entry or {}).get("attributes") or {}
    # ldap3 의 attributes 는 dict 가 아니라 CaseInsensitiveDict(Mapping) 다.
    lower = {str(k).lower(): v for k, v in attrs.items()} if isinstance(attrs, Mapping) else {}

    def get(name: Any) -> Any:
        return lower.get(str(name or "").lower()) if name else None

    display = _first(get(cfg.get("display_name_attribute")))
    email = _first(get(cfg.get("email_attribute")))
    return LdapIdentity(
        dn=str((entry or {}).get("dn") or dn),
        display_name=display[:128] if display else None,
        email=email[:255] if email and "@" in email else None,
        groups=_all(get(cfg.get("group_attribute"))),
        server=url,
    )


def group_allowed(cfg: dict[str, Any], groups: list[str]) -> bool:
    allowed = {_normalize_dn(g) for g in (cfg.get("allowed_groups") or []) if str(g).strip()}
    if not allowed:
        return True
    return any(_normalize_dn(g) in allowed for g in groups)


# ── 인증 ─────────────────────────────────────────────────────────────────


def authenticate(cfg: dict[str, Any], username: str, password: str) -> LdapIdentity:
    """LDAP 로 ``username``/``password`` 를 확인한다. 실패는 전부 ``LdapError``(사유 코드).

    성공 시 사용자 DN·표시 이름·이메일·그룹을 돌려준다. 비밀번호는 어디에도 기록하지 않는다.
    """
    try:
        return _authenticate(cfg, username, password)
    except LdapError:
        raise
    except Exception as exc:  # noqa: BLE001 — 예상 밖 예외도 로그인 500 이 되지 않게
        logger.warning("ldap: 예상 밖 오류 — %s", type(exc).__name__)
        raise LdapError("ldap_error", f"예상 밖 오류: {type(exc).__name__}")


def _authenticate(cfg: dict[str, Any], username: str, password: str) -> LdapIdentity:
    if not is_ready(cfg):
        raise LdapError("disabled", "LDAP 로그인이 꺼져 있거나 설정이 비어 있음")
    if not password_acceptable(password):
        raise LdapError("empty_password", "빈 비밀번호는 바인드하지 않음")
    lib = _require_lib()

    if cfg.get("bind_mode") == "search":
        svc_dn = str(cfg.get("service_bind_dn") or "").strip()
        svc_pw = bind_password(cfg) if svc_dn else None
        if svc_dn and not password_acceptable(svc_pw):
            raise LdapError("service_bind_failed", "서비스 계정 비밀번호가 없음(빈 비밀번호 바인드 거부)")
        # 사용자명 검사·escape 를 서버 접속 전에 끝낸다.
        search_filter(lib, cfg, username)
        conn, server, url = _connect_any(lib, cfg, user=svc_dn or None, password=svc_pw)
        try:
            ok, why = _bind(lib, conn)
            if not ok:
                raise LdapError("service_bind_failed", f"서비스 계정 바인드 실패: {why}")
            entry = _search_user(lib, cfg, conn, username)
        finally:
            _close(conn)
        dn = str(entry["dn"])
        user_conn = _open(lib, cfg, server, user=dn, password=password)
        try:
            ok, why = _bind(lib, user_conn)
        finally:
            _close(user_conn)
        if not ok:
            raise LdapError("invalid_credentials", f"사용자 바인드 실패: {why}")
        ident = _identity(cfg, entry, dn, url)
    else:
        name = bind_name(lib, cfg, username)
        conn, _server, url = _connect_any(lib, cfg, user=name, password=password)
        try:
            ok, why = _bind(lib, conn)
            if not ok:
                raise LdapError("invalid_credentials", f"사용자 바인드 실패: {why}")
            entry = _read_self(lib, cfg, conn, name, username)
        finally:
            _close(conn)
        if entry is None and cfg.get("allowed_groups"):
            raise LdapError("group_denied", "그룹 제한이 켜져 있는데 사용자 항목(그룹 속성)을 읽지 못함")
        ident = _identity(cfg, entry, name, url)

    if not group_allowed(cfg, ident.groups):
        raise LdapError("group_denied", "허용 그룹에 속하지 않음")
    return ident


# ── 연결 확인 (Settings "연결 확인") ─────────────────────────────────────────


def check_connection(cfg: dict[str, Any], test_username: str | None = None) -> dict[str, Any]:
    """서버 연결 → 서비스 바인드 → (선택) 사용자 검색을 단계별로 확인한다. 예외 없이 결과를 돌려준다.

    테스트 사용자는 **비밀번호 없이 검색만** 한다 — 사용자 바인드는 하지 않는다.
    """
    steps: list[dict[str, Any]] = []
    out: dict[str, Any] = {"ok": False, "steps": steps}
    try:
        return _check_connection(cfg, test_username, steps, out)
    except LdapError as exc:
        steps.append({"name": "error", "ok": False, "detail": exc.detail or exc.code})
        return out
    except Exception as exc:  # noqa: BLE001
        steps.append({"name": "error", "ok": False, "detail": f"예상 밖 오류: {type(exc).__name__}"})
        return out


def _check_connection(cfg: dict[str, Any], test_username: str | None, steps: list[dict[str, Any]],
                      out: dict[str, Any]) -> dict[str, Any]:
    lib = _ldap3()
    if lib is None:
        steps.append({"name": "module", "ok": False,
                      "detail": "ldap3 모듈이 설치돼 있지 않음 — 백엔드 이미지에 requirements.txt 를 다시 설치하세요"})
        return out
    if not cfg.get("server_urls"):
        steps.append({"name": "config", "ok": False, "detail": "서버 주소를 입력하세요"})
        return out
    mode = cfg.get("bind_mode") if cfg.get("bind_mode") in BIND_MODES else "direct"
    warnings: list[str] = []
    if any(u.lower().startswith("ldap://") for u in cfg["server_urls"]) and not cfg.get("start_tls"):
        warnings.append("ldap:// + StartTLS 꺼짐 — 비밀번호가 평문으로 전송됩니다")
    if cfg.get("tls_verify") is False:
        warnings.append("TLS 인증서 검증 꺼짐")
    out["warnings"] = warnings

    svc_dn = str(cfg.get("service_bind_dn") or "").strip() if mode == "search" else ""
    svc_pw = bind_password(cfg) if svc_dn else None
    if svc_dn and not password_acceptable(svc_pw):
        steps.append({"name": "service_bind", "ok": False,
                      "detail": "서비스 계정 비밀번호가 저장돼 있지 않음(빈 비밀번호 바인드는 하지 않음)"})
        return out

    conn, _server, url = _connect_any(lib, cfg, user=svc_dn or None, password=svc_pw, log=steps)
    out["server"] = url
    try:
        if mode == "search":
            t0 = time.perf_counter()
            ok, why = _bind(lib, conn)
            if not ok:
                steps.append({"name": "service_bind", "ok": False, "detail": f"{svc_dn or '익명'} — {why}"})
                return out
            steps.append({"name": "service_bind", "ok": True,
                          "detail": f"{svc_dn or '익명 바인드'} · {int((time.perf_counter() - t0) * 1000)}ms"})
        else:
            steps.append({"name": "service_bind", "ok": True,
                          "detail": "직접 바인드 방식 — 서비스 계정 바인드 없음(로그인 때 사용자 이름으로 바로 바인드)"})

        name = (test_username or "").strip()
        if not name:
            steps.append({"name": "user_search", "ok": True, "detail": "테스트 사용자명 없음 — 검색 생략"})
            out["ok"] = True
            return out
        if mode == "direct":
            dn = bind_name(lib, cfg, name)
            steps.append({"name": "user_search", "ok": True,
                          "detail": f"바인드 이름: {dn} (비밀번호 없이 확인할 수 없어 바인드는 하지 않음)"})
            out["user"] = {"dn": dn}
            out["ok"] = True
            return out
        t1 = time.perf_counter()
        try:
            entry = _search_user(lib, cfg, conn, name)
        except LdapError as exc:
            steps.append({"name": "user_search", "ok": False, "detail": f"{search_filter(lib, cfg, name)} — {exc.detail}"})
            return out
        ident = _identity(cfg, entry, str(entry["dn"]), url)
        allowed = group_allowed(cfg, ident.groups)
        out["user"] = {
            "dn": ident.dn, "display_name": ident.display_name, "email": ident.email,
            "groups": ident.groups[:50], "group_allowed": allowed,
        }
        steps.append({"name": "user_search", "ok": True,
                      "detail": f"{ident.dn} · {int((time.perf_counter() - t1) * 1000)}ms"})
        if cfg.get("allowed_groups"):
            steps.append({"name": "group", "ok": allowed,
                          "detail": "허용 그룹 소속" if allowed else "허용 그룹에 속하지 않음 — 이 사용자는 로그인할 수 없음"})
        out["ok"] = allowed
        return out
    finally:
        _close(conn)
