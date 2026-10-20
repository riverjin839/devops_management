"""사내 디렉터리(LDAP/AD) 로그인 관리자 설정 — /auth/ldap/settings* (R-7).

로그인 자체는 기존 ``POST /auth/login`` 이 처리한다(``routers/auth.py``). 여기는 Settings ▸ 접근 제어의
LDAP 카드가 쓰는 설정 조회·수정·연결 확인만 있고, 모든 엔드포인트가 ``require_admin`` 을 직접 건다
(public 마운트 — auth 와 같은 위치에 둔다).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.database import get_db
from app.models.user import User
from app.services import audit_logger
from app.services import ldap_service as ldap

router = APIRouter(prefix="/auth/ldap", tags=["auth"])


class LdapSettingsOut(BaseModel):
    enabled: bool
    server_urls: list[str]
    start_tls: bool
    tls_verify: bool
    ca_cert_pem: str
    timeout_seconds: int
    bind_mode: str
    bind_dn_template: str
    service_bind_dn: str
    has_bind_password: bool
    user_search_base: str
    user_search_filter: str
    display_name_attribute: str
    email_attribute: str
    group_attribute: str
    allowed_groups: list[str]
    auto_provision: bool
    default_role: str
    priority: str
    protect_local_admins: bool
    # 백엔드 이미지에 ldap3 가 설치돼 있는지 — 없으면 화면이 경고를 띄운다.
    module_available: bool


class LdapSettingsUpdate(BaseModel):
    enabled: bool | None = None
    server_urls: list[str] | None = Field(None, max_length=10)
    start_tls: bool | None = None
    tls_verify: bool | None = None
    ca_cert_pem: str | None = Field(None, max_length=32768)
    timeout_seconds: int | None = None
    bind_mode: str | None = Field(None, max_length=16)
    bind_dn_template: str | None = Field(None, max_length=512)
    service_bind_dn: str | None = Field(None, max_length=512)
    bind_password: str | None = Field(None, max_length=1024)
    clear_bind_password: bool | None = None
    user_search_base: str | None = Field(None, max_length=512)
    user_search_filter: str | None = Field(None, max_length=512)
    display_name_attribute: str | None = Field(None, max_length=64)
    email_attribute: str | None = Field(None, max_length=64)
    group_attribute: str | None = Field(None, max_length=64)
    allowed_groups: list[str] | None = Field(None, max_length=100)
    auto_provision: bool | None = None
    default_role: str | None = None
    priority: str | None = None
    protect_local_admins: bool | None = None


class LdapTestRequest(LdapSettingsUpdate):
    """저장 전 입력값을 먼저 확인할 수 있게 설정 필드를 함께 받는다(저장하지 않는다).

    ``test_username`` 은 비밀번호 없이 **검색만** 한다.
    """

    test_username: str | None = Field(None, max_length=64)


def _out(cfg: dict[str, Any]) -> LdapSettingsOut:
    view = ldap.admin_view(cfg)
    return LdapSettingsOut(**{k: view[k] for k in LdapSettingsOut.model_fields})


@router.get("/settings", response_model=LdapSettingsOut)
def get_settings(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return _out(ldap.load_config(db))


@router.put("/settings", response_model=LdapSettingsOut)
def update_settings(
    payload: LdapSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    try:
        cfg, changed = ldap.save_config(db, payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit_logger.record(
        db,
        action="settings.ldap.update",
        actor=actor,
        status="success",
        target_type="app_setting",
        target_id=ldap.SETTING_KEY,
        # 바뀐 필드 이름만 — 값(특히 서비스 계정 비밀번호)은 남기지 않는다.
        details={"changed": changed, "enabled": bool(cfg.get("enabled"))},
        request=request,
    )
    return _out(cfg)


# 저장된 서비스 계정 비밀번호를 보낼 대상이 바뀌는 필드 — 이 값이 저장값과 다르면 저장된 비밀번호를 쓰지 않는다.
_TARGET_KEYS = ("server_urls", "start_tls", "tls_verify", "ca_cert_pem", "service_bind_dn")


@router.post("/settings/test")
def test_settings(
    payload: LdapTestRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    """서버 연결 → 서비스 바인드 → (선택) 사용자 검색. 실패도 200 + 단계별 결과로 돌려준다."""
    patch = payload.model_dump(exclude_unset=True)
    test_username = patch.pop("test_username", None)
    saved = ldap.load_config(db)
    try:
        cfg, _changed = ldap.merge_config(saved, patch, require_ready=False)
    except ValueError as exc:
        return {"ok": False, "steps": [{"name": "config", "ok": False, "detail": str(exc)}]}
    retargeted = [k for k in _TARGET_KEYS if cfg.get(k) != saved.get(k)]
    if retargeted and not patch.get("bind_password") and cfg.get("bind_password_encrypted"):
        # 접속 대상을 바꾼 확인에 저장된 비밀번호를 실어 보내면 관리자 토큰만으로 임의 서버에서 평문을
        # 받아 낼 수 있다 — 대상이 바뀌면 이번 요청에 비밀번호를 다시 입력해야 서비스 바인드를 한다.
        cfg = {**cfg, "bind_password_encrypted": None}
    result = ldap.check_connection(cfg, test_username)
    if retargeted and not patch.get("bind_password") and saved.get("bind_password_encrypted"):
        result.setdefault("warnings", []).append(
            "서버·TLS·서비스 계정 DN 을 바꿔 확인할 때는 저장된 비밀번호를 쓰지 않습니다 — 비밀번호를 다시 입력하세요."
        )
    audit_logger.record(
        db,
        action="settings.ldap.test",
        actor=actor,
        status="success" if result.get("ok") else "failure",
        target_type="app_setting",
        target_id=ldap.SETTING_KEY,
        details={"retargeted": retargeted, "ok": bool(result.get("ok")), "test_user": bool(test_username)},
        request=request,
    )
    return result
