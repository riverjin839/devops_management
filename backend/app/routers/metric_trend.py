"""리소스 수 추세 체크리스트 라우터 (일일점검 리뷰).

- 조회: 인증된 모든 역할.
- 스냅샷 수집 / 체크 토글: require_operator (+감사).
- 기록값 보정 / 추적 항목 CRUD: require_admin (+감사).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models import Cluster
from app.models.resource_count import (
    MetricCheckState, MetricChecklistItem, ResourceCountSnapshot, SnapshotSource,
)
from app.models.user import User
from app.services import audit_logger, resource_count_service as rcs

router = APIRouter(prefix="/metric-trend", tags=["metric-trend"])


def _require_cluster(cluster_id: UUID, db: Session) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return c


def _parse_date(s: Optional[str]) -> date:
    if not s:
        return date.today()
    try:
        return date.fromisoformat(s)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=422, detail="date 는 YYYY-MM-DD 형식이어야 합니다.")


# ── 동작 주기 설정 (/{cluster_id} 보다 먼저 등록 — 경로 충돌 방지) ─────────────────
def _next_run(cron: str) -> Optional[str]:
    try:
        from croniter import croniter
        if not croniter.is_valid(cron):
            return None
        return croniter(cron, datetime.now()).get_next(datetime).isoformat()
    except Exception:  # noqa: BLE001
        return None


@router.get("/schedule")
def get_schedule(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    sch = rcs.get_schedule(db)
    return {**sch, "next_run": _next_run(sch["cron"]) if sch.get("enabled") else None}


class ScheduleBody(BaseModel):
    enabled: bool = True
    cron: str = rcs.DEFAULT_CRON


@router.put("/schedule")
def put_schedule(payload: ScheduleBody, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_admin)):
    cron = (payload.cron or "").strip()
    try:
        from croniter import croniter
        valid = croniter.is_valid(cron)
    except Exception:  # noqa: BLE001
        valid = bool(cron)
    if not valid:
        raise HTTPException(status_code=422, detail=f"유효하지 않은 cron 표현식: {cron}")
    val = rcs.set_schedule(db, payload.enabled, cron)
    audit_logger.record(db, action="metric.schedule.update", actor=actor, status="success",
                        target_type="metric_schedule", target_id="global",
                        details={"enabled": payload.enabled, "cron": cron}, request=request)
    return {**val, "next_run": _next_run(cron) if payload.enabled else None}


# ── 조회 ──────────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}")
def get_trend(cluster_id: UUID, date: Optional[str] = None, db: Session = Depends(get_db)):
    _require_cluster(cluster_id, db)
    return rcs.build_trend(db, cluster_id, _parse_date(date))


# ── 스냅샷 수집 (operator) ──────────────────────────────────────────────────────
@router.post("/{cluster_id}/snapshot")
def run_snapshot(
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster = _require_cluster(cluster_id, db)
    try:
        snap = rcs.collect_for_cluster(db, cluster, source=SnapshotSource.manual.value, user_id=actor.id)
    except Exception as e:  # noqa: BLE001
        audit_logger.record(db, action="metric.snapshot.run", actor=actor, status="failure",
                            target_type="cluster", target_id=str(cluster_id),
                            details={"error": str(e)[:200]}, request=request)
        raise HTTPException(status_code=502, detail=f"스냅샷 수집 실패: {str(e)[:200]}")
    audit_logger.record(db, action="metric.snapshot.run", actor=actor, status="success",
                        target_type="cluster", target_id=str(cluster_id),
                        details={"cluster": cluster.name, "counts": snap.counts}, request=request)
    return {"ok": True, "snapshot_id": str(snap.id), "counts": snap.counts, "collected_at": snap.collected_at.isoformat()}


# ── 체크 토글 (operator) ────────────────────────────────────────────────────────
class CheckToggle(BaseModel):
    item_key: str
    is_checked: bool
    date: Optional[str] = None
    note: Optional[str] = None


@router.put("/{cluster_id}/check")
def toggle_check(
    cluster_id: UUID,
    payload: CheckToggle,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    _require_cluster(cluster_id, db)
    d = _parse_date(payload.date)
    st = (
        db.query(MetricCheckState)
        .filter(MetricCheckState.cluster_id == cluster_id, MetricCheckState.check_date == d,
                MetricCheckState.item_key == payload.item_key)
        .first()
    )
    if st is None:
        st = MetricCheckState(cluster_id=cluster_id, check_date=d, item_key=payload.item_key)
        db.add(st)
    st.is_checked = payload.is_checked
    st.note = payload.note
    st.checked_by_user_id = actor.id
    st.checked_by_username = actor.username
    st.checked_at = datetime.utcnow() if payload.is_checked else None
    db.commit()
    audit_logger.record(db, action="metric.check.toggle", actor=actor, status="success",
                        target_type="metric_check", target_id=f"{cluster_id}/{d}/{payload.item_key}",
                        details={"is_checked": payload.is_checked}, request=request)
    return {"ok": True, "item_key": payload.item_key, "date": d.isoformat(), "is_checked": payload.is_checked}


# ── 기록값 보정 (admin) ─────────────────────────────────────────────────────────
class SnapshotEdit(BaseModel):
    counts: dict[str, int]


@router.put("/snapshots/{snapshot_id}")
def edit_snapshot(
    snapshot_id: UUID,
    payload: SnapshotEdit,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    snap = db.query(ResourceCountSnapshot).filter(ResourceCountSnapshot.id == snapshot_id).first()
    if snap is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    old = dict(snap.counts or {})
    merged = {**old, **{k: int(v) for k, v in payload.counts.items()}}
    snap.counts = merged
    db.commit()
    audit_logger.record(db, action="metric.snapshot.edit", actor=actor, status="success",
                        target_type="resource_count_snapshot", target_id=str(snapshot_id),
                        details={"before": old, "after": merged}, request=request)
    return {"ok": True, "snapshot_id": str(snapshot_id), "counts": merged}


# ── 추적 항목 CRUD ──────────────────────────────────────────────────────────────
class ItemBody(BaseModel):
    cluster_id: Optional[UUID] = None
    item_key: str
    label: str
    resource_kind: str
    enabled: bool = True
    sort_order: int = 0
    params: dict[str, Any] = {}


def _item_out(it: MetricChecklistItem) -> dict:
    return {
        "id": str(it.id),
        "cluster_id": str(it.cluster_id) if it.cluster_id else None,
        "item_key": it.item_key,
        "label": it.label,
        "resource_kind": it.resource_kind,
        "enabled": it.enabled,
        "sort_order": it.sort_order,
        "params": it.params or {},
    }


@router.get("/items/all")
def list_items(cluster_id: Optional[UUID] = None, db: Session = Depends(get_db),
               _: User = Depends(get_current_user)):
    q = db.query(MetricChecklistItem)
    rows = q.order_by(MetricChecklistItem.sort_order, MetricChecklistItem.item_key).all()
    if cluster_id is not None:
        rows = [r for r in rows if r.cluster_id is None or r.cluster_id == cluster_id]
    return {"items": [_item_out(r) for r in rows]}


@router.post("/items")
def create_item(payload: ItemBody, request: Request, db: Session = Depends(get_db),
                actor: User = Depends(require_admin)):
    if payload.resource_kind not in rcs.COUNT_METHODS:
        raise HTTPException(status_code=422, detail=f"집계 미지원 종류: {payload.resource_kind}")
    it = MetricChecklistItem(
        cluster_id=payload.cluster_id, item_key=payload.item_key, label=payload.label,
        resource_kind=payload.resource_kind, enabled=payload.enabled,
        sort_order=payload.sort_order, params=payload.params,
    )
    db.add(it)
    db.commit()
    db.refresh(it)
    audit_logger.record(db, action="metric.item.create", actor=actor, status="success",
                        target_type="metric_item", target_id=str(it.id),
                        details=_item_out(it), request=request)
    return _item_out(it)


@router.put("/items/{item_id}")
def update_item(item_id: UUID, payload: ItemBody, request: Request, db: Session = Depends(get_db),
                actor: User = Depends(require_admin)):
    it = db.query(MetricChecklistItem).filter(MetricChecklistItem.id == item_id).first()
    if it is None:
        raise HTTPException(status_code=404, detail="Item not found")
    if payload.resource_kind not in rcs.COUNT_METHODS:
        raise HTTPException(status_code=422, detail=f"집계 미지원 종류: {payload.resource_kind}")
    it.item_key = payload.item_key
    it.label = payload.label
    it.resource_kind = payload.resource_kind
    it.enabled = payload.enabled
    it.sort_order = payload.sort_order
    it.params = payload.params
    db.commit()
    audit_logger.record(db, action="metric.item.update", actor=actor, status="success",
                        target_type="metric_item", target_id=str(item_id),
                        details=_item_out(it), request=request)
    return _item_out(it)


@router.delete("/items/{item_id}")
def delete_item(item_id: UUID, request: Request, db: Session = Depends(get_db),
                actor: User = Depends(require_admin)):
    it = db.query(MetricChecklistItem).filter(MetricChecklistItem.id == item_id).first()
    if it is None:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(it)
    db.commit()
    audit_logger.record(db, action="metric.item.delete", actor=actor, status="success",
                        target_type="metric_item", target_id=str(item_id), request=request)
    return {"ok": True}
