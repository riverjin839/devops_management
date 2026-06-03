"""운영 점검(Ops Checks) 통합 콘솔 API.

- 카탈로그: 클러스터별 점검 항목(소스 무관) 리스트
- 실행: 선택한 항목 묶음을 백그라운드(Celery)로 실행, 폴링으로 진행률 조회
- 항목별 결과/로그 + 실행 이력
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models import OpsCheckRun, OpsCheckRunItem, User
from app.services.ops_check_service import OpsCheckService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ops-checks", tags=["Ops Checks"])


# ── schemas ──────────────────────────────────────────────────────────────────
class CatalogItem(BaseModel):
    source: str
    item_ref_id: str
    name: Optional[str] = None
    check_type: Optional[str] = None
    category: str
    requires_credentials: bool = False
    enabled: bool = True
    last_status: Optional[str] = None
    last_run_at: Optional[str] = None


class RunRequestItem(BaseModel):
    source: str
    item_ref_id: str
    check_type: Optional[str] = None
    name: Optional[str] = None


class RunRequest(BaseModel):
    cluster_id: UUID
    items: list[RunRequestItem]


class RunItemOut(BaseModel):
    id: UUID
    source: str
    item_ref_id: str
    check_type: Optional[str] = None
    name: Optional[str] = None
    status: str
    result_status: Optional[str] = None
    message: Optional[str] = None
    details: Optional[dict[str, Any]] = None
    duration_ms: int = 0
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RunOut(BaseModel):
    id: UUID
    cluster_id: UUID
    status: str
    trigger: str
    triggered_by: Optional[str] = None
    total: int
    ok_count: int
    warn_count: int
    crit_count: int
    error_count: int
    created_at: datetime
    finished_at: Optional[datetime] = None

    class Config:
        from_attributes = True


def _item_out(it: OpsCheckRunItem) -> RunItemOut:
    return RunItemOut(
        id=it.id,
        source=it.source,
        item_ref_id=it.item_ref_id,
        check_type=it.check_type,
        name=it.name,
        status=it.status,
        result_status=it.result_status.value if it.result_status else None,
        message=it.message,
        details=it.details,
        duration_ms=it.duration_ms or 0,
        started_at=it.started_at,
        finished_at=it.finished_at,
    )


# ── endpoints ────────────────────────────────────────────────────────────────
@router.get("/catalog/{cluster_id}", response_model=list[CatalogItem])
def get_catalog(cluster_id: UUID, db: Session = Depends(get_db)):
    try:
        return OpsCheckService(db).build_catalog(cluster_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("ops-check catalog 실패: %s", e)
        raise HTTPException(status_code=500, detail=f"카탈로그 조회 실패: {str(e)[:300]}")


@router.post("/run", response_model=RunOut)
def start_run(
    body: RunRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not body.items:
        raise HTTPException(status_code=400, detail="실행할 점검 항목이 없습니다.")
    svc = OpsCheckService(db)
    try:
        run = svc.create_run(
            body.cluster_id,
            [i.model_dump() for i in body.items],
            triggered_by=getattr(user, "username", None),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("ops-check run 생성 실패: %s", e)
        raise HTTPException(status_code=500, detail=f"실행 생성 실패: {str(e)[:300]}")

    # 백그라운드(Celery) enqueue — broker/worker 부재 시 동기 폴백.
    try:
        from app.celery_app import run_ops_check_batch
        run_ops_check_batch.delay(str(run.id))
    except Exception as e:  # noqa: BLE001
        logger.warning("ops-check: Celery enqueue 실패 → 동기 실행 폴백 (%s)", e)
        try:
            svc.execute_run(run.id)
            db.refresh(run)
        except Exception as e2:  # noqa: BLE001
            logger.exception("ops-check 동기 실행 폴백도 실패: %s", e2)
            raise HTTPException(status_code=500, detail=f"실행 실패: {str(e2)[:300]}")
    return run


@router.get("/runs", response_model=list[RunOut])
def list_runs(
    cluster_id: Optional[UUID] = None,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    q = db.query(OpsCheckRun)
    if cluster_id is not None:
        q = q.filter(OpsCheckRun.cluster_id == cluster_id)
    return q.order_by(desc(OpsCheckRun.created_at)).limit(min(limit, 100)).all()


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(run_id: UUID, db: Session = Depends(get_db)):
    run = db.query(OpsCheckRun).filter(OpsCheckRun.id == run_id).first()
    if run is None:
        raise HTTPException(status_code=404, detail="실행 기록을 찾을 수 없습니다.")
    return run


@router.get("/runs/{run_id}/items", response_model=list[RunItemOut])
def get_run_items(run_id: UUID, db: Session = Depends(get_db)):
    items = (
        db.query(OpsCheckRunItem)
        .filter(OpsCheckRunItem.run_id == run_id)
        .order_by(OpsCheckRunItem.created_at.asc())
        .all()
    )
    return [_item_out(it) for it in items]


@router.get("/items/{source}/{item_ref_id}/history", response_model=list[RunItemOut])
def item_history(
    source: str,
    item_ref_id: str,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    items = (
        db.query(OpsCheckRunItem)
        .filter(OpsCheckRunItem.source == source, OpsCheckRunItem.item_ref_id == item_ref_id)
        .order_by(desc(OpsCheckRunItem.created_at))
        .limit(min(limit, 100))
        .all()
    )
    return [_item_out(it) for it in items]
