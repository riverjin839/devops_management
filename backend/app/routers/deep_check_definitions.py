"""Deep check 정의 CRUD + check_type 스키마 조회 + 실행/이력.

* CRUD(생성/수정/삭제/복제)는 admin 전용, 실행(test/run/preview)은 operator 이상.
* ``GET /definitions?with_status=true`` — 정의별 최근 실행 상태를 함께 반환.
* ``GET /definitions/{id}/results`` — 정의별 개별 실행 이력(로그) 조회.
* ``POST /definitions/{id}/run`` — 즉시 1회 실행 + DeepCheckResult 로 영속화.
* ``POST /definitions/preview`` — 저장 전 폼 값 그대로 ad-hoc 1회 실행(영속화 없음).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.auth.deps import require_admin, require_operator
from app.database import get_db
from app.models import Cluster, DeepCheckDefinition, DeepCheckResult
from app.models.user import User
from app.services.check_matrix_service import validate_cron_min_interval
from app.services.deep_check_service import DeepCheckService
from app.services.deep_checkers import REGISTRY, list_check_types

router = APIRouter(prefix="/deep-check", tags=["Deep Check Definitions"])


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
    last_run_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # with_status=true 일 때만 채워지는 최근 실행 요약 (정의별 개별 로그 진입점)
    last_status: Optional[str] = None
    last_checked_at: Optional[datetime] = None
    last_message: Optional[str] = None
    last_duration_ms: Optional[int] = None

    class Config:
        from_attributes = True


class PreviewIn(BaseModel):
    check_type: str
    cluster_id: Optional[UUID] = None
    thresholds: Optional[dict[str, Any]] = None
    params: Optional[dict[str, Any]] = None


def _validate_body(db: Session, body: DefinitionIn) -> None:
    if body.check_type not in REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown check_type: {body.check_type}")
    if body.cluster_id is not None:
        cluster = db.query(Cluster).filter(Cluster.id == body.cluster_id).first()
        if cluster is None:
            raise HTTPException(status_code=404, detail="Cluster not found")
    if body.schedule_cron:
        try:
            validate_cron_min_interval(body.schedule_cron)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))


def _get_or_404(db: Session, def_id: UUID) -> DeepCheckDefinition:
    row = db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == def_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="DeepCheckDefinition not found")
    return row


@router.get("/check-types")
def get_check_types():
    return list_check_types()


@router.get("/definitions", response_model=list[DefinitionOut])
def list_definitions(
    cluster_id: Optional[UUID] = None,
    include_global: bool = True,
    with_status: bool = False,
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
    rows = q.order_by(DeepCheckDefinition.sort_order.asc()).all()
    out = [DefinitionOut.model_validate(r) for r in rows]

    if with_status and rows:
        # 정의별 최신 결과 1건 — Postgres DISTINCT ON.
        latest = (
            db.query(DeepCheckResult)
            .filter(DeepCheckResult.definition_id.in_([r.id for r in rows]))
            .distinct(DeepCheckResult.definition_id)
            .order_by(DeepCheckResult.definition_id, desc(DeepCheckResult.checked_at))
            .all()
        )
        by_def = {r.definition_id: r for r in latest}
        for item in out:
            last = by_def.get(item.id)
            if last is not None:
                item.last_status = last.status.value if last.status else None
                item.last_checked_at = last.checked_at
                item.last_message = last.message
                item.last_duration_ms = last.duration_ms
    return out


@router.post("/definitions", response_model=DefinitionOut)
def create_definition(
    body: DefinitionIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    _validate_body(db, body)
    row = DeepCheckDefinition(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/definitions/{def_id}", response_model=DefinitionOut)
def get_definition(def_id: UUID, db: Session = Depends(get_db)):
    return _get_or_404(db, def_id)


@router.put("/definitions/{def_id}", response_model=DefinitionOut)
def update_definition(
    def_id: UUID,
    body: DefinitionIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = _get_or_404(db, def_id)
    _validate_body(db, body)
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/definitions/{def_id}")
def delete_definition(
    def_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = _get_or_404(db, def_id)
    # 이력(DeepCheckResult)은 남기되 정의 참조만 끊는다 (FK SET NULL 동작 보완).
    db.query(DeepCheckResult).filter(DeepCheckResult.definition_id == def_id).update(
        {DeepCheckResult.definition_id: None}, synchronize_session=False,
    )
    db.delete(row)
    db.commit()
    return {"status": "ok"}


@router.post("/definitions/{def_id}/duplicate", response_model=DefinitionOut)
def duplicate_definition(
    def_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """정의 복제 — 같은 check_type 으로 변형 정의를 빠르게 만드는 용도."""
    src = _get_or_404(db, def_id)
    row = DeepCheckDefinition(
        cluster_id=src.cluster_id,
        check_type=src.check_type,
        name=f"{src.name} (복제)",
        description=src.description,
        enabled=False,
        schedule_cron=src.schedule_cron,
        thresholds=dict(src.thresholds) if src.thresholds else None,
        params=dict(src.params) if src.params else None,
        sort_order=src.sort_order + 1,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ───────────────────────────────────────────────────────────────
# 실행 / 이력 (정의별 개별 로그)
# ───────────────────────────────────────────────────────────────

@router.get("/definitions/{def_id}/results")
def list_definition_results(
    def_id: UUID,
    limit: int = 20,
    offset: int = 0,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """정의별 실행 이력 — 각 행의 details._steps 가 개별 실행 단계 로그."""
    _get_or_404(db, def_id)
    q = db.query(DeepCheckResult).filter(DeepCheckResult.definition_id == def_id)
    if status:
        q = q.filter(DeepCheckResult.status == status)
    total = q.count()
    rows = (
        q.order_by(desc(DeepCheckResult.checked_at))
        .offset(offset)
        .limit(min(limit, 100))
        .all()
    )
    return {
        "total": total,
        "results": [
            {
                "id": str(r.id),
                "cluster_id": str(r.cluster_id),
                "daily_check_log_id": str(r.daily_check_log_id) if r.daily_check_log_id else None,
                "check_type": r.check_type,
                "status": r.status.value if r.status else None,
                "message": r.message,
                "details": r.details,
                "duration_ms": r.duration_ms,
                "checked_at": r.checked_at.isoformat() if r.checked_at else None,
            }
            for r in rows
        ],
    }


@router.post("/definitions/{def_id}/test")
def test_definition(
    def_id: UUID,
    cluster_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """정의를 즉시 1회 실행 (저장하지 않음) — UI 미리보기용."""
    row = _get_or_404(db, def_id)

    # cluster_id 결정 우선순위: 인자 → 정의의 cluster_id
    target_id = cluster_id or row.cluster_id
    cluster = None
    if target_id is not None:
        cluster = db.query(Cluster).filter(Cluster.id == target_id).first()
        if cluster is None:
            raise HTTPException(status_code=404, detail="Cluster not found")

    svc = DeepCheckService(db)
    return svc.run_definition_once(row.id, cluster=cluster, in_cluster=False, persist=False)


@router.post("/definitions/{def_id}/run")
def run_definition(
    def_id: UUID,
    cluster_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """정의를 즉시 1회 실행하고 DeepCheckResult 로 저장 — 이력에 남는 수동 실행."""
    row = _get_or_404(db, def_id)
    target_id = cluster_id or row.cluster_id
    if target_id is None:
        raise HTTPException(
            status_code=400,
            detail="글로벌 정의는 cluster_id 를 지정해야 기록 실행이 가능합니다.",
        )
    cluster = db.query(Cluster).filter(Cluster.id == target_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    svc = DeepCheckService(db)
    return svc.run_definition_once(row.id, cluster=cluster, in_cluster=False, persist=True)


@router.post("/definitions/preview")
def preview_check(
    body: PreviewIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """저장하지 않은 폼 값으로 ad-hoc 1회 실행 — 새 정의 작성 중 미리보기."""
    if body.check_type not in REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown check_type: {body.check_type}")
    cluster = None
    if body.cluster_id is not None:
        cluster = db.query(Cluster).filter(Cluster.id == body.cluster_id).first()
        if cluster is None:
            raise HTTPException(status_code=404, detail="Cluster not found")

    svc = DeepCheckService(db)
    return svc.run_check_type_once(
        body.check_type,
        cluster=cluster,
        thresholds=body.thresholds,
        params=body.params,
        in_cluster=False,
        persist=False,
    )
