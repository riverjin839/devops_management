from uuid import UUID
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.knowledge_page import KnowledgePage, KnowledgePageVersion
from app.models.user import User
from app.auth.deps import require_operator, get_current_user
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
    actor: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    page = db.query(KnowledgePage).filter(KnowledgePage.id == page_id).first()
    if not page:
        raise _not_found()
    if not _can_view(page, actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비공개 문서입니다.")

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
