"""Deep check 결과 조회 + ingest + 즉시 실행 + 리뷰 + trend API."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import (
    Cluster,
    DailyCheckLog,
    DeepCheckResult,
    StatusEnum,
)
from app.services.deep_check_service import DeepCheckService
from app.services.review_service import ReviewService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/deep-check", tags=["Deep Check"])

# Ingest 는 별도 router — bearer 토큰만 검증 (JWT X). super pod 가 호출.
ingest_router = APIRouter(prefix="/deep-check", tags=["Deep Check Ingest"])


# ───────────────────────────────────────────────────────────────
# Schemas
# ───────────────────────────────────────────────────────────────

class DeepCheckResultOut(BaseModel):
    id: UUID
    cluster_id: UUID
    daily_check_log_id: Optional[UUID] = None
    definition_id: Optional[UUID] = None
    check_type: str
    status: StatusEnum
    message: Optional[str] = None
    details: Optional[dict[str, Any]] = None
    duration_ms: int = 0
    checked_at: datetime

    class Config:
        from_attributes = True


class IngestItem(BaseModel):
    check_type: str
    status: str = Field(description="healthy|warning|critical|pending")
    message: Optional[str] = None
    details: Optional[dict[str, Any]] = None
    duration_ms: int = 0
    definition_id: Optional[UUID] = None


class IngestPayload(BaseModel):
    cluster_id: UUID
    daily_check_log_id: Optional[UUID] = None
    executed_at: Optional[datetime] = None
    results: list[IngestItem]


class ReviewResponse(BaseModel):
    daily_check_log_id: UUID
    cluster_id: UUID
    overall_status: StatusEnum
    ai_summary: Optional[str] = None
    ai_remediation: Optional[str] = None
    ai_diff: Optional[dict[str, Any]] = None
    ai_trend: Optional[dict[str, Any]] = None
    ai_status: Optional[str] = None
    ai_generated_at: Optional[datetime] = None
    deep_results: list[DeepCheckResultOut] = []


# ───────────────────────────────────────────────────────────────
# Ingest (token-auth, no JWT — super pod 에서 호출)
# ───────────────────────────────────────────────────────────────

@ingest_router.post("/ingest")
def ingest_results(
    payload: IngestPayload,
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """In-cluster super pod 의 결과 push 진입점. Bearer 토큰 인증."""
    expected = (settings.superpod_ingest_token or "").strip()
    if expected:
        token = ""
        if authorization and authorization.lower().startswith("bearer "):
            token = authorization.split(None, 1)[1].strip()
        if token != expected:
            raise HTTPException(status_code=401, detail="Invalid ingest token")

    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    svc = DeepCheckService(db)
    n, log_id = svc.persist_ingest_payload(payload.model_dump(mode="json"))

    # AI 리뷰 + 알림 — best-effort
    if log_id:
        try:
            from app.celery_app import run_review_and_notify
            run_review_and_notify.delay(log_id)
        except Exception:
            logger.warning("ingest: failed to queue review for log %s", log_id)

    return {"status": "ok", "saved": n}


# ───────────────────────────────────────────────────────────────
# Manual trigger
# ───────────────────────────────────────────────────────────────

@router.post("/run/{cluster_id}")
async def run_deep_check_now(
    cluster_id: UUID,
    daily_check_log_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    svc = DeepCheckService(db)
    n, log_id = await svc.run_for_cluster(
        str(cluster_id),
        in_cluster=False,
        daily_check_log_id=daily_check_log_id,
    )

    # AI 리뷰 + 알림 — best-effort
    if log_id:
        try:
            from app.celery_app import run_review_and_notify
            run_review_and_notify.delay(log_id)
        except Exception:
            logger.warning("run_now: failed to queue review for log %s", log_id)

    return {"status": "ok", "checks_run": n}


# ───────────────────────────────────────────────────────────────
# Results
# ───────────────────────────────────────────────────────────────

@router.get("/results/{cluster_id}", response_model=list[DeepCheckResultOut])
def get_results(
    cluster_id: UUID,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    rows = (
        db.query(DeepCheckResult)
        .filter(DeepCheckResult.cluster_id == cluster_id)
        .order_by(desc(DeepCheckResult.checked_at))
        .offset(offset)
        .limit(limit)
        .all()
    )
    return rows


@router.get("/results/{cluster_id}/latest", response_model=list[DeepCheckResultOut])
def get_latest_results(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터의 가장 최신 daily_check_log 와 묶인 deep 결과들을 반환."""
    latest_log = (
        db.query(DailyCheckLog)
        .filter(DailyCheckLog.cluster_id == cluster_id)
        .order_by(desc(DailyCheckLog.checked_at))
        .first()
    )
    if latest_log is None:
        return []
    rows = (
        db.query(DeepCheckResult)
        .filter(DeepCheckResult.daily_check_log_id == latest_log.id)
        .order_by(DeepCheckResult.check_type.asc())
        .all()
    )
    if not rows:
        # daily_check_log_id 미지정으로 push 된 결과 fallback
        rows = (
            db.query(DeepCheckResult)
            .filter(DeepCheckResult.cluster_id == cluster_id)
            .order_by(desc(DeepCheckResult.checked_at))
            .limit(20)
            .all()
        )
    return rows


