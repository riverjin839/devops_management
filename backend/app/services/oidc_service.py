"""사내 IdP SSO(OpenID Connect) 로그인 — 설정·임시 상태 저장·IdP 호출·id_token 검증 (D-079·R-7).

비밀번호 로그인(``/auth/login``)은 그대로 두고 Authorization Code + PKCE 흐름을 하나 더 연다.
환경값(issuer·client·claim 이름·자동 생성 정책)은 코드가 아니라 Settings ▸ 접근 제어 화면에서
고친다 — ``AppSetting`` 키 ``auth.oidc`` (UI-First).

보안 요점
- client secret 은 ``secret_box`` 로 암호화해 ``client_secret_encrypted`` 에만 둔다. 조회 응답에는
  ``has_secret`` 만 싣는다. 로그·감사·응답 어디에도 평문·토큰·code 를 넣지 않는다.
- state·nonce·PKCE verifier 는 서버 쪽 임시 저장소(Redis, TTL 10분)에 두고 1회 소비한다. 브라우저에는
  추측 불가한 바인딩 쿠키를 함께 심어 다른 브라우저로 넘어온 콜백(로그인 CSRF)을 거절한다.
- id_token 은 discovery 의 JWKS 로 서명 검증한다. 알고리즘은 discovery 지원 목록 중 RS*/ES* 만 —
  HS*(client secret 을 키로 쓰는 대칭 서명)·none 은 거부한다. iss·aud·exp·iat·nonce 필수.
- 우리 JWT 는 URL 에 싣지 않는다 — 1회용 handoff code(TTL 60초)로 프론트가 POST 교환한다.

외부 호출(discovery·JWKS·token·userinfo)은 전부 타임아웃을 두고 예외를 ``OidcError`` 로 감싼다 —
라우터가 사유 코드로 로그인 화면에 돌려보낸다(HTTP 500 을 올리지 않는다).
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import threading
import time
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
import jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.models.app_setting import AppSetting
from app.services import secret_box

logger = logging.getLogger("k8s_monitor.oidc")

SETTING_KEY = "auth.oidc"

STATE_TTL_SECONDS = 10 * 60
HANDOFF_TTL_SECONDS = 60
HTTP_TIMEOUT_SECONDS = 10.0
METADATA_CACHE_SECONDS = 5 * 60
CLOCK_LEEWAY_SECONDS = 60

# 비대칭 서명만 허용 — HS*(대칭)는 client secret 을 아는 쪽이 위조할 수 있고 none 은 서명이 없다.
ALLOWED_ALGS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512")
PROVISION_ROLES = ("viewer", "operator")

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "display_name": "사내 SSO",
    "issuer": "",
    "client_id": "",
    "client_secret_encrypted": None,
    "scopes": "openid profile email",
    "username_claim": "preferred_username",
    "display_name_claim": "name",
    "email_claim": "email",
    "auto_provision": False,
    "default_role": "viewer",
    "allowed_domains": [],
    # 허용 도메인이 있을 때 IdP 가 이메일을 검증했다고(``email_verified: true``) 밝혀야 들인다 — 사용자가
    # 직접 고칠 수 있는 이메일로 도메인 정책을 우회하지 못하게. email_verified 를 내지 않는 IdP 만 끈다.
    "require_email_verified": True,
    "public_base_url": "",
}

# 프론트가 사람 문구로 바꾸는 사유 코드(``/auth/callback?error=``).
ERROR_CODES = (
    "disabled",
    "rate_limited",
    "state_invalid",
    "idp_error",
    "discovery_failed",
    "token_exchange_failed",
    "id_token_invalid",
    "nonce_mismatch",
    "claim_missing",
    "domain_not_allowed",
    "email_unverified",
    "user_not_found",
    "user_inactive",
    "provision_failed",
)


class OidcError(Exception):
    """사유 코드(``code``)와 운영자용 설명(``detail`` — 비밀값 미포함)을 함께 든다."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code if code in ERROR_CODES else "idp_error"
        self.detail = detail


# ── 설정 ─────────────────────────────────────────────────────────────────


