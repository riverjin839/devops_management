"""Your Island — 사용자 커스텀 화면 CRUD.

아일랜드는 사용자가 자주 쓰는 PEP 화면(라우트)을 모아둔 개인 화면이다. 소유자만 수정할 수
있고, `is_shared=True` 로 두면 다른 인증 사용자에게 읽기 전용으로 노출되어 복제할 수 있다.

저장된 `panels` 는 과거 버전이 남긴 형식이거나 사라진 라우트를 가리킬 수 있으므로, 읽기·쓰기
양쪽에서 `_normalize_panels()` 로 방어적으로 정규화한다 (terminal_appearance.py 와 같은 사상).
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.island import Island
from app.models.user import User
from app.schemas.island import (
    MAX_PANELS,
    IslandCreate,
    IslandListResponse,
    IslandReorder,
    IslandResponse,
    IslandUpdate,
)

router = APIRouter(prefix="/islands", tags=["islands"])

VALID_LAYOUT_MODES = {"tabs", "sidebar"}


def _normalize_panels(raw) -> list[dict]:
    """저장/응답용 패널 배열 정규화 — 형식이 깨진 항목은 조용히 드롭한다."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    seen_keys: set[str] = set()
    for idx, item in enumerate(raw):
        if hasattr(item, "model_dump"):
            item = item.model_dump()
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if not isinstance(path, str) or not path.strip():
            continue
        key = item.get("key")
        if not isinstance(key, str) or not key.strip() or key in seen_keys:
            key = f"p{idx}-{uuid4().hex[:8]}"
        seen_keys.add(key)
        label = item.get("label")
        icon = item.get("icon")
        out.append({
            "key": key,
            "path": path.strip()[:200],
            "label": label[:100] if isinstance(label, str) and label.strip() else None,
            "icon": icon[:50] if isinstance(icon, str) and icon.strip() else None,
        })
        if len(out) >= MAX_PANELS:
            break
    return out


def _owner_name(user: User) -> str | None:
    name = (user.display_name or user.username or "").strip()
    return name[:100] or None


def _to_response(island: Island) -> IslandResponse:
    """DB row → 응답. 저장된 panels 가 깨져 있어도 500 대신 정규화된 값을 돌려준다."""
    return IslandResponse(
        id=island.id,
        owner_id=island.owner_id,
        owner_name=island.owner_name,
        name=island.name,
        icon=island.icon,
        description=island.description,
        layout_mode=island.layout_mode if island.layout_mode in VALID_LAYOUT_MODES else "tabs",
        panels=_normalize_panels(island.panels),
        is_shared=bool(island.is_shared),
        sort_order=island.sort_order or 0,
        created_at=island.created_at,
        updated_at=island.updated_at,
    )


def _get_owned(db: Session, island_id: str, user: User) -> Island:
    """쓰기용 조회 — 소유자가 아니면 403."""
    island = db.query(Island).filter(Island.id == island_id).first()
    if not island:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Island not found")
    if island.owner_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="아일랜드는 소유자만 수정할 수 있습니다. 공유된 아일랜드는 복제해서 사용하세요.",
        )
    return island


@router.get("", response_model=IslandListResponse)
def list_islands(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """내 아일랜드 + 남이 공유한 아일랜드."""
    mine = (
        db.query(Island)
        .filter(Island.owner_id == user.id)
        .order_by(Island.sort_order.asc(), Island.created_at.asc())
        .all()
    )
    shared = (
        db.query(Island)
        .filter(Island.is_shared.is_(True), Island.owner_id != user.id)
        .order_by(Island.updated_at.desc())
        .all()
    )
    return IslandListResponse(
        data=[_to_response(i) for i in mine],
        shared=[_to_response(i) for i in shared],
        total=len(mine),
    )


@router.get("/{island_id}", response_model=IslandResponse)
def get_island(island_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    island = db.query(Island).filter(Island.id == island_id).first()
    # 내 것도 아니고 공유된 것도 아니면 존재 자체를 노출하지 않는다.
    if not island or (island.owner_id != user.id and not island.is_shared):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Island not found")
    return _to_response(island)


@router.post("", response_model=IslandResponse, status_code=status.HTTP_201_CREATED)
def create_island(
    payload: IslandCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    max_order = (
        db.query(Island.sort_order).filter(Island.owner_id == user.id)
        .order_by(Island.sort_order.desc()).limit(1).scalar()
    )
    island = Island(
        id=str(uuid4()),
        owner_id=user.id,
        owner_name=_owner_name(user),
        name=payload.name,
        icon=payload.icon,
        description=payload.description,
        layout_mode=payload.layout_mode,
        panels=_normalize_panels(payload.panels),
        is_shared=payload.is_shared,
        sort_order=(max_order or 0) + 1,
    )
    db.add(island)
    db.commit()
    db.refresh(island)
    return _to_response(island)


@router.put("/{island_id}", response_model=IslandResponse)
def update_island(
    island_id: str,
    payload: IslandUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    island = _get_owned(db, island_id, user)
    for key, value in payload.model_dump(exclude_unset=True).items():
        if key == "panels":
            value = _normalize_panels(value)
        setattr(island, key, value)
    island.owner_name = _owner_name(user)
    db.commit()
    db.refresh(island)
    return _to_response(island)


@router.delete("/{island_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_island(
    island_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    island = _get_owned(db, island_id, user)
    db.delete(island)
    db.commit()
    return None


@router.post("/{island_id}/clone", response_model=IslandResponse, status_code=status.HTTP_201_CREATED)
def clone_island(
    island_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """내 것 또는 공유된 아일랜드를 내 계정으로 복제한다(공유 플래그는 끈 채로)."""
    source = db.query(Island).filter(Island.id == island_id).first()
    if not source or (source.owner_id != user.id and not source.is_shared):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Island not found")

    max_order = (
        db.query(Island.sort_order).filter(Island.owner_id == user.id)
        .order_by(Island.sort_order.desc()).limit(1).scalar()
    )
    clone = Island(
        id=str(uuid4()),
        owner_id=user.id,
        owner_name=_owner_name(user),
        name=f"{source.name} (복사)"[:100],
        icon=source.icon,
        description=source.description,
        layout_mode=source.layout_mode,
        panels=_normalize_panels(source.panels),
        is_shared=False,
        sort_order=(max_order or 0) + 1,
    )
    db.add(clone)
    db.commit()
    db.refresh(clone)
    return _to_response(clone)


@router.post("/reorder", response_model=IslandListResponse)
def reorder_islands(
    payload: IslandReorder,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """내 아일랜드 순서 재지정. 목록에 없는 id 는 무시하고, 빠진 것은 뒤로 밀린다."""
    mine = db.query(Island).filter(Island.owner_id == user.id).all()
    by_id = {i.id: i for i in mine}
    order = 0
    for island_id in payload.order:
        island = by_id.pop(island_id, None)
        if island is None:
            continue
        island.sort_order = order
        order += 1
    # 재정렬 목록에 없던 것들은 기존 순서를 유지한 채 뒤에 붙인다.
    for island in sorted(by_id.values(), key=lambda i: (i.sort_order or 0, i.created_at)):
        island.sort_order = order
        order += 1
    db.commit()
    return list_islands(db=db, user=user)
