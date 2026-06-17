from uuid import UUID
from typing import Optional, List
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.knowledge_page import KnowledgePage, KnowledgePageVersion, KnowledgePresence
from app.models.user import User
from app.auth.deps import require_operator, require_admin, get_current_user
from app.schemas.knowledge import (
    KnowledgePageCreate,
    KnowledgePageUpdate,
    KnowledgePageResponse,
    KnowledgePageListResponse,
    KnowledgePageNode,
    KnowledgeTreeResponse,
    KnowledgePageMove,
    KnowledgeReorder,
    MilestoneCreate,
    KnowledgeVersionResponse,
    KnowledgeVersionDetail,
    KnowledgeVersionListResponse,
    PresenceResponse,
    PresenceUser,
    ImportResult,
)

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="문서를 찾을 수 없습니다.")


def _can_view(page: KnowledgePage, user: User) -> bool:
    """파트 공유는 모두 열람, 비공개는 소유자/관리자만."""
    if page.visibility != "private":
        return True
    return user.role == "admin" or page.created_by == user.username


def _next_version_no(db: Session, page_id: UUID) -> int:
    cur = db.query(func.max(KnowledgePageVersion.version_no)).filter(
        KnowledgePageVersion.page_id == page_id
    ).scalar()
    return (cur or 0) + 1


def _snapshot(db: Session, page: KnowledgePage, *, kind: str, author: str, label: Optional[str] = None) -> None:
    """현재 page 상태를 버전으로 저장. commit 은 호출자에서."""
    db.add(KnowledgePageVersion(
        page_id=page.id,
        version_no=_next_version_no(db, page.id),
        kind=kind,
        label=label,
        title=page.title,
        content=page.content,
        author=author,
    ))


# ── 페이지 목록 / 트리 ──────────────────────────────────────────────────────

@router.get("/pages", response_model=KnowledgePageListResponse)
def list_pages(
    service: Optional[str] = None,
    category: Optional[str] = None,
    kind: Optional[str] = None,
    page_status: Optional[str] = None,
    parent_id: Optional[UUID] = None,
    q: Optional[str] = None,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(KnowledgePage)
    if service:
        query = query.filter(KnowledgePage.service == service)
    if category:
        query = query.filter(KnowledgePage.category == category)
    if kind:
        query = query.filter(KnowledgePage.kind == kind)
    if page_status:
        query = query.filter(KnowledgePage.status == page_status)
    if parent_id is not None:
        query = query.filter(KnowledgePage.parent_id == parent_id)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (KnowledgePage.title.ilike(like)) | (KnowledgePage.summary.ilike(like))
        )
    rows = query.order_by(KnowledgePage.sort_order.asc(), KnowledgePage.created_at.asc()).all()
    visible = [p for p in rows if _can_view(p, actor)]
    return KnowledgePageListResponse(data=visible)


