"""ClusterItem API — 현황 관리 대시보드의 '아이템' 카드.

- GET    /clusters/{cluster_id}/items   목록 (기본 아이템 자동 보장)
- POST   /clusters/{cluster_id}/items   사용자 정의 아이템 생성
- PUT    /cluster-items/{item_id}        편집
- DELETE /cluster-items/{item_id}        삭제 (기본 아이템은 불가)
- POST   /cluster-items/{item_id}/run    수동 실행(즉시 수집)
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.models.cluster_item import ClusterItem
from app.services import cluster_item_service as cis

router = APIRouter(tags=["cluster-items"])


# ── Schemas ────────────────────────────────────────────────
class ClusterItemBase(BaseModel):
    item_type: str = Field("node_count", max_length=50)
    title: str = Field(..., min_length=1, max_length=100)
    icon: str = "🖥️"
    description: Optional[str] = None
    tier: str = "basic"
    source_mode: str = "auto"          # manual | auto | ai
    auto_enabled: bool = True
    schedule_hour: int = Field(1, ge=0, le=23)
    schedule_minute: int = Field(0, ge=0, le=59)
    card_size: str = "md"              # sm | md | lg
    unit: str = ""
    sort_order: int = 0
    enabled: bool = True


class ClusterItemCreate(ClusterItemBase):
    pass


class ClusterItemUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=100)
    icon: Optional[str] = None
    description: Optional[str] = None
    tier: Optional[str] = None
    source_mode: Optional[str] = None
    auto_enabled: Optional[bool] = None
    schedule_hour: Optional[int] = Field(None, ge=0, le=23)
    schedule_minute: Optional[int] = Field(None, ge=0, le=59)
    card_size: Optional[str] = None
    unit: Optional[str] = None
    sort_order: Optional[int] = None
    enabled: Optional[bool] = None


class ClusterItemResponse(BaseModel):
    id: UUID
    cluster_id: UUID
    item_type: str
    title: str
    icon: Optional[str] = None
    description: Optional[str] = None
    tier: str
    is_builtin: bool
    source_mode: str
    auto_enabled: bool
    schedule_hour: int
    schedule_minute: int
    card_size: str
    unit: Optional[str] = None
    sort_order: int
    enabled: bool
    current_value: Optional[float] = None
    current_text: Optional[str] = None
    result_detail: Optional[dict] = None
    result_status: Optional[str] = None
    last_status: Optional[str] = None
    last_error: Optional[str] = None
    last_checked_at: Optional[datetime] = None
    last_source: Optional[str] = None
    previous_value: Optional[float] = None
    previous_text: Optional[str] = None
    last_changed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ClusterItemListResponse(BaseModel):
    data: list[ClusterItemResponse]


# ── Helpers ────────────────────────────────────────────────
def _get_cluster_or_404(db: Session, cluster_id: UUID) -> Cluster:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return cluster


def _get_item_or_404(db: Session, item_id: UUID) -> ClusterItem:
    item = db.query(ClusterItem).filter(ClusterItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Cluster item not found")
    return item


# ── Routes ─────────────────────────────────────────────────
@router.get("/cluster-item-types")
def list_cluster_item_types():
    """'아이템 추가' 선택지 — 지원하는 아이템 타입 메타데이터."""
    return {"data": cis.list_item_types()}


@router.get("/clusters/{cluster_id}/items", response_model=ClusterItemListResponse)
def list_cluster_items(cluster_id: UUID, db: Session = Depends(get_db)):
    cluster = _get_cluster_or_404(db, cluster_id)
    # 기본 아이템 자동 보장 (구버전 / 신규 클러스터 호환)
    try:
        cis.ensure_builtin_items(db, cluster)
    except Exception:  # noqa: BLE001
        db.rollback()
    items = (
        db.query(ClusterItem)
        .filter(ClusterItem.cluster_id == cluster_id)
        .order_by(ClusterItem.sort_order, ClusterItem.created_at)
        .all()
    )
    return ClusterItemListResponse(data=items)


@router.post("/clusters/{cluster_id}/items", response_model=ClusterItemResponse, status_code=201)
def create_cluster_item(cluster_id: UUID, body: ClusterItemCreate, db: Session = Depends(get_db)):
    _get_cluster_or_404(db, cluster_id)
    if body.item_type not in cis.ITEM_TYPES:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 아이템 타입: {body.item_type}")
    item = ClusterItem(cluster_id=cluster_id, is_builtin=False, **body.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/cluster-items/{item_id}", response_model=ClusterItemResponse)
def update_cluster_item(item_id: UUID, body: ClusterItemUpdate, db: Session = Depends(get_db)):
    item = _get_item_or_404(db, item_id)
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/cluster-items/{item_id}")
def delete_cluster_item(item_id: UUID, db: Session = Depends(get_db)):
    item = _get_item_or_404(db, item_id)
    if item.is_builtin:
        raise HTTPException(status_code=400, detail="기본 아이템은 삭제할 수 없습니다 (편집만 가능)")
    db.delete(item)
    db.commit()
    return {"message": "deleted"}


@router.post("/cluster-items/{item_id}/run", response_model=ClusterItemResponse)
def run_cluster_item(item_id: UUID, db: Session = Depends(get_db)):
    """수동(수작업) 즉시 수집."""
    item = _get_item_or_404(db, item_id)
    try:
        item = cis.run_item(db, item, source="manual")
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"아이템 실행 실패: {str(e)[:200]}")
    return item