def load_config(db: Session) -> dict[str, Any]:
    row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
    cfg = dict(DEFAULTS)
    if row is not None and isinstance(row.value, dict):
        for k in DEFAULTS:
            if k in row.value:
                cfg[k] = row.value[k]
    return cfg


def is_ready(cfg: dict[str, Any]) -> bool:
    """로그인 버튼을 띄워도 되는 상태 — 켜져 있고 issuer·client_id 가 채워져 있다."""
    return bool(cfg.get("enabled")) and bool(str(cfg.get("issuer") or "").strip()) and bool(
        str(cfg.get("client_id") or "").strip()
    )


def public_view(cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": is_ready(cfg),
        "display_name": str(cfg.get("display_name") or DEFAULTS["display_name"]),
    }


def admin_view(cfg: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in cfg.items() if k != "client_secret_encrypted"}
    out["has_secret"] = bool(cfg.get("client_secret_encrypted"))
    return out


def _normalize_domains(raw: Any) -> list[str]:
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    out: list[str] = []
    for d in raw or []:
        v = str(d).strip().lower().lstrip("@")
        if v and v not in out:
            out.append(v)
    return out


def _validate_url(value: str, field: str, *, allow_empty: bool) -> str:
    v = (value or "").strip().rstrip("/")
    if not v:
        if allow_empty:
            return ""
        raise ValueError(f"{field} 를 입력하세요.")
    p = urlparse(v)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise ValueError(f"{field} 는 http(s):// 로 시작하는 주소여야 합니다.")
    if p.query or p.fragment:
        raise ValueError(f"{field} 에는 query·fragment 를 넣을 수 없습니다.")
    return v


def save_config(db: Session, patch: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """``patch`` 의 키만 바꿔 저장한다. (새 설정, 바뀐 필드 이름 목록 — 감사 로그용, 값 미포함).

    ``client_secret``: 문자열이 오면 교체(암호화), ``clear_client_secret=True`` 면 삭제, 없으면 유지.
    잘못된 값은 ``ValueError``(사람 문구)로 거절한다.
    """
    cfg = load_config(db)
    changed: list[str] = []

    def _set(key: str, value: Any) -> None:
        if cfg.get(key) != value:
            cfg[key] = value
            changed.append(key)

    if "enabled" in patch and patch["enabled"] is not None:
        _set("enabled", bool(patch["enabled"]))
    if patch.get("display_name") is not None:
        name = str(patch["display_name"]).strip()[:64]
        _set("display_name", name or DEFAULTS["display_name"])
    if patch.get("issuer") is not None:
        _set("issuer", _validate_url(str(patch["issuer"]), "Issuer", allow_empty=True))
    if patch.get("client_id") is not None:
        _set("client_id", str(patch["client_id"]).strip()[:255])
    if patch.get("public_base_url") is not None:
        _set("public_base_url", _validate_url(str(patch["public_base_url"]), "공개 주소", allow_empty=True))
    if patch.get("scopes") is not None:
        parts = [s for s in str(patch["scopes"]).replace(",", " ").split() if s]
        if "openid" not in parts:
            parts.insert(0, "openid")
        _set("scopes", " ".join(dict.fromkeys(parts)))
    for key in ("username_claim", "display_name_claim", "email_claim"):
        if patch.get(key) is not None:
            v = str(patch[key]).strip()[:64]
            if key == "username_claim" and not v:
                raise ValueError("사용자명 claim 은 비울 수 없습니다.")
            _set(key, v)
    if "auto_provision" in patch and patch["auto_provision"] is not None:
        _set("auto_provision", bool(patch["auto_provision"]))
    if patch.get("default_role") is not None:
        role = str(patch["default_role"]).strip()
        if role not in PROVISION_ROLES:
            raise ValueError("자동 생성 계정의 기본 역할은 viewer 또는 operator 만 고를 수 있습니다.")
        _set("default_role", role)
    if patch.get("allowed_domains") is not None:
        _set("allowed_domains", _normalize_domains(patch["allowed_domains"]))
    if "require_email_verified" in patch and patch["require_email_verified"] is not None:
        _set("require_email_verified", bool(patch["require_email_verified"]))

    if patch.get("clear_client_secret"):
        if cfg.get("client_secret_encrypted"):
            cfg["client_secret_encrypted"] = None
            changed.append("client_secret")
    elif isinstance(patch.get("client_secret"), str) and patch["client_secret"].strip():
        cfg["client_secret_encrypted"] = secret_box.encrypt(patch["client_secret"].strip())
        changed.append("client_secret")

    if cfg.get("enabled") and not is_ready(cfg):
        raise ValueError("SSO 를 켜려면 Issuer 와 Client ID 를 먼저 입력하세요.")

    row = db.query(AppSetting).filter(AppSetting.key == SETTING_KEY).first()
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=cfg))
    else:
        row.value = cfg
    db.commit()
    if "issuer" in changed:
        _metadata_cache.clear()
    return cfg, changed


