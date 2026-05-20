from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.ops_note import OpsNote
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.ops_note import OpsNoteCreate, OpsNoteUpdate, OpsNoteResponse, OpsNoteListResponse

router = APIRouter(prefix="/ops-notes", tags=["ops-notes"])


@router.get("", response_model=OpsNoteListResponse)
def list_ops_notes(
    service: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """업무 메모 목록 조회"""
    query = db.query(OpsNote)
    if service:
        query = query.filter(OpsNote.service == service)
    notes = query.order_by(OpsNote.pinned.desc(), OpsNote.updated_at.desc()).all()
    return OpsNoteListResponse(data=notes, total=len(notes))


@router.get("/{note_id}", response_model=OpsNoteResponse)
def get_ops_note(note_id: str, db: Session = Depends(get_db)):
    note = db.query(OpsNote).filter(OpsNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return note


@router.post("", response_model=OpsNoteResponse, status_code=status.HTTP_201_CREATED)
def create_ops_note(
    payload: OpsNoteCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
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
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


@router.put("/{note_id}", response_model=OpsNoteResponse)
def update_ops_note(
    note_id: str,
    payload: OpsNoteUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    note = db.query(OpsNote).filter(OpsNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(note, key, value)
    db.commit()
    db.refresh(note)
    return note


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ops_note(
    note_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    note = db.query(OpsNote).filter(OpsNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    db.delete(note)
    db.commit()
    return None