@router.get("/pages/tree", response_model=KnowledgeTreeResponse)
def page_tree(
    service: Optional[str] = None,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(KnowledgePage)
    if service:
        query = query.filter(KnowledgePage.service == service)
    rows = [p for p in query.all() if _can_view(p, actor)]
    rows.sort(key=lambda p: (p.sort_order or 0, p.created_at or 0))

    by_parent: dict = {}
    for p in rows:
        by_parent.setdefault(p.parent_id, []).append(p)

    def build(parent_id) -> List[KnowledgePageNode]:
        out: List[KnowledgePageNode] = []
        for p in by_parent.get(parent_id, []):
            node = KnowledgePageNode.model_validate(p)
            node.children = build(p.id)
            out.append(node)
        return out

    # 루트 = parent_id 가 None 인 노드 (서비스 필터가 있으면 그 서비스의 루트들)
    return KnowledgeTreeResponse(data=build(None))


@router.get("/roadmap", response_model=KnowledgePageListResponse)
def roadmap(
    service: Optional[str] = None,
    category: Optional[str] = "enhancement",
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """일정(start_at/due_at) 또는 스프린트가 지정된 항목 — 고도화 로드맵 타임라인용.

    기본 category=enhancement(고도화). category 가 빈 문자열이면 분류 무관 전체.
    """
    query = db.query(KnowledgePage)
    if service:
        query = query.filter(KnowledgePage.service == service)
    if category:
        query = query.filter(KnowledgePage.category == category)
    rows = [
        p for p in query.all()
        if _can_view(p, actor) and (p.start_at or p.due_at or p.sprint_id)
    ]
    rows.sort(key=lambda p: (p.start_at or p.due_at or p.created_at))
    return KnowledgePageListResponse(data=rows)


@router.post("/reorder", status_code=status.HTTP_204_NO_CONTENT)
def reorder(
    payload: KnowledgeReorder,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    """형제 노드 정렬 — ordered_ids 순서대로 sort_order/parent_id 재부여."""
    for idx, pid in enumerate(payload.ordered_ids):
        page = db.query(KnowledgePage).filter(KnowledgePage.id == pid).first()
        if not page:
            continue
        page.parent_id = payload.parent_id
        page.sort_order = idx
        page.updated_by = actor.username
    db.commit()


@router.get("/pages/{page_id}", response_model=KnowledgePageResponse)
def get_page(
    page_id: UUID,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    return page


# ── 생성 / 수정 / 삭제 ──────────────────────────────────────────────────────

@router.post("/pages", response_model=KnowledgePageResponse, status_code=status.HTTP_201_CREATED)
def create_page(
    payload: KnowledgePageCreate,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = KnowledgePage(
        **payload.model_dump(),
        created_by=actor.username,
        updated_by=actor.username,
    )
    db.add(page)
    db.flush()
    # 최초 버전 스냅샷 (v1, auto)
    _snapshot(db, page, kind="auto", author=actor.username)
    db.commit()
    db.refresh(page)
    return page


@router.put("/pages/{page_id}", response_model=KnowledgePageResponse)
def update_page(
    page_id: UUID,
    payload: KnowledgePageUpdate,
    expected_updated_at: Optional[datetime] = None,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    # 저장 충돌 감지 — 클라이언트가 마지막으로 본 updated_at 과 서버 현재값이 다르면 409.
    if expected_updated_at is not None and page.updated_at is not None:
        cur = page.updated_at.replace(tzinfo=None)
        exp = expected_updated_at.replace(tzinfo=None)
        if abs((cur - exp).total_seconds()) > 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"다른 사용자가 먼저 수정했습니다 (수정자: {page.updated_by or '알 수 없음'}). 새로고침 후 다시 저장하세요.",
            )

    data = payload.model_dump(exclude_unset=True)
    # 본문이 실제로 바뀌면, 변경 전 상태를 자동 스냅샷으로 보존.
    content_changes = "content" in data and (data.get("content") or "") != (page.content or "")
    if content_changes:
        _snapshot(db, page, kind="auto", author=actor.username)

    for k, v in data.items():
        setattr(page, k, v)
    page.updated_by = actor.username
    db.commit()
    db.refresh(page)
    return page


@router.post("/pages/{page_id}/move", response_model=KnowledgePageResponse)
def move_page(
    page_id: UUID,
    payload: KnowledgePageMove,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    page.parent_id = payload.parent_id
    page.sort_order = payload.sort_order
    page.updated_by = actor.username
    db.commit()
    db.refresh(page)
    return page


@router.delete("/pages/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_page(
    page_id: UUID,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if page.visibility == "private" and actor.role != "admin" and page.created_by != actor.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="삭제 권한이 없습니다.")
    # 자식까지 정리 + 버전 삭제
    child_ids = [c.id for c in db.query(KnowledgePage).filter(KnowledgePage.parent_id == page_id).all()]
    for cid in child_ids:
        db.query(KnowledgePageVersion).filter(KnowledgePageVersion.page_id == cid).delete()
        db.query(KnowledgePage).filter(KnowledgePage.id == cid).delete()
    db.query(KnowledgePageVersion).filter(KnowledgePageVersion.page_id == page_id).delete()
    db.delete(page)
    db.commit()


# ── 버전(히스토리) ──────────────────────────────────────────────────────────

@router.get("/pages/{page_id}/versions", response_model=KnowledgeVersionListResponse)
def list_versions(
    page_id: UUID,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    rows = db.query(KnowledgePageVersion).filter(
        KnowledgePageVersion.page_id == page_id
    ).order_by(KnowledgePageVersion.version_no.desc()).all()
    return KnowledgeVersionListResponse(data=rows)


@router.post("/pages/{page_id}/versions", response_model=KnowledgeVersionResponse, status_code=status.HTTP_201_CREATED)
def save_milestone(
    page_id: UUID,
    payload: MilestoneCreate,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    ver = KnowledgePageVersion(
        page_id=page.id,
        version_no=_next_version_no(db, page.id),
        kind="milestone",
        label=payload.label,
        title=page.title,
        content=page.content,
        author=actor.username,
    )
    db.add(ver)
    db.commit()
    db.refresh(ver)
    return ver


@router.get("/versions/{version_id}", response_model=KnowledgeVersionDetail)
def get_version(
    version_id: UUID,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ver = db.query(KnowledgePageVersion).filter(KnowledgePageVersion.id == version_id).first()
    if not ver:
        raise _not_found()
    page = db.query(KnowledgePage).filter(KnowledgePage.id == ver.page_id).first()
    if page and not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    return ver


@router.post("/pages/{page_id}/restore/{version_id}", response_model=KnowledgePageResponse)
def restore_version(
    page_id: UUID,
    version_id: UUID,
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    ver = db.query(KnowledgePageVersion).filter(
        KnowledgePageVersion.id == version_id,
        KnowledgePageVersion.page_id == page_id,
    ).first()
    if not ver:
        raise _not_found()
    # 되돌리기 직전 상태도 자동 스냅샷으로 남겨 추적.
    _snapshot(db, page, kind="auto", author=actor.username)
    page.title = ver.title or page.title
    page.content = ver.content
    page.updated_by = actor.username
    db.commit()
    db.refresh(page)
    return page


# ── 백링크 (이 문서를 참조하는 곳) ──────────────────────────────────────────

@router.get("/pages/{page_id}/backlinks", response_model=KnowledgePageListResponse)
def backlinks(
    page_id: UUID,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """본문에 `/knowledge/{page_id}` 내부 링크([[ ]])를 가진 페이지 목록 — linked references."""
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")
    needle = f"/knowledge/{page_id}"
    rows = db.query(KnowledgePage).filter(
        KnowledgePage.id != page_id,
        KnowledgePage.content.ilike(f"%{needle}%"),
    ).all()
    visible = [p for p in rows if _can_view(p, actor)]
    return KnowledgePageListResponse(data=visible)


# ── 경량 협업: '편집 중' 표시 (폴링) ─────────────────────────────────────────

PRESENCE_TTL = 30  # seconds


@router.post("/pages/{page_id}/heartbeat", response_model=PresenceResponse)
def heartbeat(
    page_id: UUID,
    actor: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.utcnow()
    row = db.query(KnowledgePresence).filter(
        KnowledgePresence.page_id == page_id,
        KnowledgePresence.username == actor.username,
    ).first()
    if row:
        row.last_seen = now
        row.display_name = actor.display_name
    else:
        db.add(KnowledgePresence(
            page_id=page_id, username=actor.username,
            display_name=actor.display_name, last_seen=now,
        ))
    db.commit()
    cutoff = now - timedelta(seconds=PRESENCE_TTL)
    others = db.query(KnowledgePresence).filter(
        KnowledgePresence.page_id == page_id,
        KnowledgePresence.last_seen >= cutoff,
        KnowledgePresence.username != actor.username,
    ).all()
    return PresenceResponse(editors=[
        PresenceUser(username=o.username, display_name=o.display_name) for o in others
    ])


# ── 비파괴 가져오기: 기존 자산 → 지식베이스 복사 (원본 유지, 중복 방지) ────────

def _exists(db: Session, ref: str) -> bool:
    return db.query(KnowledgePage.id).filter(KnowledgePage.source_ref == ref).first() is not None


def _import_ops_notes(db: Session, actor: User) -> tuple[int, int]:
    from app.models.ops_note import OpsNote
    imported = skipped = 0
    for o in db.query(OpsNote).all():
        ref = f"ops_note:{o.id}"
        if _exists(db, ref):
            skipped += 1
            continue
        content = o.content or ""
        if o.back_content:
            content += f"<hr><p><strong>히스토리/비고</strong></p>{o.back_content}"
        db.add(KnowledgePage(
            service=o.service, parent_id=None, kind="doc", category="operation",
            title=o.title, content=content, status="active", visibility="part",
            pinned=bool(o.pinned), confluence_url=o.confluence_url,
            created_by=o.author or actor.username, updated_by=actor.username, source_ref=ref,
        ))
        imported += 1
    db.commit()
    return imported, skipped


def _import_service_entries(db: Session, actor: User) -> tuple[int, int]:
    from app.models.service_entry import ServiceEntry
    imported = skipped = 0
    for e in db.query(ServiceEntry).all():
        ref = f"service_entry:{e.id}"
        if _exists(db, ref):
            skipped += 1
            continue
        db.add(KnowledgePage(
            service=e.service, parent_id=None, kind="doc", category=None,
            title=e.title or "(제목 없음)", content=e.content or e.url or "",
            tags=e.tags if isinstance(e.tags, list) else None,
            status="active", visibility="part", pinned=bool(e.pinned),
            created_by=e.author or actor.username, updated_by=actor.username, source_ref=ref,
        ))
        imported += 1
    db.commit()
    return imported, skipped


def _import_work_guides(db: Session, actor: User) -> tuple[int, int]:
    from app.models.work_guide import WorkGuide
    imported = skipped = 0
    guides = db.query(WorkGuide).all()
    # 1차: 노드 생성(부모 미설정)
    for g in guides:
        ref = f"work_guide:{g.id}"
        if _exists(db, ref):
            skipped += 1
            continue
        tags = [t.strip() for t in (g.tags or "").split(",") if t.strip()] or None
        db.add(KnowledgePage(
            service=None, parent_id=None, kind="doc", category=g.category,
            title=g.title, content=g.content, tags=tags,
            status=g.status or "active", visibility="part",
            sort_order=g.sort_order or 0, confluence_url=g.confluence_url,
            created_by=g.author or actor.username, updated_by=actor.username, source_ref=ref,
        ))
        imported += 1
    db.commit()
    # 2차: 부모 관계 재매핑 (source_ref 로 새 id 조회)
    by_ref = {p.source_ref: p for p in db.query(KnowledgePage).filter(
        KnowledgePage.source_ref.ilike("work_guide:%")
    ).all()}
    for g in guides:
        if not g.parent_id:
            continue
        child = by_ref.get(f"work_guide:{g.id}")
        parent = by_ref.get(f"work_guide:{g.parent_id}")
        if child and parent and child.parent_id is None:
            child.parent_id = parent.id
    db.commit()
    return imported, skipped


@router.post("/import", response_model=ImportResult)
def import_existing(
    source: str = "all",
    actor: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """기존 운영노트/작업가이드/서비스엔트리를 지식베이스로 복사(비파괴·중복 방지). 관리자 전용."""
    detail: dict = {}
    total_imported = total_skipped = 0
    jobs = {
        "ops_notes": _import_ops_notes,
        "service_entries": _import_service_entries,
        "work_guides": _import_work_guides,
    }
    targets = jobs.keys() if source == "all" else [source]
    for key in targets:
        fn = jobs.get(key)
        if not fn:
            continue
        try:
            imp, skp = fn(db, actor)
        except Exception as e:  # noqa: BLE001 — 한 소스 실패가 전체를 막지 않도록
            db.rollback()
            detail[key] = f"error: {e}"
            continue
        detail[key] = {"imported": imp, "skipped": skp}
        total_imported += imp
        total_skipped += skp
    return ImportResult(imported=total_imported, skipped=total_skipped, detail=detail)
