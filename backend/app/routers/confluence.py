"""Confluence 문서 가져오기/내보내기 라우터 (prefix `/confluence`).

Jira 연동(`routers/jira.py`)과 동일 패턴:
- 세션 확보는 `_confluence_service_verified` (쿠키 → Jira 쿠키 승격 → SSO 자동 재로그인) 재사용.
- 가져오기는 dry-run 프리뷰(action create/update/unchanged + changes[]) → `only_page_ids` 커밋.
- per-item try/except 로 한 페이지 실패가 배치를 중단시키지 않고 errors[] 에 누적.
- 서비스 오류는 raise 하지 않고 `status: ok|offline|error` 로 전달.

문서 엔티티는 WorkGuide (`work_guides`) — storage-format ↔ 에디터 HTML 변환은
`services/confluence_storage.py`, 검색은 `services/knowledge_search.py`.
"""
from __future__ import annotations

import base64
import logging
import re
from datetime import datetime
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User
from app.models.work_guide import WorkGuide
from app.routers.jira import _confluence_service_verified, _get_config
from app.routers.work_guide import _queue_embedding_recompute
from app.schemas.confluence_docs import (
    ConfluenceDocExportRequest,
    ConfluenceDocExportResult,
    ConfluenceDocFieldChange,
    ConfluenceDocImportPreview,
    ConfluenceDocImportRequest,
    ConfluenceDocImportResult,
    ConfluenceDocPullResult,
    ConfluenceDocSearchItem,
    ConfluenceDocSearchRequest,
    ConfluenceDocSearchResult,
    ConfluenceDocsSettings,
)
from app.services import audit_logger
from app.services.confluence_storage import editor_html_to_storage, storage_to_editor_html

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/confluence", tags=["confluence-docs"])

DOCS_SETTINGS_KEY = "confluence_documents"
DEFAULT_DOCS_SETTINGS = {
    "space_key": "",
    "parent_page_id": "",
    "default_category": "기타",
    "title_prefix": "",
}

_MAX_IMPORT_PAGES = 50
_INLINE_IMAGE_MAX = 500 * 1024        # 이미지당 500KB
_INLINE_DOC_MAX = 5 * 1024 * 1024     # 문서당 base64 인라인 총량 5MB


def _get_docs_settings(db: Session) -> dict:
    row = db.query(AppSetting).filter(AppSetting.key == DOCS_SETTINGS_KEY).first()
    value = dict(DEFAULT_DOCS_SETTINGS)
    if row and isinstance(row.value, dict):
        value.update(row.value)
    return value


@router.get("/docs/settings", response_model=ConfluenceDocsSettings)
def get_docs_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return ConfluenceDocsSettings(**_get_docs_settings(db))


@router.put("/docs/settings", response_model=ConfluenceDocsSettings)
def update_docs_settings(
    payload: ConfluenceDocsSettings,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = db.query(AppSetting).filter(AppSetting.key == DOCS_SETTINGS_KEY).first()
    value = payload.model_dump()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=DOCS_SETTINGS_KEY, value=value))
    db.commit()
    return ConfluenceDocsSettings(**value)


def _cql_quote(v: str) -> str:
    """CQL 문자열 리터럴 — 역슬래시/따옴표 이스케이프 (jira.py `_jql_quote` 와 동일 패턴)."""
    return (v or "").replace("\\", "\\\\").replace('"', '\\"')