@router.get("/review/{daily_check_log_id}", response_model=ReviewResponse)
def get_review(daily_check_log_id: UUID, db: Session = Depends(get_db)):
    """AI 요약 + diff + trend + 같은 회차의 deep results 를 묶어서 반환."""
    log = db.query(DailyCheckLog).filter(DailyCheckLog.id == daily_check_log_id).first()
    if log is None:
        raise HTTPException(status_code=404, detail="DailyCheckLog not found")
    deep = (
        db.query(DeepCheckResult)
        .filter(DeepCheckResult.daily_check_log_id == log.id)
        .order_by(DeepCheckResult.check_type.asc())
        .all()
    )
    return ReviewResponse(
        daily_check_log_id=log.id,
        cluster_id=log.cluster_id,
        overall_status=log.overall_status,
        ai_summary=log.ai_summary,
        ai_remediation=log.ai_remediation,
        ai_diff=log.ai_diff,
        ai_trend=log.ai_trend,
        ai_status=log.ai_status,
        ai_generated_at=log.ai_generated_at,
        deep_results=deep,
    )


@router.post("/review/{daily_check_log_id}/regenerate", response_model=ReviewResponse)
async def regenerate_review(daily_check_log_id: UUID, db: Session = Depends(get_db)):
    """AI 리뷰 강제 재생성 — Ollama 가 새로 응답을 주도록."""
    svc = ReviewService(db)
    await svc.review_and_persist(daily_check_log_id)
    return get_review(daily_check_log_id, db)


@router.get("/trend/{cluster_id}")
def get_trend(cluster_id: UUID, days: int = 7, db: Session = Depends(get_db)):
    """클러스터의 최근 N일간 daily check + deep result 분포."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    logs = (
        db.query(DailyCheckLog)
        .filter(DailyCheckLog.cluster_id == cluster_id)
        .filter(DailyCheckLog.checked_at >= cutoff)
        .order_by(DailyCheckLog.checked_at.asc())
        .all()
    )
    points = [
        {
            "id": str(l.id),
            "checked_at": l.checked_at.isoformat() if l.checked_at else None,
            "overall_status": l.overall_status.value if l.overall_status else None,
            "schedule_type": l.schedule_type.value if l.schedule_type else None,
            "ready_nodes": l.ready_nodes or 0,
            "total_nodes": l.total_nodes or 0,
            "errors": len(l.error_messages) if l.error_messages else 0,
            "warnings": len(l.warning_messages) if l.warning_messages else 0,
        }
        for l in logs
    ]
    by_status: dict[str, int] = {}
    for p in points:
        by_status[p["overall_status"] or "unknown"] = by_status.get(p["overall_status"] or "unknown", 0) + 1
    return {
        "cluster_id": str(cluster_id),
        "days": days,
        "points": points,
        "totals": by_status,
    }
