"""Deep check 정의 CRUD + 사용 가능한 check_type 스키마 조회 + "Test now" 미리보기."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models import Cluster, DeepCheckDefinition
from app.services.deep_check_service import DeepCheckService
from app.services.deep_checkers import REGISTRY, list_check_types

router = APIRouter(prefix="/deep-check", tags=["Deep Check Definitions"])

# 정의 변경/실행은 operator 이상만 — 임계값 변경은 전 클러스터에 영향을 주고,
# test/run 은 컨트롤플레인 exec·파드생성 같은 강력한 동작을 유발할 수 있다.
_operator = [Depends(require_operator)]


class DefinitionIn(BaseModel):
    cluster_id: Optional[UUID] = None
    check_type: str
    name: str
    description: Optional[str] = None
    enabled: bool = True
    schedule_cron: Optional[str] = None
    thresholds: Optional[dict[str, Any]] = None
    params: Optional[dict[str, Any]] = None
    sort_order: int = 0


class DefinitionOut(BaseModel):
    id: UUID
    cluster_id: Optional[UUID] = None
    check_type: str
    name: str
    description: Optional[str] = None
    enabled: bool
    schedule_cron: Optional[str] = None
    thresholds: Optional[dict[str, Any]] = None
    params: Optional[dict[str, Any]] = None
    sort_order: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


@router.get("/check-types")
def get_check_types():
    return list_check_types()


@router.get("/definitions", response_model=list[DefinitionOut])
def list_definitions(
    cluster_id: Optional[UUID] = None,
    include_global: bool = True,
    db: Session = Depends(get_db),
):
    q = db.query(DeepCheckDefinition)
    if cluster_id is not None:
        if include_global:
            q = q.filter(
                (DeepCheckDefinition.cluster_id == cluster_id)
                | (DeepCheckDefinition.cluster_id.is_(None))
            )
        else:
            q = q.filter(DeepCheckDefinition.cluster_id == cluster_id)
    return q.order_by(DeepCheckDefinition.sort_order.asc()).all()


@router.post("/definitions", response_model=DefinitionOut, dependencies=_operator)
def create_definition(body: DefinitionIn, db: Session = Depends(get_db)):
    if body.check_type not in REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown check_type: {body.check_type}")
    if body.cluster_id is not None:
        cluster = db.query(Cluster).filter(Cluster.id == body.cluster_id).first()
        if cluster is None:
            raise HTTPException(status_code=404, detail="Cluster not found")
    row = DeepCheckDefinition(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/definitions/{def_id}", response_model=DefinitionOut)
def get_definition(def_id: UUID, db: Session = Depends(get_db)):
    row = db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == def_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="DeepCheckDefinition not found")
    return row


@router.put("/definitions/{def_id}", response_model=DefinitionOut, dependencies=_operator)
def update_definition(def_id: UUID, body: DefinitionIn, db: Session = Depends(get_db)):
    row = db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == def_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="DeepCheckDefinition not found")
    if body.check_type not in REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown check_type: {body.check_type}")
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/definitions/{def_id}", dependencies=_operator)
def delete_definition(def_id: UUID, db: Session = Depends(get_db)):
    row = db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == def_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="DeepCheckDefinition not found")
    db.delete(row)
    db.commit()
    return {"status": "ok"}


@router.post("/definitions/{def_id}/test", dependencies=_operator)
def test_definition(
    def_id: UUID,
    cluster_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
):
    """정의를 즉시 1회 실행 (저장하지 않음) — UI 미리보기용."""
    row = db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == def_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="DeepCheckDefinition not found")

    # cluster_id 결정 우선순위: 인자 → 정의의 cluster_id
    target_id = cluster_id or row.cluster_id
    cluster = None
    if target_id is not None:
        cluster = db.query(Cluster).filter(Cluster.id == target_id).first()
        if cluster is None:
            raise HTTPException(status_code=404, detail="Cluster not found")

    svc = DeepCheckService(db)
    return svc.run_definition_once(row.id, cluster=cluster, in_cluster=False, persist=False)
