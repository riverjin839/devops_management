"""사용자 VOC(Voice of Customer) 게시판.

전체 공개 board — 모든 인증 사용자가 목록/상세를 열람한다. 작성은 로그인 사용자,
수정/삭제는 작성자 본인 또는 관리자(admin/operator), 답변/상태 변경은 관리자만.
Ops Notes 라우터를 템플릿으로 하되 작성자 소유권(`created_by`) 검사를 추가한다.
"""
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.voc_post import VocPost
from app.auth.deps import get_current_user, require_operator
from app.schemas.voc import VocCreate, VocUpdate, VocReply, VocResponse, VocListResponse
from app.services.user_notify import notify_voc_reply

router = APIRouter(prefix="/voc", tags=["voc"])


def _is_staff(user: User) -> bool:
    effective = "viewer" if user.role == "user" else user.role
    return effective in ("admin", "operator")


def _get_or_404(db: Session, voc_id: str) -> VocPost:
    post = db.query(VocPost).filter(VocPost.id == voc_id).first()
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="VOC 글을 찾을 수 없습니다.")
    return post


@router.get("", response_model=VocListResponse)
def list_voc(
    category: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
):
    """VOC 목록(전체 공개). category / status 필터."""
    query = db.query(VocPost)
    if category:
        query = query.filter(VocPost.category == category)
    if status_filter:
        query = query.filter(VocPost.status == status_filter)
    posts = query.order_by(VocPost.created_at.desc()).all()
    return VocListResponse(data=posts, total=len(posts))


@router.get("/{voc_id}", response_model=VocResponse)
def get_voc(voc_id: str, db: Session = Depends(get_db)):
    return _get_or_404(db, voc_id)


@router.post("", response_model=VocResponse, status_code=status.HTTP_201_CREATED)
def create_voc(
    payload: VocCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    post = VocPost(
        id=str(uuid4()),
        title=payload.title,
        content=payload.content,
        category=payload.category,
        status="접수",
        author=(actor.display_name or actor.username),
        created_by=actor.username,
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


@router.put("/{voc_id}", response_model=VocResponse)
def update_voc(
    voc_id: str,
    payload: VocUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    post = _get_or_404(db, voc_id)
    if post.created_by != actor.username and not _is_staff(actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="본인 글만 수정할 수 있습니다.")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(post, key, value)
    db.commit()
    db.refresh(post)
    return post


@router.post("/{voc_id}/reply", response_model=VocResponse)
def reply_voc(
    voc_id: str,
    payload: VocReply,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """관리자 답변 / 상태 변경. 답변이 있으면 작성자에게 알림."""
    post = _get_or_404(db, voc_id)
    replied = False
    if payload.admin_reply is not None:
        post.admin_reply = payload.admin_reply
        post.admin_reply_by = (actor.display_name or actor.username)
        post.admin_reply_at = datetime.utcnow()
        replied = bool(payload.admin_reply.strip())
    if payload.status is not None:
        post.status = payload.status
    db.commit()
    db.refresh(post)

    if replied:
        try:
            notify_voc_reply(db, post, actor, post.admin_reply)
            db.commit()
        except Exception:  # noqa: BLE001 — 알림 실패가 답변 자체를 막지 않도록.
            db.rollback()
    return post


@router.delete("/{voc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_voc(
    voc_id: str,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
):
    post = _get_or_404(db, voc_id)
    if post.created_by != actor.username and not _is_staff(actor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="본인 글만 삭제할 수 있습니다.")
    db.delete(post)
    db.commit()
    return None
