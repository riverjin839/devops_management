"""Pod-to-pod bottleneck analyzer router."""
from __future__ import annotations

import asyncio
import time
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster, BottleneckRun, User
from app.auth.deps import require_operator, get_current_user
from app.services import audit_logger
from app.services.bottleneck_probes import (
    BOTTLENECK_PROBE_REGISTRY, PROBE_CATALOG, make_context, worst_status,
)
from app.schemas.bottleneck import (
    BottleneckRunCreate,
    BottleneckRunResponse,
    BottleneckRunListResponse,
    ProbeCatalogEntry,
)


router = APIRouter(prefix="/pod-bottleneck", tags=["pod-bottleneck"])


def _not_found(run_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "BOTTLENECK_RUN_NOT_FOUND",
                "message": "Bottleneck run not found", "id": str(run_id)},
    )


def _cluster_not_found(cluster_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "CLUSTER_NOT_FOUND",
                "message": "Cluster not found", "id": str(cluster_id)},
    )


# ─── catalog ──────────────────────────────────────────────────────────────

@router.get("/probes", response_model=list[ProbeCatalogEntry])
def list_probes(_: User = Depends(get_current_user)):
    """등록된 4 probe 메타 — frontend UI 안내용."""
    return [ProbeCatalogEntry(probe_key=k, **v) for k, v in PROBE_CATALOG.items()]


# ─── run history ──────────────────────────────────────────────────────────

@router.get("/runs", response_model=BottleneckRunListResponse)
def list_runs(
    cluster_id: UUID | None = Query(default=None),
    namespace: str | None = Query(default=None, max_length=100),
    source_pod: str | None = Query(default=None, max_length=253),
    dest_pod: str | None = Query(default=None, max_length=253),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(BottleneckRun)
    if cluster_id is not None:
        q = q.filter(BottleneckRun.cluster_id == cluster_id)
    if namespace:
        q = q.filter(BottleneckRun.namespace == namespace)
    if source_pod:
        q = q.filter(BottleneckRun.source_pod == source_pod)
    if dest_pod:
        q = q.filter(BottleneckRun.dest_pod == dest_pod)

    total = q.count()
    items = (
        q.order_by(BottleneckRun.created_at.desc())
        .offset(offset).limit(limit).all()
    )
    return BottleneckRunListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


@router.get("/runs/{run_id}", response_model=BottleneckRunResponse)
def get_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = db.query(BottleneckRun).filter(BottleneckRun.id == run_id).first()
    if not row:
        raise _not_found(run_id)
    return row


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    row = db.query(BottleneckRun).filter(BottleneckRun.id == run_id).first()
    if not row:
        raise _not_found(run_id)
    snap = {
        "cluster_id": str(row.cluster_id), "namespace": row.namespace,
        "source_pod": row.source_pod, "dest_pod": row.dest_pod,
    }
    target_id = row.id
    db.delete(row); db.commit()
    audit_logger.record(
        db, action="bottleneck.delete", actor=actor,
        target_type="bottleneck_run", target_id=target_id,
        details=snap, request=request,
    )
    return None


# ─── run (the core action) ───────────────────────────────────────────────

@router.post("/run", response_model=BottleneckRunResponse, status_code=status.HTTP_201_CREATED)
async def run_bottleneck_analysis(
    payload: BottleneckRunCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """두 pod 사이 병목 진단 — 4 probe 병렬 실행 + BottleneckRun 저장."""
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise _cluster_not_found(payload.cluster_id)

    # 어떤 probe 들을 돌릴지 결정 (payload.probes 미지정 시 전체)
    selected_keys = payload.probes or list(BOTTLENECK_PROBE_REGISTRY.keys())
    invalid = [k for k in selected_keys if k not in BOTTLENECK_PROBE_REGISTRY]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "UNKNOWN_PROBE_KEY",
                    "message": f"미지원 probe: {invalid}",
                    "supported": sorted(BOTTLENECK_PROBE_REGISTRY.keys())},
        )

    ctx = make_context(
        cluster=cluster,
        namespace=payload.namespace,
        source_pod=payload.source_pod,
        dest_pod=payload.dest_pod,
        dest_service=payload.dest_service,
    )

    start = time.time()
    probes = [BOTTLENECK_PROBE_REGISTRY[k]() for k in selected_keys]
    results = await asyncio.gather(*[p.safe_run(ctx) for p in probes])
    duration_ms = int((time.time() - start) * 1000)

    probes_dict = {p.PROBE_KEY: r.to_dict() for p, r in zip(probes, results)}
    overall = worst_status([r.status for r in results])

    row = BottleneckRun(
        cluster_id=cluster.id,
        namespace=payload.namespace,
        source_pod=payload.source_pod,
        dest_pod=payload.dest_pod,
        dest_service=payload.dest_service,
        overall_status=overall,
        probes=probes_dict,
        triggered_by_user=actor.username,
        duration_ms=duration_ms,
    )
    db.add(row); db.commit(); db.refresh(row)

    audit_logger.record(
        db, action="bottleneck.run", actor=actor,
        target_type="bottleneck_run", target_id=row.id,
        details={
            "namespace": payload.namespace,
            "source_pod": payload.source_pod,
            "dest_pod": payload.dest_pod,
            "dest_service": payload.dest_service,
            "overall_status": overall,
            "duration_ms": duration_ms,
            "probes_run": selected_keys,
        },
        request=request,
    )
    return row
