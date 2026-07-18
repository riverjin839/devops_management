"""Deep check 결과 조회 + ingest + 즉시 실행 + 리뷰 + trend API."""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
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
    """In-cluster super pod 의 결과 push 진입점. Bearer 토큰 인증.

    보안: 이 라우터는 JWT 없이 마운트되므로 **토큰이 유일한 방어선**이다.
    - 토큰 미설정(빈 값)이면 fail-closed 로 503 거부 — 무인증 상태로 임의 결과가
      주입돼 대시보드/알림이 오염되는 것을 막는다 (SUPERPOD_INGEST_TOKEN 설정 필수).
    - 비교는 타이밍 공격 방지를 위해 secrets.compare_digest 사용.
    """
    expected = (settings.superpod_ingest_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                "Ingest 비활성화: SUPERPOD_INGEST_TOKEN 이 설정되지 않았습니다. "
                "관리자가 토큰을 설정해야 in-cluster 결과 수집이 허용됩니다."
            ),
        )
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
    if not secrets.compare_digest(token, expected):
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

@router.post("/run/{cluster_id}", dependencies=[Depends(require_operator)])
def run_deep_check_now(
    cluster_id: UUID,
    daily_check_log_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
):
    """클러스터의 enabled deep check 전체 실행.

    부하/타임아웃 보호: exec·파드생성이 섞인 다수 점검을 요청 스레드에서 직렬로
    돌리면 게이트웨이 타임아웃(504) 위험이 있어 **Celery 백그라운드로 enqueue** 한다.
    broker/worker 부재 시에만 동기 폴백(ops-checks 와 동일 패턴). 권한: operator 이상.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")

    log_arg = str(daily_check_log_id) if daily_check_log_id else None
    try:
        from app.celery_app import run_deep_check_for_cluster
        task = run_deep_check_for_cluster.delay(str(cluster_id), log_arg)
        return {"status": "queued", "task_id": str(getattr(task, "id", "")) or None}
    except Exception as e:  # noqa: BLE001
        logger.warning("run_now: Celery enqueue 실패 → 동기 폴백 (%s)", e)

    # 동기 폴백 — worker/broker 부재 환경.
    import asyncio

    svc = DeepCheckService(db)
    n, log_id = asyncio.run(
        svc.run_for_cluster(
            str(cluster_id),
            in_cluster=False,
            daily_check_log_id=daily_check_log_id,
        )
    )
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
