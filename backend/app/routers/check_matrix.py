"""점검 매트릭스 — 항목 CRUD/재정렬, 그리드 조회, cron 설정(항목/클러스터), 셀 이력,
수동 입력, 이력 보관 설정."""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models import (
    CheckMatrixItem,
    CheckMatrixSchedule,
    CheckMatrixSourceType,
    Cluster,
    StatusEnum,
    User,
)
from app.services import check_matrix_service as svc

router = APIRouter(prefix="/check-matrix", tags=["Check Matrix"])


# ── Schemas ──────────────────────────────────────────────────────────────────
class ItemIn(BaseModel):
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    source_type: CheckMatrixSourceType
    source_ref: Optional[str] = None
    enabled: bool = True


class ItemOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    source_type: CheckMatrixSourceType
    source_ref: Optional[str] = None
    is_system: bool
    enabled: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ReorderRequest(BaseModel):
    item_ids: list[UUID] = Field(..., min_length=1)


class ScheduleIn(BaseModel):
    cron_expr: Optional[str] = None
    enabled: bool = True


class ScheduleOut(BaseModel):
    item_id: UUID
    cluster_id: UUID
    cron_expr: Optional[str] = None
    enabled: bool
    last_run_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ClusterCronIn(BaseModel):
    check_cron_expr: Optional[str] = None


class ManualEntryIn(BaseModel):
    status: StatusEnum
    value: Optional[float] = None
    message: Optional[str] = None


class SettingsIn(BaseModel):
    retention_days: int = Field(..., ge=1, le=3650)


def _validate_item_body(body: ItemIn) -> None:
    if body.source_type == CheckMatrixSourceType.core_bundle:
        raise HTTPException(status_code=400, detail="core_bundle 항목은 시스템에서만 생성/관리됩니다.")
    if body.source_type == CheckMatrixSourceType.deep_check:
        from app.services.deep_checkers import REGISTRY
        if not body.source_ref or body.source_ref not in REGISTRY:
            raise HTTPException(status_code=400, detail=f"알 수 없는 check_type: {body.source_ref}")
    if body.source_type == CheckMatrixSourceType.addon:
        from app.services.checkers import CHECKER_REGISTRY
        if not body.source_ref or body.source_ref not in CHECKER_REGISTRY:
            raise HTTPException(status_code=400, detail=f"알 수 없는 addon type: {body.source_ref}")


# ── Items CRUD / reorder ─────────────────────────────────────────────────────
@router.get("/items", response_model=list[ItemOut])
def list_items(db: Session = Depends(get_db)):
    return (
        db.query(CheckMatrixItem)
        .order_by(CheckMatrixItem.sort_order.asc(), CheckMatrixItem.created_at.asc())
        .all()
    )


@router.post("/items", response_model=ItemOut)
def create_item(body: ItemIn, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    _validate_item_body(body)
    max_sort = (
        db.query(CheckMatrixItem.sort_order)
        .order_by(CheckMatrixItem.sort_order.desc())
        .limit(1)
        .scalar()
    ) or 0
    row = CheckMatrixItem(**body.model_dump(), is_system=False, sort_order=max_sort + 10)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/items/{item_id}", response_model=ItemOut)
def update_item(item_id: UUID, body: ItemIn, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    row = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if row.is_system:
        raise HTTPException(status_code=400, detail="시스템 항목은 이름/설명만 수정할 수 없습니다 — 소스 변경 불가.")
    _validate_item_body(body)
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/items/{item_id}")
def delete_item(item_id: UUID, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    row = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if row.is_system:
        raise HTTPException(
            status_code=400,
            detail="시스템 항목은 삭제할 수 없습니다 — 클러스터 상태 계산에 사용됩니다. 대신 비활성화로 그리드에서 숨길 수 있습니다.",
        )
    db.delete(row)
    db.commit()
    return {"status": "ok"}


@router.post("/items/reorder")
def reorder_items(body: ReorderRequest, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    """순서 일괄 갱신 — 받은 순서대로 sort_order 를 10 간격으로 재할당."""
    seen: set[UUID] = set()
    for i, iid in enumerate(body.item_ids):
        if iid in seen:
            raise HTTPException(status_code=422, detail="item_ids 에 중복 id 가 포함되어 있습니다.")
        seen.add(iid)
        row = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == iid).first()
        if row is None:
            raise HTTPException(status_code=404, detail=f"CheckMatrixItem {iid} not found")
        row.sort_order = 1000 + i * 10
    db.commit()
    return {"updated": len(body.item_ids)}


# ── Grid / history / manual entry ────────────────────────────────────────────
@router.get("/grid")
def get_grid(db: Session = Depends(get_db)):
    return svc.build_grid(db)


@router.get("/cell/{item_id}/{cluster_id}/history")
def get_cell_history(item_id: UUID, cluster_id: UUID, days: int = 30, db: Session = Depends(get_db)):
    return svc.get_cell_history(db, item_id, cluster_id, days=days)


@router.post("/cell/{item_id}/{cluster_id}/manual-entry")
def post_manual_entry(
    item_id: UUID,
    cluster_id: UUID,
    body: ManualEntryIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type != CheckMatrixSourceType.manual:
        raise HTTPException(status_code=400, detail="수동 입력은 manual 타입 항목에서만 가능합니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    svc.record_manual_entry(db, item_id, cluster_id, body.status, body.value, body.message)
    return {"status": "ok"}


# ── Schedule / cron ──────────────────────────────────────────────────────────
@router.put("/schedule/{item_id}/{cluster_id}", response_model=ScheduleOut)
def put_schedule(
    item_id: UUID,
    cluster_id: UUID,
    body: ScheduleIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type == CheckMatrixSourceType.core_bundle:
        raise HTTPException(
            status_code=400,
            detail="핵심 항목의 cron 은 클러스터 열에서 설정합니다 (PUT /check-matrix/clusters/{cluster_id}/cron).",
        )
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        svc.validate_cron_min_interval(body.cron_expr)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    row = (
        db.query(CheckMatrixSchedule)
        .filter(CheckMatrixSchedule.item_id == item_id, CheckMatrixSchedule.cluster_id == cluster_id)
        .first()
    )
    if row is None:
        row = CheckMatrixSchedule(item_id=item_id, cluster_id=cluster_id)
        db.add(row)
    row.cron_expr = body.cron_expr
    row.enabled = body.enabled
    db.commit()
    db.refresh(row)
    return row


@router.put("/clusters/{cluster_id}/cron")
def put_cluster_cron(
    cluster_id: UUID,
    body: ClusterCronIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        svc.validate_cron_min_interval(body.check_cron_expr)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    cluster.check_cron_expr = body.check_cron_expr
    db.commit()
    return {"cluster_id": str(cluster.id), "check_cron_expr": cluster.check_cron_expr}


# ── Settings (이력 보관 주기) ──────────────────────────────────────────────────
@router.get("/settings")
def get_settings_route(db: Session = Depends(get_db)):
    return svc.get_settings(db)


@router.put("/settings")
def put_settings_route(body: SettingsIn, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    return svc.set_settings(db, body.retention_days)