def client_secret(cfg: dict[str, Any]) -> str | None:
    try:
        return secret_box.decrypt(cfg.get("client_secret_encrypted"))
    except ValueError:
        logger.warning("oidc: client secret 복호화 실패 — SECRET_KEY 가 바뀌었을 수 있다(다시 저장 필요)")
        return None


# ── 임시 상태 저장소 (state / handoff) ──────────────────────────────────────
#
# Redis 는 Celery 브로커로 이미 필수 인프라라 다중 replica 에서 공유된다. 응답하지 않으면 프로세스
# 메모리로 폴백한다(단일 replica·로컬 개발에서만 정상 — 경고 로그를 남긴다).


class _MemoryStore:
    def __init__(self) -> None:
        self._data: dict[str, tuple[float, str]] = {}
        self._lock = threading.Lock()

    def put(self, key: str, value: str, ttl: int) -> None:
        with self._lock:
            now = time.time()
            for k in [k for k, (exp, _) in self._data.items() if exp <= now]:
                self._data.pop(k, None)
            self._data[key] = (now + ttl, value)

    def pop(self, key: str) -> str | None:
        with self._lock:
            item = self._data.pop(key, None)
        if item is None or item[0] <= time.time():
            return None
        return item[1]


_memory = _MemoryStore()
_redis_client: Any = None
_fallback_logged = False


def _redis():
    global _redis_client
    if _redis_client is None:
        try:
            import redis as _r

            _redis_client = _r.Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=1)
        except Exception:  # noqa: BLE001
            _redis_client = False
    return _redis_client


def _warn_fallback(exc: Exception | None = None) -> None:
    global _fallback_logged
    if not _fallback_logged:
        logger.warning("oidc: Redis 사용 불가 — 로그인 상태를 프로세스 메모리에 둔다(단일 replica 전용): %s", exc)
        _fallback_logged = True


def store_put(key: str, value: dict[str, Any], ttl: int) -> None:
    raw = json.dumps(value)
    client = _redis()
    if client:
        try:
            client.set(f"oidc:{key}", raw, ex=ttl)
            return
        except Exception as exc:  # noqa: BLE001
            _warn_fallback(exc)
    else:
        _warn_fallback()
    _memory.put(key, raw, ttl)


def store_pop(key: str) -> dict[str, Any] | None:
    """1회 소비 — 읽으면서 지운다(같은 값으로 두 번 성공하지 않는다)."""
    raw: Any = None
    client = _redis()
    if client:
        try:
            try:
                raw = client.getdel(f"oidc:{key}")
            except Exception:  # noqa: BLE001 — GETDEL 미지원(Redis < 6.2)
                pipe = client.pipeline()
                pipe.get(f"oidc:{key}")
                pipe.delete(f"oidc:{key}")
                raw = pipe.execute()[0]
        except Exception as exc:  # noqa: BLE001
            _warn_fallback(exc)
            raw = None
    if raw is None:
        raw = _memory.pop(key)
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