def _build_confluence_cql(payload: ConfluenceDocSearchRequest) -> tuple[str, str]:
    """기여자/스페이스/라벨/기간/텍스트 조건을 AND 로 묶어 CQL 을 조립한다.

    Jira 가져오기의 `_build_filter_jql`(jira.py:817) 과 동일 패턴 — 여러 값은 `IN (...)`
    으로 OR 처리. 반환 (cql, error) — `contributor_mode='any'` 인데 다른 조건도 전혀 없으면
    error 를 채운다(전체 스페이스 스캔 방지 가드, Jira 쪽 가드와 동일)."""
    clauses: list[str] = ["type = page"]
    has_filter = False

    if payload.contributor_mode == "me":
        # Confluence CQL 내장 함수 — 세션 사용자를 가리킨다(사용자명 조회 불필요).
        # Jira 가져오기의 `assignee = currentUser()` 와 동일한 패턴.
        clauses.append("contributor = currentUser()")
        has_filter = True
    elif payload.contributor_mode == "user":
        users = [u.strip() for u in (payload.contributor or "").split(",") if u.strip()]
        if users:
            if len(users) == 1:
                clauses.append(f'contributor = "{_cql_quote(users[0])}"')
            else:
                joined = ", ".join(f'"{_cql_quote(u)}"' for u in users)
                clauses.append(f"contributor IN ({joined})")
            has_filter = True
    # contributor_mode == "any" → 조건 생략

    space_key = (payload.space_key or "").strip()
    if space_key:
        clauses.append(f'space = "{_cql_quote(space_key)}"')
        has_filter = True

    labels = [x.strip() for x in payload.labels if x and x.strip()]
    if labels:
        # Confluence CQL 필드명은 단수 `label` — Jira 의 복수형 `labels` 와 다르다.
        joined = ", ".join(f'"{_cql_quote(x)}"' for x in labels)
        clauses.append(f"label IN ({joined})")
        has_filter = True

    if payload.updated_since_days and payload.updated_since_days > 0:
        clauses.append(f'lastmodified >= now("-{int(payload.updated_since_days)}d")')
        has_filter = True

    text = (payload.text or "").strip()
    if text:
        clauses.append(f'text ~ "{_cql_quote(text)}"')
        has_filter = True

    if not has_filter:
        return "", "조건을 하나 이상 지정하세요 (기여자/스페이스/라벨/기간/검색어)."
    return " and ".join(clauses) + " order by lastmodified desc", ""


