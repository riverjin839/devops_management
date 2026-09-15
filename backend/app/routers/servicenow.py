"""ServiceNow ITSM 연동 라우터 (prefix `/servicenow`).

- 공통 설정(base_url/table_name/필드 매핑)은 AppSetting key=`servicenow_integration`
  (관리자 전용 쓰기) — `routers/jira.py` 의 `jira_integration` 설정과 동일한 패턴.
- 1차 구현은 전용 ServiceNow 자격증명 UI가 없다 — 사용자의 Jira/SSO 세션 쿠키를 그대로
  재사용하고, 성공하면 `user_jira_credentials.servicenow_cookie_encrypted` 로 승격 저장한다
  (`_confluence_service_verified` 의 Jira 세션 폴백 전략과 동일). 전용 인증(Basic/OAuth)은
  추후 개선 범위.
- 등록 대상은 **이미 Jira 와 연동된**(jira_issue_key 존재) WorkItem 만 — Jira에 이미 등록된
  정보를 소스로 삼아 ServiceNow 에도 등록하는 것이 목적이다.
- 등록은 수동 버튼(1차 구현)만 지원한다. CLAUDE.md 규칙("모든 실행 버튼은 상세·실시간 로그
  + 로그 보기 옵션 필요")을 만족시키기 위해, 이 작업은 SSH/장시간 세션이 아니라 짧은
  다단계 외부 API 호출이므로 WebSocket 콘솔 대신 **동기 응답에 단계별 구조화 로그
  (`steps`)를 담아 반환**한다 — `NodeSpecPage.tsx` 의 Host Facts 수집 버튼과 동일한 패턴.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User
from app.models.user_jira_credential import UserJiraCredential
from app.models.work_item import WorkItem
from app.auth.deps import get_current_user, require_admin, require_operator
from app.services import secret_box
from app.services import audit_logger
from app.services.servicenow_service import ServiceNowService
# Jira 세션 재사용(1차 구현 인증 전략)을 위해 jira.py 의 헬퍼를 재사용한다 —
# `routers/jira.py` 가 이미 `routers/work_items.py` 의 헬퍼를 재사용하는 것과 같은 패턴.
from app.routers.jira import _get_config as _jira_get_config, _user_credential, _sso_relogin
from app.schemas.servicenow import (
    ServiceNowConfig,
    ServiceNowConfigUpdate,
    ServiceNowTestResult,
    ServiceNowRegisterResult,
    ServiceNowRegisterStep,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/servicenow", tags=["servicenow"])

SERVICENOW_SETTINGS_KEY = "servicenow_integration"
DEFAULT_SERVICENOW_SETTINGS = {
    "base_url": "",
    "enabled": False,
    "verify_tls": True,
    # 실제 내부 인스턴스 스펙 확인 전까지 ServiceNow 표준 Table API 를 가정한 기본값.
    # 다르면 코드 수정 없이 여기서(관리자 UI) 조정한다 — UI-First 원칙.
    "table_name": "incident",
    "field_mapping": {
        "short_description": "title",
        "description": "content",
    },
    "priority_map": {"high": "1", "medium": "2", "low": "3"},
}


def _get_config(db: Session) -> dict:
    row = db.query(AppSetting).filter(AppSetting.key == SERVICENOW_SETTINGS_KEY).first()
    value = dict(DEFAULT_SERVICENOW_SETTINGS)
    if row and isinstance(row.value, dict):
        value.update(row.value)
    return value


# ── 공통 설정 ──────────────────────────────────────────────────────────────────
@router.get("/config", response_model=ServiceNowConfig)
def get_config(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return ServiceNowConfig(**_get_config(db))


@router.put("/config", response_model=ServiceNowConfig)
def update_config(
    payload: ServiceNowConfigUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = db.query(AppSetting).filter(AppSetting.key == SERVICENOW_SETTINGS_KEY).first()
    value = dict(DEFAULT_SERVICENOW_SETTINGS)
    if row and isinstance(row.value, dict):
        value.update(row.value)
    value.update({k: v for k, v in payload.model_dump().items() if v is not None})
    if row:
        row.value = value
    else:
        row = AppSetting(key=SERVICENOW_SETTINGS_KEY, value=value)
        db.add(row)
    db.commit()
    return ServiceNowConfig(**value)


# ── 인증 (1차 구현 — Jira/SSO 세션 재사용) ────────────────────────────────────────
async def _servicenow_service_verified(
    db: Session, actor: User, cfg: dict
) -> tuple[Optional[ServiceNowService], dict]:
    """ServiceNow 세션 확보 + current_user 검증.

    순서: (1) 저장된 전용 ServiceNow 쿠키 → (2) 현재 Jira 세션 쿠키를 그대로 재사용
    (성공하면 ServiceNow 쿠키로 승격 저장) → (3) Jira 세션이 만료됐으면 `_sso_relogin`
    으로 갱신 후 한 번 더 (2)를 시도. 1차 구현은 ServiceNow 전용 SSO 로그인을 별도로
    수행하지 않는다(같은 사내 SSO 도메인을 공유한다는 전제) — 전용 인증은 추후 개선."""
    base_url = (cfg.get("base_url") or "").strip()
    if not base_url:
        return None, {"status": "error", "detail": "관리자가 ServiceNow URL 을 설정하지 않았습니다."}
    verify = bool(cfg.get("verify_tls", True))
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()

    if cred and getattr(cred, "servicenow_cookie_encrypted", None):
        try:
            cookie = secret_box.decrypt(cred.servicenow_cookie_encrypted)
        except ValueError:
            cookie = None
        if cookie:
            svc = ServiceNowService(base_url, cookie, auth_type="sso", verify=verify)
            res = await svc.current_user()
            if not res.get("auth_failed"):
                return svc, res

    jira_token, jira_auth = _user_credential(db, actor.username)
    if jira_token and jira_auth in ("cookie", "sso"):
        svc = ServiceNowService(base_url, jira_token, auth_type="sso", verify=verify)
        svc, res = await _verify_and_promote(db, cred, svc, jira_token)
        if svc is not None:
            return svc, res

    # Jira 세션이 아예 없거나 만료됐으면 재로그인 후 한 번 더 시도.
    jira_cfg = _jira_get_config(db)
    if await _sso_relogin(db, actor, jira_cfg):
        jira_token, jira_auth = _user_credential(db, actor.username)
        if jira_token:
            svc = ServiceNowService(base_url, jira_token, auth_type="sso", verify=verify)
            svc, res = await _verify_and_promote(db, cred, svc, jira_token)
            if svc is not None:
                return svc, res

    return None, {
        "status": "error", "auth_failed": True,
        "detail": "ServiceNow 세션이 없습니다 — Settings → 연동(Jira)에서 'SSO 자동 로그인' 후 다시 시도하세요.",
    }


async def _verify_and_promote(
    db: Session, cred: Optional[UserJiraCredential], svc: ServiceNowService, jira_token: str
) -> tuple[Optional[ServiceNowService], dict]:
    res = await svc.current_user()
    if res.get("status") != "ok":
        return None, res
    # 통했으면 ServiceNow 세션으로 승격 저장 — 다음부터 바로 쓰인다(Confluence 폴백과 동일).
    if cred:
        cred.servicenow_cookie_encrypted = secret_box.encrypt(jira_token)
        db.commit()
    return svc, res


@router.post("/test", response_model=ServiceNowTestResult)
async def test_connection(
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    cfg = _get_config(db)
    svc, res = await _servicenow_service_verified(db, actor, cfg)
    if svc is None:
        return ServiceNowTestResult(ok=False, detail=res.get("detail", "연결 실패"))
    return ServiceNowTestResult(ok=True, detail="연결 성공", display_name=res.get("display_name"))


# ── 업무 → ServiceNow 등록 ───────────────────────────────────────────────────
def _build_fields(item: WorkItem, cfg: dict) -> dict:
    field_mapping: dict = cfg.get("field_mapping") or {}
    fields: dict = {}
    for sn_field, pep_field in field_mapping.items():
        value = getattr(item, pep_field, None)
        if value is None or value == "":
            continue
        fields[sn_field] = str(value)

    jira_ref = f"[Jira: {item.jira_issue_key}]"
    if item.jira_url:
        jira_ref += f" {item.jira_url}"
    fields["description"] = f"{fields.get('description', '')}\n\n{jira_ref}".strip()

    priority_map: dict = cfg.get("priority_map") or {}
    mapped_priority = priority_map.get(item.priority or "")
    if mapped_priority:
        fields["urgency"] = mapped_priority
    return fields


@router.post("/register/{item_id}", response_model=ServiceNowRegisterResult)
async def register_work_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Jira 와 연동된 업무 1건을 ServiceNow ITSM 에 등록하고 결과를 업무에 연결한다."""
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="업무를 찾을 수 없습니다.")
    if not item.jira_issue_key:
        raise HTTPException(status_code=400, detail="Jira 와 연동된 업무만 ServiceNow 에 등록할 수 있습니다.")

    steps: list[ServiceNowRegisterStep] = []
    cfg = _get_config(db)

    if not cfg.get("enabled") or not (cfg.get("base_url") or "").strip():
        detail = "관리자가 ServiceNow 연동을 설정하지 않았습니다."
        steps.append(ServiceNowRegisterStep(step="config", status="error", message=detail))
        item.servicenow_register_error = detail
        db.commit()
        return ServiceNowRegisterResult(status="error", detail=detail, steps=steps)
    steps.append(ServiceNowRegisterStep(
        step="config", status="ok",
        message=f"{cfg['base_url']} · table={cfg.get('table_name')}",
    ))

    svc, auth_res = await _servicenow_service_verified(db, actor, cfg)
    if svc is None:
        detail = auth_res.get("detail", "인증 실패")
        steps.append(ServiceNowRegisterStep(step="auth", status="error", message=detail))
        item.servicenow_register_error = detail
        db.commit()
        return ServiceNowRegisterResult(status="error", detail=detail, auth_issue=True, steps=steps)
    steps.append(ServiceNowRegisterStep(
        step="auth", status="ok",
        message="세션 확인됨" + (f" — {auth_res['display_name']}" if auth_res.get("display_name") else ""),
    ))

    fields = _build_fields(item, cfg)
    steps.append(ServiceNowRegisterStep(
        step="payload", status="ok", message=f"필드 {len(fields)}개 매핑 완료 (Jira {item.jira_issue_key})",
    ))

    res = await svc.create_record(cfg.get("table_name") or "incident", fields)
    if res.get("status") != "ok":
        detail = res.get("detail", "ServiceNow 등록 실패")
        steps.append(ServiceNowRegisterStep(step="create", status="error", message=detail))
        item.servicenow_register_error = detail
        db.commit()
        audit_logger.record(
            db, action="work_item.servicenow_register_failed", actor=actor,
            target_type="work_item", target_id=str(item.id), status="failure",
            details={"error": detail},
        )
        return ServiceNowRegisterResult(
            status="error", detail=detail, auth_issue=bool(res.get("auth_failed")), steps=steps,
        )

    steps.append(ServiceNowRegisterStep(
        step="create", status="ok", message=f"{res.get('number') or res.get('sys_id')} 생성됨",
    ))
    item.servicenow_sys_id = res.get("sys_id") or None
    item.servicenow_number = res.get("number") or None
    item.servicenow_url = res.get("url") or None
    item.servicenow_status = "New"
    item.servicenow_synced_at = datetime.utcnow()
    item.servicenow_register_error = None
    db.commit()

    audit_logger.record(
        db, action="work_item.servicenow_register", actor=actor,
        target_type="work_item", target_id=str(item.id),
        details={"number": res.get("number"), "sys_id": res.get("sys_id")},
    )

    return ServiceNowRegisterResult(
        status="ok", ticket_number=res.get("number"), ticket_url=res.get("url"),
        steps=steps, synced_at=item.servicenow_synced_at,
    )