# ── PKCE·난수 ────────────────────────────────────────────────────────────


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def binding_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def safe_return_to(value: str | None) -> str:
    """앱 내부 경로만 허용 — 오픈 리다이렉트 방지(``//host``·``\\``·스킴 거부)."""
    v = (value or "").strip()
    if not v.startswith("/") or v.startswith("//") or "\\" in v or len(v) > 512:
        return "/"
    if v.startswith("/auth/callback"):
        return "/"
    return v


# ── IdP 호출 (fail-safe) ──────────────────────────────────────────────────

# 테스트가 httpx.MockTransport 를 끼운다.
_transport: httpx.BaseTransport | None = None
_metadata_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _client() -> httpx.Client:
    return httpx.Client(timeout=HTTP_TIMEOUT_SECONDS, transport=_transport, follow_redirects=False)


def _get_json(url: str, *, what: str, code: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    try:
        with _client() as c:
            r = c.get(url, headers=headers or {"Accept": "application/json"})
    except httpx.TimeoutException:
        raise OidcError(code, f"{what} 응답 시간 초과({HTTP_TIMEOUT_SECONDS:.0f}초)")
    except httpx.HTTPError as exc:
        raise OidcError(code, f"{what} 연결 실패: {type(exc).__name__}")
    if r.status_code != 200:
        raise OidcError(code, f"{what} HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError:
        raise OidcError(code, f"{what} 응답이 JSON 이 아님")
    if not isinstance(data, dict):
        raise OidcError(code, f"{what} 응답 형식 오류")
    return data


def discover(issuer: str, *, force: bool = False) -> dict[str, Any]:
    issuer = issuer.rstrip("/")
    now = time.time()
    cached = _metadata_cache.get(f"disc:{issuer}")
    if cached and not force and cached[0] > now:
        return cached[1]
    meta = _get_json(f"{issuer}/.well-known/openid-configuration", what="Discovery", code="discovery_failed")
    for field in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not isinstance(meta.get(field), str) or not meta.get(field):
            raise OidcError("discovery_failed", f"Discovery 응답에 {field} 가 없음")
    if meta["issuer"].rstrip("/") != issuer:
        raise OidcError("discovery_failed", f"Discovery issuer 불일치: 설정 {issuer} ≠ 응답 {meta['issuer']}")
    _metadata_cache[f"disc:{issuer}"] = (now + METADATA_CACHE_SECONDS, meta)
    return meta


def fetch_jwks(jwks_uri: str, *, force: bool = False) -> dict[str, Any]:
    now = time.time()
    cached = _metadata_cache.get(f"jwks:{jwks_uri}")
    if cached and not force and cached[0] > now:
        return cached[1]
    data = _get_json(jwks_uri, what="JWKS", code="discovery_failed")
    if not isinstance(data.get("keys"), list):
        raise OidcError("discovery_failed", "JWKS 응답에 keys 가 없음")
    _metadata_cache[f"jwks:{jwks_uri}"] = (now + METADATA_CACHE_SECONDS, data)
    return data


def allowed_algs(meta: dict[str, Any]) -> list[str]:
    supported = meta.get("id_token_signing_alg_values_supported") or ["RS256"]
    return [a for a in supported if a in ALLOWED_ALGS]


def authorize_url(meta: dict[str, Any], cfg: dict[str, Any], *, redirect_uri: str, state: str, nonce: str,
                  verifier: str) -> str:
    params = {
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "scope": cfg.get("scopes") or DEFAULTS["scopes"],
        "state": state,
        "nonce": nonce,
        "code_challenge": pkce_challenge(verifier),
        "code_challenge_method": "S256",
    }
    endpoint = meta["authorization_endpoint"]
    sep = "&" if "?" in endpoint else "?"
    return f"{endpoint}{sep}{urlencode(params)}"


def exchange_code(meta: dict[str, Any], cfg: dict[str, Any], *, code: str, redirect_uri: str,
                  verifier: str) -> dict[str, Any]:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": cfg["client_id"],
        "code_verifier": verifier,
    }
    auth: tuple[str, str] | None = None
    secret = client_secret(cfg)
    if secret:
        methods = meta.get("token_endpoint_auth_methods_supported") or ["client_secret_basic"]
        if "client_secret_basic" in methods:
            auth = (cfg["client_id"], secret)
        else:
            form["client_secret"] = secret
    try:
        with _client() as c:
            r = c.post(meta["token_endpoint"], data=form, auth=auth, headers={"Accept": "application/json"})
    except httpx.TimeoutException:
        raise OidcError("token_exchange_failed", "토큰 엔드포인트 응답 시간 초과")
    except httpx.HTTPError as exc:
        raise OidcError("token_exchange_failed", f"토큰 엔드포인트 연결 실패: {type(exc).__name__}")
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code != 200 or not isinstance(data, dict):
        err = data.get("error") if isinstance(data, dict) else None
        raise OidcError("token_exchange_failed", f"토큰 엔드포인트 HTTP {r.status_code}{f' ({err})' if err else ''}")
    if not isinstance(data.get("id_token"), str):
        raise OidcError("token_exchange_failed", "토큰 응답에 id_token 이 없음")
    return data


def _signing_key(meta: dict[str, Any], kid: str | None, alg: str) -> Any:
    for attempt in (False, True):  # kid 를 못 찾으면 키 교체로 보고 한 번 다시 받는다
        jwks = fetch_jwks(meta["jwks_uri"], force=attempt)
        try:
            keyset = jwt.PyJWKSet.from_dict(jwks)
        except jwt.PyJWTError as exc:
            raise OidcError("id_token_invalid", f"JWKS 해석 실패: {type(exc).__name__}")
        candidates = [k for k in keyset.keys if (kid is None or k.key_id == kid)]
        candidates = [k for k in candidates if not getattr(k, "public_key_use", None) or k.public_key_use == "sig"]
        if candidates:
            if kid is None and len(candidates) > 1:
                # kid 가 없으면 alg 가 맞는 키만 남긴다(키 종류가 섞인 JWKS).
                typed = [k for k in candidates if getattr(k, "algorithm_name", None) == alg]
                candidates = typed or candidates
            return candidates[0].key
    raise OidcError("id_token_invalid", f"서명 키(kid={kid})를 JWKS 에서 찾지 못함")


def verify_id_token(meta: dict[str, Any], cfg: dict[str, Any], id_token: str, *, nonce: str) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError:
        raise OidcError("id_token_invalid", "id_token 형식 오류")
    alg = header.get("alg")
    algs = allowed_algs(meta)
    if alg not in algs:
        raise OidcError("id_token_invalid", f"허용되지 않은 서명 알고리즘: {alg} (허용 {', '.join(algs) or '없음'})")
    key = _signing_key(meta, header.get("kid"), alg)
    try:
        claims = jwt.decode(
            id_token,
            key,
            algorithms=[alg],
            audience=cfg["client_id"],
            issuer=meta["issuer"],
            leeway=CLOCK_LEEWAY_SECONDS,
            options={"require": ["iss", "aud", "exp", "iat", "sub"]},
        )
    except jwt.ExpiredSignatureError:
        raise OidcError("id_token_invalid", "id_token 만료")
    except jwt.InvalidAudienceError:
        raise OidcError("id_token_invalid", "id_token aud 불일치")
    except jwt.InvalidIssuerError:
        raise OidcError("id_token_invalid", "id_token iss 불일치")
    except jwt.PyJWTError as exc:
        raise OidcError("id_token_invalid", f"id_token 검증 실패: {type(exc).__name__}")
    aud = claims.get("aud")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != cfg["client_id"]:
        raise OidcError("id_token_invalid", "id_token azp 불일치")
    if not nonce or not secrets.compare_digest(str(claims.get("nonce") or ""), nonce):
        raise OidcError("nonce_mismatch", "id_token nonce 불일치")
    return claims


def fetch_userinfo(meta: dict[str, Any], access_token: str | None, sub: str) -> dict[str, Any]:
    """id_token 에 필요한 claim 이 없을 때만 보충 조회. 실패는 빈 dict(필수 claim 검사에서 걸린다)."""
    endpoint = meta.get("userinfo_endpoint")
    if not endpoint or not access_token:
        return {}
    try:
        info = _get_json(
            endpoint, what="UserInfo", code="idp_error",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        )
    except OidcError as exc:
        logger.info("oidc: userinfo 조회 실패 — %s", exc.detail)
        return {}
    if info.get("sub") != sub:
        logger.warning("oidc: userinfo sub 불일치 — 무시")
        return {}
    return info


def claim_str(claims: dict[str, Any], name: str | None) -> str | None:
    if not name:
        return None
    v = claims.get(name)
    if isinstance(v, (str, int)) and not isinstance(v, bool):
        s = str(v).strip()
        return s or None
    return None


def domain_allowed(cfg: dict[str, Any], email: str | None) -> bool:
    domains = _normalize_domains(cfg.get("allowed_domains"))
    if not domains:
        return True
    if not email or "@" not in email:
        return False
    dom = email.rsplit("@", 1)[1].lower()
    return any(dom == d or dom.endswith(f".{d}") for d in domains)


def needs_verified_email(cfg: dict[str, Any]) -> bool:
    """허용 도메인 정책이 켜져 있고 검증된 이메일을 요구하는 설정인가."""
    return bool(_normalize_domains(cfg.get("allowed_domains"))) and cfg.get("require_email_verified", True) is not False


def email_verified(claims: dict[str, Any]) -> bool:
    """``email_verified`` 가 참일 때만 True — 없거나 거짓이면 False(일부 IdP 는 문자열 "true" 로 준다)."""
    v = claims.get("email_verified")
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


# ── 연결 확인 (Settings "연결 확인") ─────────────────────────────────────────


def check_connection(issuer: str) -> dict[str, Any]:
    """discovery → JWKS 를 실제로 받아 본다. 예외 없이 단계별 결과를 돌려준다."""
    steps: list[dict[str, Any]] = []
    out: dict[str, Any] = {"ok": False, "steps": steps}
    try:
        issuer = _validate_url(issuer, "Issuer", allow_empty=False)
    except ValueError as exc:
        steps.append({"name": "issuer", "ok": False, "detail": str(exc)})
        return out
    t0 = time.perf_counter()
    try:
        meta = discover(issuer, force=True)
    except OidcError as exc:
        steps.append({"name": "discovery", "ok": False, "detail": exc.detail})
        return out
    algs = allowed_algs(meta)
    steps.append({
        "name": "discovery", "ok": True,
        "detail": f"{issuer}/.well-known/openid-configuration · {int((time.perf_counter() - t0) * 1000)}ms",
    })
    out.update({
        "authorization_endpoint": meta.get("authorization_endpoint"),
        "token_endpoint": meta.get("token_endpoint"),
        "userinfo_endpoint": meta.get("userinfo_endpoint"),
        "algorithms": algs,
        "pkce_s256": "S256" in (meta.get("code_challenge_methods_supported") or ["S256"]),
    })
    if not algs:
        supported = ", ".join(meta.get("id_token_signing_alg_values_supported") or [])
        steps.append({"name": "algorithms", "ok": False, "detail": f"RS*/ES* 서명 미지원(IdP 지원: {supported})"})
        return out
    steps.append({"name": "algorithms", "ok": True, "detail": ", ".join(algs)})
    t1 = time.perf_counter()
    try:
        jwks = fetch_jwks(meta["jwks_uri"], force=True)
        keyset = jwt.PyJWKSet.from_dict(jwks)
    except OidcError as exc:
        steps.append({"name": "jwks", "ok": False, "detail": exc.detail})
        return out
    except jwt.PyJWTError as exc:
        steps.append({"name": "jwks", "ok": False, "detail": f"JWKS 해석 실패: {type(exc).__name__}"})
        return out
    out["jwks_keys"] = len(keyset.keys)
    steps.append({
        "name": "jwks", "ok": True,
        "detail": f"서명 키 {len(keyset.keys)}개 · {int((time.perf_counter() - t1) * 1000)}ms",
    })
    out["ok"] = True
    return out
