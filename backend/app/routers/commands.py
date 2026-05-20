from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy import or_

from app.database import get_db
from app.models.command_entry import CommandEntry
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.command_entry import (
    CommandEntryCreate,
    CommandEntryUpdate,
    CommandEntryResponse,
    CommandEntryListResponse,
)

router = APIRouter(prefix="/commands", tags=["commands"])


# importance 정렬 우선순위 — critical 이 위로.
_IMPORTANCE_RANK = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
    "info": 4,
}


@router.get("", response_model=CommandEntryListResponse)
def list_commands(
    category: str | None = Query(default=None),
    importance: str | None = Query(default=None),
    q: str | None = Query(default=None, description="명령어 / 의미 / 주의사항 / 태그 부분일치"),
    db: Session = Depends(get_db),
):
    """주요 명령어 목록 — pinned > importance(critical 우선) > sort_order > updated_at 으로 정렬."""
    query = db.query(CommandEntry)
    if category:
        query = query.filter(CommandEntry.category == category)
    if importance:
        query = query.filter(CommandEntry.importance == importance)
    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                CommandEntry.command.ilike(like),
                CommandEntry.description.ilike(like),
                CommandEntry.caution.ilike(like),
                CommandEntry.tags.ilike(like),
                CommandEntry.category.ilike(like),
            )
        )
    entries = query.all()
    # importance 는 문자열이라 SQL 정렬로는 알파벳순 — 파이썬에서 의미 있는 순서로 다시 정렬.
    entries.sort(
        key=lambda e: (
            not e.pinned,
            _IMPORTANCE_RANK.get(e.importance, 99),
            e.sort_order,
            -(e.updated_at.timestamp() if e.updated_at else 0),
        )
    )
    return CommandEntryListResponse(data=entries, total=len(entries))


@router.get("/{entry_id}", response_model=CommandEntryResponse)
def get_command(entry_id: str, db: Session = Depends(get_db)):
    entry = db.query(CommandEntry).filter(CommandEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command not found")
    return entry


@router.post("", response_model=CommandEntryResponse, status_code=status.HTTP_201_CREATED)
def create_command(
    payload: CommandEntryCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    entry = CommandEntry(
        id=str(uuid4()),
        **payload.model_dump(),
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.put("/{entry_id}", response_model=CommandEntryResponse)
def update_command(
    entry_id: str,
    payload: CommandEntryUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    entry = db.query(CommandEntry).filter(CommandEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(entry, key, value)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_command(
    entry_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    entry = db.query(CommandEntry).filter(CommandEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Command not found")
    db.delete(entry)
    db.commit()
    return None