# ── 검색 ────────────────────────────────────────────────────────────────────
@router.post("/docs/search", response_model=ConfluenceDocSearchResult)
async def search_docs(
    payload: ConfluenceDocSearchRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    """페이지 검색 — CQL 직접 입력 또는 조건 조합(기여자/스페이스/라벨/기간/텍스트) 검색.

    기본값은 `contributor_mode="me"` — 본인이 기여한 문서만 좁혀서 보여준다(위저드도
    동일 기본값으로 연다). 이미 work_guides 에 연결된 페이지는 `linked=true` 로 표시."""
    cfg = _get_config(db)
    cql = (payload.cql or "").strip()
    if not cql:
        cql, err = _build_confluence_cql(payload)
        if err:
            return ConfluenceDocSearchResult(status="error", detail=err)

    svc, res = await _confluence_service_verified(db, actor, cfg)
    if svc is None or res.get("status") != "ok":
        return ConfluenceDocSearchResult(
            status=res.get("status", "error"), detail=res.get("detail", "Confluence 세션 없음"))
    out = await svc.search(cql, limit=payload.limit)
    if out.get("status") != "ok":
        return ConfluenceDocSearchResult(
            status=out.get("status", "error"), detail=out.get("detail", "검색 실패"))

    page_ids = [str(i.get("id", "")) for i in out.get("items", []) if i.get("id")]
    linked: dict[str, UUID] = {}
    if page_ids:
        rows = (
            db.query(WorkGuide.id, WorkGuide.confluence_page_id)
            .filter(WorkGuide.confluence_page_id.in_(page_ids))
            .all()
        )
        linked = {pid: gid for gid, pid in rows if pid}
    items = [
        ConfluenceDocSearchItem(
            id=str(i.get("id", "")),
            title=i.get("title", ""),
            space_key=i.get("space_key", ""),
            url=i.get("url", ""),
            updated=i.get("updated", ""),
            linked=str(i.get("id", "")) in linked,
            linked_guide_id=linked.get(str(i.get("id", ""))),
        )
        for i in out.get("items", [])
        if (i.get("type") or "page") == "page"
    ]
    return ConfluenceDocSearchResult(
        status="ok", total=out.get("total", len(items)), items=items)


# ── 가져오기 ────────────────────────────────────────────────────────────────
async def _inline_attachment_images(
    svc, page_id: str, html: str, filenames: list[str], warnings: list[str],
) -> str:
    """본문의 첨부 이미지 URL 을 다운로드해 base64 로 치환 (크기 캡 초과 시 원본 링크 유지)."""
    total = 0
    for fn in dict.fromkeys(filenames):  # 중복 제거, 순서 유지
        res = await svc.get_attachment(page_id, quote(fn))
        if res.get("status") != "ok":
            warnings.append(f"첨부 '{fn}' 다운로드 실패 — 원본 링크로 유지합니다.")
            continue
        content = res.get("content") or b""
        if len(content) > _INLINE_IMAGE_MAX or total + len(content) > _INLINE_DOC_MAX:
            warnings.append(f"첨부 '{fn}' 는 용량 제한 초과 — 원본 링크로 유지합니다.")
            continue
        total += len(content)
        mime = (res.get("mime") or "image/png").split(";")[0]
        data_uri = f"data:{mime};base64,{base64.b64encode(content).decode()}"
        # 변환기가 만든 `src=".../download/attachments/{page_id}/{fn}"` 를 data URI 로 치환
        needle = f"/download/attachments/{page_id}/{quote(fn)}"
        html = re.sub(r'src="[^"]*' + re.escape(needle) + '"', f'src="{data_uri}"', html)
    return html


def _import_changes(guide: WorkGuide, title: str, version) -> list[ConfluenceDocFieldChange]:
    changes: list[ConfluenceDocFieldChange] = []
    if (guide.title or "") != (title or ""):
        changes.append(ConfluenceDocFieldChange(field="title", old=guide.title, new=title))
    if guide.confluence_version != version:
        changes.append(ConfluenceDocFieldChange(
            field="version",
            old=str(guide.confluence_version) if guide.confluence_version is not None else None,
            new=str(version) if version is not None else None,
        ))
    changes.append(ConfluenceDocFieldChange(field="content", old=None, new="(본문 갱신)"))
    return changes


@router.post("/docs/import", response_model=ConfluenceDocImportResult)
async def import_docs(
    payload: ConfluenceDocImportRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Confluence 페이지들을 WorkGuide 로 가져온다 — `/jira/import` 와 동일한 2단계.

    1. `dry_run=true`(기본): 쓰기 없이 페이지별 action(create/update/unchanged) 프리뷰.
    2. `dry_run=false` + `only_page_ids`: 선택된 페이지만 커밋 → 임베딩 재계산 큐잉."""
    page_ids = [str(p).strip() for p in (payload.page_ids or []) if str(p).strip()]
    if not page_ids:
        return ConfluenceDocImportResult(status="error", detail="가져올 페이지를 선택하세요.",
                                         dry_run=payload.dry_run)
    if len(page_ids) > _MAX_IMPORT_PAGES:
        return ConfluenceDocImportResult(
            status="error", dry_run=payload.dry_run,
            detail=f"한 번에 {_MAX_IMPORT_PAGES}페이지까지 가져올 수 있습니다.")

    cfg = _get_config(db)
    svc, res = await _confluence_service_verified(db, actor, cfg)
    if svc is None or res.get("status") != "ok":
        return ConfluenceDocImportResult(
            status=res.get("status", "error"), dry_run=payload.dry_run,
            detail=res.get("detail", "Confluence 세션 없음"))

    docs_settings = _get_docs_settings(db)
    category = (payload.category or "").strip() or docs_settings.get("default_category") or "기타"
    only = set(payload.only_page_ids or []) if payload.only_page_ids is not None else None
    base_url = (cfg.get("confluence_base_url") or "").strip()

    imported = updated = skipped = 0
    errors: list[str] = []
    all_warnings: list[str] = []
    previews: list[ConfluenceDocImportPreview] = []

    for pid in page_ids:
        try:
            page_res = await svc.get_page(pid)
            if page_res.get("status") != "ok":
                errors.append(f"{pid}: {page_res.get('detail', '조회 실패')}")
                previews.append(ConfluenceDocImportPreview(
                    page_id=pid, title="", action="error",
                    detail=page_res.get("detail", "조회 실패")))
                continue
            page = page_res["page"]
            title = (page.get("title") or "").strip()[:200] or f"(제목 없음 {pid})"
            version = page.get("version")

            conv = storage_to_editor_html(
                page.get("body_storage") or "", base_url=base_url, page_id=pid)
            warnings = list(conv["warnings"])
            html = conv["html"]
            if payload.inline_images and conv["attachments"]:
                html = await _inline_attachment_images(
                    svc, pid, html, conv["attachments"], warnings)

            existing = (
                db.query(WorkGuide).filter(WorkGuide.confluence_page_id == pid).first()
            )
            if existing is None:
                action = "create"
                changes: list[ConfluenceDocFieldChange] = []
            elif existing.confluence_version == version:
                action = "unchanged"
                changes = []
            else:
                action = "update"
                changes = _import_changes(existing, title, version)
                if existing.confluence_sync_status == "modified":
                    warnings.append("PEP 에서 수정된 문서입니다 — 가져오면 로컬 수정이 덮어써집니다.")
            if warnings:
                all_warnings.extend(f"「{title}」 {w}" for w in warnings)

            previews.append(ConfluenceDocImportPreview(
                page_id=pid, title=title, space_key=page.get("space_key", ""),
                version=version, action=action, warnings=warnings, changes=changes))

            if payload.dry_run:
                continue
            if only is not None and pid not in only:
                skipped += 1
                continue
            if action == "unchanged":
                skipped += 1
                continue

            now = datetime.utcnow()
            if existing is None:
                guide = WorkGuide(
                    title=title,
                    content=html,
                    category=category,
                    status=payload.guide_status or "active",
                    author=actor.username,
                    parent_id=payload.parent_guide_id,
                    source="confluence",
                    confluence_page_id=pid,
                    confluence_space_key=page.get("space_key") or None,
                    confluence_url=page.get("url") or None,
                    confluence_version=version,
                    confluence_synced_at=now,
                    confluence_sync_status="synced",
                    confluence_sync_error=None,
                )
                db.add(guide)
                imported += 1
            else:
                existing.title = title
                existing.content = html
                existing.confluence_space_key = page.get("space_key") or existing.confluence_space_key
                existing.confluence_url = page.get("url") or existing.confluence_url
                existing.confluence_version = version
                existing.confluence_synced_at = now
                existing.confluence_sync_status = "synced"
                existing.confluence_sync_error = None
                updated += 1
        except Exception as exc:  # noqa: BLE001 — 한 페이지 실패가 배치를 중단시키지 않는다
            logger.exception("Confluence import failed for page %s", pid)
            errors.append(f"{pid}: {str(exc)[:200]}")

    if payload.dry_run:
        return ConfluenceDocImportResult(
            status="ok", dry_run=True, errors=errors, warnings=all_warnings, items=previews)

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("Confluence import commit failed")
        return ConfluenceDocImportResult(
            status="error", dry_run=False, detail=f"저장 실패: {str(exc)[:200]}",
            errors=errors, warnings=all_warnings, items=previews)

    # 커밋 후 — 가져온 문서 임베딩 재계산 큐잉 (LLM 학습/시맨틱 검색 소스 편입)
    committed_ids = [
        row.id for row in
        db.query(WorkGuide.id).filter(WorkGuide.confluence_page_id.in_(page_ids)).all()
    ]
    for gid in committed_ids:
        _queue_embedding_recompute(gid)

    audit_logger.record(
        db, action="work_guide.confluence_import", actor=actor,
        target_type="work_guide", target_id=None,
        details={"imported": imported, "updated": updated, "skipped": skipped,
                 "errors": len(errors)},
    )
    return ConfluenceDocImportResult(
        status="ok", dry_run=False,
        detail=f"가져옴 {imported} · 갱신 {updated} · 건너뜀 {skipped}",
        imported=imported, updated=updated, skipped=skipped,
        errors=errors, warnings=all_warnings, items=previews)


# ── 내보내기 / 단건 재가져오기 ──────────────────────────────────────────────
@router.post("/docs/export/{guide_id}", response_model=ConfluenceDocExportResult)
async def export_doc(
    guide_id: UUID,
    payload: ConfluenceDocExportRequest | None = None,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """WorkGuide 를 Confluence 로 게시한다.

    이미 연결된 문서(page_id 보유)는 같은 페이지의 새 버전으로 갱신하고, 미연결 문서는
    스페이스(요청값 → 설정 기본값)에 새 페이지로 생성한 뒤 연결 정보를 역저장한다.
    본문의 base64 이미지는 페이지 첨부로 업로드해 `<ri:attachment>` 로 치환한다."""
    payload = payload or ConfluenceDocExportRequest()
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")

    cfg = _get_config(db)
    docs_settings = _get_docs_settings(db)
    svc, res = await _confluence_service_verified(db, actor, cfg)
    if svc is None or res.get("status") != "ok":
        return ConfluenceDocExportResult(
            status=res.get("status", "error"), detail=res.get("detail", "Confluence 세션 없음"))

    conv = editor_html_to_storage(guide.content or "")
    warnings = list(conv["warnings"])
    storage = conv["storage"] or "<p></p>"
    title = (payload.title or "").strip() or (
        f"{docs_settings.get('title_prefix') or ''}{guide.title}"
    )
    title = title[:255]

    if guide.confluence_page_id:
        # 기존 페이지 갱신 — 현재 버전을 조회해 +1 (원격에서 수정됐어도 최신 위에 게시)
        cur = await svc.get_page(guide.confluence_page_id)
        if cur.get("status") != "ok":
            guide.confluence_sync_status = "error"
            guide.confluence_sync_error = cur.get("detail", "페이지 조회 실패")
            db.commit()
            return ConfluenceDocExportResult(
                status=cur.get("status", "error"), detail=cur.get("detail", "페이지 조회 실패"))
        remote_version = cur["page"].get("version") or 1
        if guide.confluence_version and remote_version > guide.confluence_version:
            warnings.append(
                f"Confluence 쪽이 v{remote_version} 로 앞서 있었습니다 — 그 위에 새 버전으로 게시했습니다.")
        out = await svc.update_page(
            guide.confluence_page_id, title, storage, version=int(remote_version) + 1)
    else:
        space_key = (payload.space_key or docs_settings.get("space_key") or "").strip()
        if not space_key:
            return ConfluenceDocExportResult(
                status="error",
                detail="Confluence 스페이스 키를 지정하세요 (문서 동기화 설정 또는 게시 대화상자).")
        out = await svc.upsert_page(
            space_key, title, storage,
            parent_id=(payload.parent_page_id or docs_settings.get("parent_page_id") or ""),
        )

    if out.get("status") != "ok":
        guide.confluence_sync_status = "error" if guide.confluence_page_id else guide.confluence_sync_status
        guide.confluence_sync_error = out.get("detail", "게시 실패")
        db.commit()
        return ConfluenceDocExportResult(
            status=out.get("status", "error"), detail=out.get("detail", "게시 실패"),
            warnings=warnings)

    page_id = str(out.get("id") or guide.confluence_page_id or "")
    # base64 이미지 → 페이지 첨부 업로드 (참조는 storage 본문에 이미 들어 있음)
    for img in conv["data_images"]:
        up = await svc.upload_attachment(page_id, img["filename"], img["data"], img["mime"])
        if up.get("status") != "ok":
            warnings.append(f"첨부 '{img['filename']}' 업로드 실패 — 페이지에서 깨져 보일 수 있습니다.")

    # 게시 후 버전 확정 (update_page 는 응답에 version 포함, create 는 1)
    new_version = out.get("version")
    if new_version is None:
        after = await svc.get_page(page_id)
        new_version = (after.get("page") or {}).get("version") if after.get("status") == "ok" else None

    guide.confluence_page_id = page_id
    guide.confluence_url = out.get("url") or guide.confluence_url
    if not guide.confluence_space_key:
        guide.confluence_space_key = (payload.space_key or docs_settings.get("space_key") or "").strip() or None
    guide.confluence_version = new_version
    guide.confluence_synced_at = datetime.utcnow()
    guide.confluence_sync_status = "synced"
    guide.confluence_sync_error = None
    if not guide.source:
        guide.source = "pep"
    db.commit()

    audit_logger.record(
        db, action="work_guide.confluence_export", actor=actor,
        target_type="confluence_page", target_id=page_id,
        details={"guide_id": str(guide_id), "action": out.get("action"), "title": title},
    )
    return ConfluenceDocExportResult(
        status="ok",
        detail=f"Confluence 에 {('생성' if out.get('action') == 'created' else '갱신')}되었습니다.",
        action=out.get("action", ""), page_id=page_id, page_url=out.get("url"),
        version=new_version, warnings=warnings)


@router.post("/docs/pull/{guide_id}", response_model=ConfluenceDocPullResult)
async def pull_doc(
    guide_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """연결된 Confluence 페이지 내용으로 문서를 다시 가져온다 (로컬 본문 덮어쓰기)."""
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    if not guide.confluence_page_id:
        return ConfluenceDocPullResult(
            status="error", detail="Confluence 페이지와 연결되지 않은 문서입니다.")

    cfg = _get_config(db)
    svc, res = await _confluence_service_verified(db, actor, cfg)
    if svc is None or res.get("status") != "ok":
        return ConfluenceDocPullResult(
            status=res.get("status", "error"), detail=res.get("detail", "Confluence 세션 없음"))

    page_res = await svc.get_page(guide.confluence_page_id)
    if page_res.get("status") != "ok":
        guide.confluence_sync_status = "error"
        guide.confluence_sync_error = page_res.get("detail", "조회 실패")
        db.commit()
        return ConfluenceDocPullResult(
            status=page_res.get("status", "error"), detail=page_res.get("detail", "조회 실패"))
    page = page_res["page"]
    conv = storage_to_editor_html(
        page.get("body_storage") or "",
        base_url=(cfg.get("confluence_base_url") or "").strip(),
        page_id=guide.confluence_page_id,
    )
    guide.title = (page.get("title") or guide.title).strip()[:200]
    guide.content = conv["html"]
    guide.confluence_space_key = page.get("space_key") or guide.confluence_space_key
    guide.confluence_url = page.get("url") or guide.confluence_url
    guide.confluence_version = page.get("version")
    guide.confluence_synced_at = datetime.utcnow()
    guide.confluence_sync_status = "synced"
    guide.confluence_sync_error = None
    db.commit()
    _queue_embedding_recompute(guide.id)
    audit_logger.record(
        db, action="work_guide.confluence_pull", actor=actor,
        target_type="work_guide", target_id=str(guide_id),
        details={"page_id": guide.confluence_page_id, "version": page.get("version")},
    )
    return ConfluenceDocPullResult(
        status="ok", detail="Confluence 내용으로 갱신했습니다.",
        guide_id=guide_id, version=page.get("version"), warnings=conv["warnings"])
