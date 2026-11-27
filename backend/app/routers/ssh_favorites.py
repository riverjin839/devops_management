"""SSH 터미널 즐겨찾기 명령 CRUD — 본인 것만(서버 저장, 다른 PC·브라우저에서도 같다).

첫 목록 조회 때 기본 명령을 시드한다(``services/ssh_favorites.ensure_seeded``). 기본 명령 삭제는 숨김,
사용자가 만든 명령 삭제는 행 삭제. 「기본값 복원」은 기본 명령만 원래대로 되돌린다.
"""
import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.ssh_favorite import SshFavoriteCommand
from app.models.user import User
from app.schemas.ssh_favorite import (
    SshFavoriteCreate,
    SshFavoriteReorder,
    SshFavoriteResponse,
    SshFavoriteUpdate,
)
from app.services import ssh_favorites as svc

router = APIRouter(prefix="/ssh-favorites", tags=["ssh-favorites"])

MAX_FAVORITES = 200


def _owned(db: Session, fav_id: str, user: User) -> SshFavoriteCommand:
    try:
        fid = uuid_mod.UUID(str(fav_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="즐겨찾기 명령을 찾을 수 없습니다.")
    row = db.query(SshFavoriteCommand).filter(SshFavoriteCommand.id == fid, SshFavoriteCommand.hidden.is_(False)).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="즐겨찾기 명령을 찾을 수 없습니다.")
    if row.username != user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="본인 즐겨찾기만 바꿀 수 있습니다.")
    return row


def _visible(db: Session, username: str) -> list[SshFavoriteCommand]:
    return (
        db.query(SshFavoriteCommand)
        .filter(SshFavoriteCommand.username == username, SshFavoriteCommand.hidden.is_(False))
        .order_by(SshFavoriteCommand.sort_order, SshFavoriteCommand.created_at)
        .all()
    )


@router.get("", response_model=list[SshFavoriteResponse])
def list_ssh_favorites(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """내 즐겨찾기 명령 — 화면 순서대로. 처음이면 기본 명령을 먼저 복사한다."""
    svc.ensure_seeded(db, user.username)
    return [svc.to_response(r) for r in _visible(db, user.username)]


@router.post("", response_model=SshFavoriteResponse, status_code=status.HTTP_201_CREATED)
def create_ssh_favorite(payload: SshFavoriteCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    svc.ensure_seeded(db, user.username)
    count = db.query(func.count(SshFavoriteCommand.id)).filter(
        SshFavoriteCommand.username == user.username, SshFavoriteCommand.hidden.is_(False),
    ).scalar() or 0
    if count >= MAX_FAVORITES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"즐겨찾기는 {MAX_FAVORITES}개까지 저장할 수 있습니다.")
    last = db.query(func.max(SshFavoriteCommand.sort_order)).filter(SshFavoriteCommand.username == user.username).scalar()
    row = SshFavoriteCommand(username=user.username, sort_order=(last if last is not None else -1) + 1, **payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return svc.to_response(row)


@router.put("/order", response_model=list[SshFavoriteResponse])
def reorder_ssh_favorites(payload: SshFavoriteReorder, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """보이는 명령 전부의 새 순서. 목록과 다르면(다른 창에서 바뀜) 409 — 화면이 다시 읽는다."""
    rows = _visible(db, user.username)
    by_id = {r.id: r for r in rows}
    if len(payload.ids) != len(rows) or set(payload.ids) != set(by_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="목록이 바뀌었습니다 — 다시 불러온 뒤 순서를 바꾸세요.")
    for i, fid in enumerate(payload.ids):
        by_id[fid].sort_order = i
    db.commit()
    return [svc.to_response(r) for r in _visible(db, user.username)]


@router.post("/reset", response_model=list[SshFavoriteResponse])
def reset_ssh_favorites(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """기본값 복원 — 기본 명령만 원래 내용·순서로(지운 것도 되살림). 내가 만든 명령은 유지."""
    svc.reset_presets(db, user.username)
    return [svc.to_response(r) for r in _visible(db, user.username)]


@router.put("/{fav_id}", response_model=SshFavoriteResponse)
def update_ssh_favorite(fav_id: str, payload: SshFavoriteUpdate, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    row = _owned(db, fav_id, user)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return svc.to_response(row)


@router.delete("/{fav_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ssh_favorite(fav_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = _owned(db, fav_id, user)
    if row.preset_key:
        row.hidden = True  # 기본 명령은 숨김 — 다시 시드되지 않고 「기본값 복원」으로 되살린다
    else:
        db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
