"""점검 매트릭스 — 항목 CRUD/재정렬, 그리드 조회, cron 설정(항목/클러스터), 셀 이력,
수동 입력, 실행 계획(런북) 조회, 수동 실행(셀/클러스터/항목), 실행 로그, 이력 보관 설정."""
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
# 행 색은 테마 대응을 위해 차트 토큰 프리셋 키만 허용 (frontend --chart-1..8).
_ALLOWED_ROW_COLORS = {f"chart-{i}" for i in range(1, 9)}


class ItemIn(BaseModel):
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    source_type: CheckMatrixSourceType
    source_ref: Optional[str] = None
    category: Optional[str] = None
    color: Optional[str] = None
    enabled: bool = True


class ItemOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    source_type: CheckMatrixSourceType
    source_ref: Optional[str] = None
    category: Optional[str] = None
    color: Optional[str] = None
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
    if body.color and body.color not in _ALLOWED_ROW_COLORS:
        raise HTTPException(
            status_code=422,
            detail=f"color 는 chart-1..chart-8 프리셋 키만 허용됩니다: {body.color}",
        )
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
        # 시스템 항목(core_bundle)도 표시 속성(이름/설명/단위/표시 여부)은 고칠 수 있어야 한다.
        # 막는 것은 실행 소스 변경뿐 — Cluster.status 산정 경로가 바뀌면 안 되기 때문.
        if body.source_type != row.source_type or (body.source_ref or None) != (row.source_ref or None):
            raise HTTPException(
                status_code=400,
                detail="시스템 항목은 실행 소스(source_type/source_ref)를 바꿀 수 없습니다 — 이름/설명/단위/표시 여부만 수정 가능합니다.",
            )
        if body.color and body.color not in _ALLOWED_ROW_COLORS:
            raise HTTPException(status_code=422, detail=f"color 는 chart-1..chart-8 만 허용: {body.color}")
        row.name = body.name
        row.description = body.description
        row.unit = body.unit
        row.category = body.category
        row.color = body.color
        row.enabled = body.enabled
        db.commit()
        db.refresh(row)
        return row
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
    user: User = Depends(require_operator),
):
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type != CheckMatrixSourceType.manual:
        raise HTTPException(status_code=400, detail="수동 입력은 manual 타입 항목에서만 가능합니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    svc.record_manual_entry(
        db, item_id, cluster_id, body.status, body.value, body.message,
        triggered_by=_actor(user),
    )
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


# ── 런북 (실행 계획 — 실제로 클러스터에 나가는 명령) ─────────────────────────────
@router.get("/cell/{item_id}/{cluster_id}/runbook")
def get_cell_runbook(item_id: UUID, cluster_id: UUID, db: Session = Depends(get_db)):
    """이 셀이 실제 운영 클러스터에서 무슨 명령을 어떤 순서로 도는지. 실행하지 않는다."""
    from app.services.check_matrix_runbook import build_runbook

    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return build_runbook(db, item, cluster)


class SourceConfigEntry(BaseModel):
    group: str  # deep_check: "thresholds"|"params" / addon: "config"
    name: str
    value: str  # 문자열로 받아 서버가 spec 필드 타입으로 강제 (빈 문자열 = 기본값 복귀)


class SourceConfigIn(BaseModel):
    entries: list[SourceConfigEntry] = Field(..., min_length=1)


@router.put("/cell/{item_id}/{cluster_id}/source-config")
def put_source_config(
    item_id: UUID,
    cluster_id: UUID,
    body: SourceConfigIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """셀 실행 소스의 설정(deep_check thresholds/params, addon config)을 매트릭스에서 직접 수정.

    글로벌 정의를 수정하면 전 클러스터에 적용된다 — runbook 의 definition_scope 로 UI 가 경고한다.
    """
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        return svc.update_source_config(
            db, item, cluster, [e.model_dump() for e in body.entries],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── 수동 실행 (셀 / 클러스터 열 / 항목 행) ────────────────────────────────────────
def _actor(user: User) -> str:
    # User 모델의 표시명 컬럼은 display_name 이다 (full_name 아님 — models/user.py).
    return user.display_name or user.username


@router.post("/cell/{item_id}/{cluster_id}/run")
def run_cell(
    item_id: UUID,
    cluster_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """셀 1건 즉시 실행 — 동기 실행이라 응답에 결과가 그대로 담긴다."""
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    if item.source_type == CheckMatrixSourceType.manual:
        raise HTTPException(
            status_code=400,
            detail="수동 입력 항목은 실행할 수 없습니다 — 셀 상세의 '값 입력'을 사용하세요.",
        )
    return svc.run_cell_now(db, item, cluster, triggered_by=_actor(user))


@router.post("/clusters/{cluster_id}/run")
def run_cluster(
    cluster_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """클러스터(열) 단위 일괄 실행 — 큐잉만 하고 batch_id 를 돌려준다."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return svc.run_cluster_now(db, cluster, triggered_by=_actor(user))


@router.post("/items/{item_id}/run")
def run_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """공통 점검 항목(행) 단위 일괄 실행 — 등록된 모든 클러스터 대상. 큐잉 후 batch_id 반환."""
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type == CheckMatrixSourceType.manual:
        raise HTTPException(
            status_code=400,
            detail="수동 입력 항목은 실행할 수 없습니다 — 클러스터별로 값을 직접 입력하세요.",
        )
    return svc.run_item_now(db, item, triggered_by=_actor(user))


# ── 실행 로그 ─────────────────────────────────────────────────────────────────
@router.get("/runs")
def list_runs(
    item_id: Optional[UUID] = None,
    cluster_id: Optional[UUID] = None,
    batch_id: Optional[UUID] = None,
    trigger: Optional[str] = None,
    run_state: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """수행 로그 목록 — cron 자동 실행과 수동 실행(셀/클러스터/항목/수동입력)을 모두 포함.

    ``run_state`` 는 콤마 구분 다중값(예: ``queued,running``) — 매트릭스 화면이 "지금 실행
    중인 것"만 가볍게 폴링해 cron 배지/타임라인을 실시간에 가깝게 갱신하는 데 쓴다.
    """
    return svc.list_runs(
        db, item_id=item_id, cluster_id=cluster_id, batch_id=batch_id,
        trigger=trigger, run_state=run_state, limit=limit, offset=offset,
    )


@router.get("/runs/{run_id}")
def get_run(run_id: UUID, db: Session = Depends(get_db)):
    """수행 1건 상세 — 실행 단계, 실제 나간 명령과 출력, 해석된 런북까지."""
    out = svc.get_run(db, run_id)
    if out is None:
        raise HTTPException(status_code=404, detail="실행 로그를 찾을 수 없습니다.")
    return out


# ── Settings (이력 보관 주기) ──────────────────────────────────────────────────
@router.get("/settings")
def get_settings_route(db: Session = Depends(get_db)):
    return svc.get_settings(db)


@router.put("/settings")
def put_settings_route(body: SettingsIn, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    return svc.set_settings(db, body.retention_days)
