"""Jira 연동 라우터 (prefix `/jira`).

- 공통 설정(base_url 등)은 AppSetting key=`jira_integration` (관리자 전용 쓰기).
- 사용자별 PAT 는 `user_jira_credentials` 에 암호화 저장 (secret_box).
- 가져오기는 서버사이드에서 현재 사용자 PAT 로 실행 → work_items upsert (dedup by jira_issue_id).
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User
from app.models.user_jira_credential import UserJiraCredential
from app.models.work_item import WorkItem
from app.auth.deps import get_current_user, require_admin, require_operator
from app.services import secret_box
from app.services import audit_logger
from app.services.jira_service import JiraService, map_jira_issue
from app.schemas.jira import (
    JiraConfig,
    JiraConfigUpdate,
    JiraCredentialStatus,
    JiraCredentialUpdate,
    JiraTestResult,
    JiraImportRequest,
    JiraImportResult,
    JiraImportItemPreview,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/jira", tags=["jira"])

JIRA_SETTINGS_KEY = "jira_integration"
ASSIGNEES_KEY = "assignees"
DEFAULT_JIRA_SETTINGS = {
    "base_url": "",
    "enabled": False,
    "verify_tls": True,
    "default_project_key": None,
}


def _get_config(db: Session) -> dict:
    row = db.query(AppSetting).filter(AppSetting.key == JIRA_SETTINGS_KEY).first()
    value = dict(DEFAULT_JIRA_SETTINGS)
    if row and isinstance(row.value, dict):
        value.update(row.value)
    return value


def _build_assignee_resolver(db: Session):
    """Jira displayName → PEP 담당자 이름. 레지스트리(name) 와 대소문자 무시 매칭, 실패 시 원본."""
    try:
        row = db.query(AppSetting).filter(AppSetting.key == ASSIGNEES_KEY).first()
        registry = row.value if row and isinstance(row.value, list) else []
    except Exception:  # noqa: BLE001
        registry = []
    by_lower = {}
    for a in registry:
        if isinstance(a, dict) and a.get("name"):
            by_lower[str(a["name"]).strip().lower()] = str(a["name"]).strip()

    def _resolve(jira_name: str) -> str:
        return by_lower.get(jira_name.strip().lower(), jira_name.strip())

    return _resolve


def _user_token(db: Session, username: str) -> Optional[str]:
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == username).first()
    if not cred:
        return None
    try:
        return secret_box.decrypt(cred.token_encrypted)
    except ValueError:
        return None


# ── 공통 설정 ──────────────────────────────────────────────────────────────────
@router.get("/config", response_model=JiraConfig)
def get_config(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return JiraConfig(**_get_config(db))


@router.put("/config", response_model=JiraConfig)
def update_config(
    payload: JiraConfigUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = db.query(AppSetting).filter(AppSetting.key == JIRA_SETTINGS_KEY).first()
    current = dict(DEFAULT_JIRA_SETTINGS)
    if row and isinstance(row.value, dict):
        current.update(row.value)
    data = payload.model_dump(exclude_unset=True)
    if "base_url" in data and data["base_url"] is not None:
        current["base_url"] = data["base_url"].rstrip("/")
    for k in ("enabled", "verify_tls", "default_project_key"):
        if k in data and data[k] is not None:
            current[k] = data[k]
    if row:
        row.value = current
    else:
        db.add(AppSetting(key=JIRA_SETTINGS_KEY, value=current))
    db.commit()
    return JiraConfig(**current)


# ── 사용자별 자격증명 ──────────────────────────────────────────────────────────
@router.get("/credential", response_model=JiraCredentialStatus)
def get_credential(db: Session = Depends(get_db), actor: User = Depends(get_current_user)):
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    if not cred:
        return JiraCredentialStatus(configured=False)
    return JiraCredentialStatus(
        configured=True, jira_account=cred.jira_account, last_verified_at=cred.last_verified_at
    )


@router.put("/credential", response_model=JiraCredentialStatus)
def save_credential(
    payload: JiraCredentialUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    token = (payload.token or "").strip()
    if not token:
        raise HTTPException(status_code=422, detail="토큰을 입력하세요.")
    enc = secret_box.encrypt(token)
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    if cred:
        cred.token_encrypted = enc
        if payload.jira_account is not None:
            cred.jira_account = payload.jira_account
    else:
        cred = UserJiraCredential(
            username=actor.username, token_encrypted=enc, jira_account=payload.jira_account
        )
        db.add(cred)
    db.commit()
    db.refresh(cred)
    return JiraCredentialStatus(
        configured=True, jira_account=cred.jira_account, last_verified_at=cred.last_verified_at
    )


@router.delete("/credential", status_code=status.HTTP_204_NO_CONTENT)
def delete_credential(db: Session = Depends(get_db), actor: User = Depends(get_current_user)):
    cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
    if cred:
        db.delete(cred)
        db.commit()
    return None


@router.post("/test", response_model=JiraTestResult)
async def test_connection(db: Session = Depends(get_db), actor: User = Depends(get_current_user)):
    cfg = _get_config(db)
    if not cfg.get("base_url"):
        return JiraTestResult(ok=False, detail="관리자가 Jira URL 을 설정하지 않았습니다.")
    token = _user_token(db, actor.username)
    if not token:
        return JiraTestResult(ok=False, detail="내 PAT 가 등록되지 않았습니다.")
    svc = JiraService(cfg["base_url"], token, verify=bool(cfg.get("verify_tls", True)))
    res = await svc.myself()
    if res.get("status") == "ok":
        cred = db.query(UserJiraCredential).filter(UserJiraCredential.username == actor.username).first()
        if cred:
            cred.last_verified_at = datetime.utcnow()
            if res.get("account") and not cred.jira_account:
                cred.jira_account = res.get("display_name") or res.get("account")
            db.commit()
        return JiraTestResult(ok=True, detail="연결 정상", display_name=res.get("display_name"))
    return JiraTestResult(ok=False, detail=res.get("detail", "연결 실패"))


# ── 가져오기 (단방향, upsert by jira_issue_id) ──────────────────────────────────
@router.post("/import", response_model=JiraImportResult)
async def import_issues(
    payload: JiraImportRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cfg = _get_config(db)
    base_url = cfg.get("base_url", "")
    if not base_url or not cfg.get("enabled", False):
        return JiraImportResult(status="error", detail="Jira 연동이 비활성화되었거나 URL 미설정 (설정에서 활성화하세요).")
    token = _user_token(db, actor.username)
    if not token:
        return JiraImportResult(status="error", detail="내 PAT 가 등록되지 않았습니다 (설정 > 연동에서 등록).")

    # JQL 구성
    if payload.scope == "me":
        jql = "assignee = currentUser() ORDER BY updated DESC"
    elif payload.scope == "project":
        pk = (payload.project_key or "").strip()
        if not pk:
            return JiraImportResult(status="error", detail="프로젝트 키를 입력하세요.")
        jql = f'project = "{pk}" ORDER BY updated DESC'
    else:  # jql
        jql = (payload.jql or "").strip()
        if not jql:
            return JiraImportResult(status="error", detail="JQL 을 입력하세요.")

    svc = JiraService(base_url, token, verify=bool(cfg.get("verify_tls", True)))
    search = await svc.search(jql)
    if search.get("status") != "ok":
        return JiraImportResult(
            status=search.get("status", "error"),
            detail=search.get("detail", "Jira 검색 실패"),
            total=search.get("total", 0),
        )

    resolver = _build_assignee_resolver(db)
    issues = search.get("issues", [])
    created = updated = skipped = 0
    errors: list[str] = []
    preview: list[JiraImportItemPreview] = []
    now = datetime.utcnow()

    for issue in issues:
        try:
            fields = map_jira_issue(issue, base_url, assignee_resolver=resolver)
            jid = fields.get("jira_issue_id")
            if not jid:
                skipped += 1
                continue
            existing = db.query(WorkItem).filter(WorkItem.jira_issue_id == jid).first()
            action = "update" if existing else "create"
            preview.append(JiraImportItemPreview(
                jira_key=fields["jira_issue_key"], title=fields["title"],
                kanban_status=fields["kanban_status"], action=action,
            ))
            if payload.dry_run:
                if existing:
                    updated += 1
                else:
                    created += 1
                continue

            if existing:
                # Jira-소유 필드만 갱신 (PEP 로컬 편집 보존). 담당자는 비어있을 때만 채움.
                existing.title = fields["title"]
                existing.content = fields["content"]
                existing.kanban_status = fields["kanban_status"]
                existing.priority = fields["priority"]
                existing.jira_status = fields["jira_status"]
                existing.jira_url = fields["jira_url"]
                existing.jira_issue_key = fields["jira_issue_key"]
                existing.jira_updated_at = fields["jira_updated_at"]
                existing.jira_synced_at = now
                if fields["closed_at"] and not existing.closed_at:
                    existing.closed_at = fields["closed_at"]
                if not (existing.primary_assignee or "").strip() or existing.primary_assignee == "(미할당)":
                    existing.primary_assignee = fields["primary_assignee"]
                    existing.assignee = fields["primary_assignee"]
                watchers = list(existing.jira_watchers or [])
                if actor.username not in watchers:
                    watchers.append(actor.username)
                existing.jira_watchers = watchers
                updated += 1
            else:
                item = WorkItem(
                    type=fields["type"],
                    type_label=fields["type_label"],
                    assignee=fields["primary_assignee"],
                    primary_assignee=fields["primary_assignee"],
                    category=fields["category"],
                    title=fields["title"],
                    content=fields["content"],
                    kanban_status=fields["kanban_status"],
                    priority=fields["priority"],
                    started_at=fields["started_at"],
                    closed_at=fields["closed_at"],
                    jira_issue_id=fields["jira_issue_id"],
                    jira_issue_key=fields["jira_issue_key"],
                    jira_url=fields["jira_url"],
                    jira_status=fields["jira_status"],
                    jira_updated_at=fields["jira_updated_at"],
                    jira_synced_at=now,
                    jira_watchers=[actor.username],
                    created_by=actor.username,
                )
                db.add(item)
                created += 1
        except Exception as exc:  # noqa: BLE001 - 한 이슈 실패가 전체를 막지 않도록
            logger.warning("Jira import 항목 실패 (%s): %s", issue.get("key"), exc)
            errors.append(f"{issue.get('key', '?')}: {str(exc)[:120]}")

    if not payload.dry_run:
        try:
            db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            return JiraImportResult(status="error", detail=f"저장 실패: {str(exc)[:200]}")
        audit_logger.record(
            db, action="work_item.jira_import", actor=actor,
            target_type="work_item", target_id=None,
            details={"scope": payload.scope, "created": created, "updated": updated, "skipped": skipped},
        )

    return JiraImportResult(
        status="ok",
        imported=created,
        updated=updated,
        skipped=skipped,
        total=search.get("total", len(issues)),
        truncated=bool(search.get("truncated")),
        dry_run=payload.dry_run,
        errors=errors,
        items=preview[:50],
    )
