"""노드 일괄 실행(bulk-exec)에서 재사용하는 사용자별 저장 스크립트 CRUD.

본인 소유 스크립트만 조회/수정/삭제 가능 — `_get_owned_script` 가 소유자
불일치 시 403 을 낸다(agent.py 의 대화(conversation) 소유권 검사와 동일 패턴).
"""
import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.saved_script import SavedScript
from app.models.user import User
from app.schemas.saved_script import (
    SavedScriptCreate,
    SavedScriptResponse,
    SavedScriptUpdate,
)

router = APIRouter(prefix="/saved-scripts", tags=["saved-scripts"])


def _get_owned_script(db: Session, script_id: str, user: User) -> SavedScript:
    try:
        sid = uuid_mod.UUID(str(script_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="스크립트를 찾을 수 없습니다.")
    script = db.query(SavedScript).filter(SavedScript.id == sid).first()
    if script is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="스크립트를 찾을 수 없습니다.")
    if script.username != user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="본인 스크립트만 접근할 수 있습니다.")
    return script


@router.get("", response_model=list[SavedScriptResponse])
def list_saved_scripts(
    language: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """내 저장 스크립트 목록 — 최근 수정순."""
    q = db.query(SavedScript).filter(SavedScript.username == user.username)
    if language:
        q = q.filter(SavedScript.language == language)
    return q.order_by(desc(SavedScript.updated_at)).all()


@router.post("", response_model=SavedScriptResponse, status_code=status.HTTP_201_CREATED)
def create_saved_script(
    payload: SavedScriptCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    script = SavedScript(username=user.username, **payload.model_dump())
    db.add(script)
    db.commit()
    db.refresh(script)
    return script


@router.get("/{script_id}", response_model=SavedScriptResponse)
def get_saved_script(
    script_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _get_owned_script(db, script_id, user)


@router.put("/{script_id}", response_model=SavedScriptResponse)
def update_saved_script(
    script_id: str,
    payload: SavedScriptUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    script = _get_owned_script(db, script_id, user)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(script, key, value)
    db.commit()
    db.refresh(script)
    return script


@router.delete("/{script_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_saved_script(
    script_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    script = _get_owned_script(db, script_id, user)
    db.delete(script)
    db.commit()
    return None
