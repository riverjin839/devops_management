from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.ops_note import OpsNote
from app.models.user import User
from app.auth.deps import get_tenant_scope, require_operator
from app.services.tenant_scope import TenantScope
from app.schemas.ops_note import OpsNoteCreate, OpsNoteUpdate, OpsNoteResponse, OpsNoteListResponse

router = APIRouter(prefix="/ops-notes", tags=["ops-notes"])


def _queue_embedding_recompute(ops_note_id) -> None:
    """RAG 검색용 임베딩 재계산 큐잉 — best-effort (work_guide.py 의 동일 헬퍼 패턴)."""
    try:
        from app.celery_app import compute_ops_note_embedding
        compute_ops_note_embedding.delay(str(ops_note_id))
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Failed to queue embedding recompute for ops_note %s", ops_note_id
        )


@router.get("", response_model=OpsNoteListResponse)
def list_ops_notes(
    service: str | None = Query(default=None),
    db: Session = Depends(get_db),
    scope: TenantScope = Depends(get_tenant_scope),
):
    """업무 메모 목록 조회 — 내가 볼 수 없는 테넌트의 메모는 제외."""
    query = scope.apply(db.query(OpsNote), OpsNote.tenant_id)
    if service:
        query = query.filter(OpsNote.service == service)
    notes = query.order_by(OpsNote.pinned.desc(), OpsNote.updated_at.desc()).all()
    return OpsNoteListResponse(data=notes, total=len(notes))


@router.get("/{note_id}", response_model=OpsNoteResponse)
def get_ops_note(note_id: str, db: Session = Depends(get_db),
                 scope: TenantScope = Depends(get_tenant_scope)):
    note = db.query(OpsNote).filter(OpsNote.id == note_id).first()
    if not note or not scope.visible(note.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return note


@router.post("", response_model=OpsNoteResponse, status_code=status.HTTP_201_CREATED)
def create_ops_note(
    payload: OpsNoteCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
    scope: TenantScope = Depends(get_tenant_scope),
):
    scope.ensure_assignable(payload.tenant_id)
    note = OpsNote(
        id=str(uuid4()),
        service=payload.service,
        title=payload.title,
        content=payload.content,
        back_content=payload.back_content,
        color=payload.color,
        author=payload.author,
        pinned=payload.pinned,
        confluence_url=payload.confluence_url,
        dl_url=payload.dl_url,
        tenant_id=payload.tenant_id,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    _queue_embedding_recompute(note.id)  # 비동기 — 쓰기 응답 속도에 영향 없음
    return note


@router.put("/{note_id}", response_model=OpsNoteResponse)
def update_ops_note(
    note_id: str,
    payload: OpsNoteUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
    scope: TenantScope = Depends(get_tenant_scope),
):
    note = db.query(OpsNote).filter(OpsNote.id == note_id).first()
    if not note or not scope.visible(note.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    if "tenant_id" in payload.model_fields_set:
        scope.ensure_assignable(payload.tenant_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(note, key, value)
    db.commit()
    db.refresh(note)
    _queue_embedding_recompute(note.id)
    return note


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ops_note(
    note_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
    scope: TenantScope = Depends(get_tenant_scope),
):
    note = db.query(OpsNote).filter(OpsNote.id == note_id).first()
    if not note or not scope.visible(note.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    db.delete(note)
    db.commit()
    return None
