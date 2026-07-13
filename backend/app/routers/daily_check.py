"""
일일 K8s 클러스터 헬스 체크 API
- 수동/스케줄 체크 실행
- 체크 결과 조회
- 스케줄 설정
"""
from datetime import datetime, date, time
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.models import Cluster, DailyCheckLog, CheckScheduleType, StatusEnum
from app.services.daily_checker import DailyChecker


router = APIRouter(prefix="/daily-check", tags=["Daily Check"])


# ============================================
# Schemas
# ============================================

class DailyCheckResponse(BaseModel):
    id: UUID
    cluster_id: UUID
    schedule_type: CheckScheduleType
    check_date: datetime
    overall_status: StatusEnum
    api_server_status: StatusEnum
    api_server_response_time_ms: Optional[int]
    api_server_details: Optional[dict]
    components_status: Optional[dict]
    total_nodes: int
    ready_nodes: int
    nodes_status: Optional[list]
    system_pods_status: Optional[list]
    error_messages: Optional[list]
    warning_messages: Optional[list]
    checked_at: datetime
    check_duration_seconds: Optional[int]
    # AI 자동 리뷰 (review_service.py 가 채움)
    ai_summary: Optional[str] = None
    ai_remediation: Optional[str] = None
    ai_diff: Optional[dict] = None
    ai_trend: Optional[dict] = None
    ai_status: Optional[str] = None
    ai_generated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ClusterSummary(BaseModel):
    cluster_id: UUID
    cluster_name: str
    latest_check: Optional[DailyCheckResponse]
    today_checks_count: int
    status: StatusEnum


# ============================================
# Endpoints
# ============================================

@router.post("/run/{cluster_id}", response_model=DailyCheckResponse)
async def run_daily_check(
    cluster_id: UUID,
    background_tasks: BackgroundTasks,
    schedule_type: CheckScheduleType = CheckScheduleType.manual,
    db: Session = Depends(get_db)
):
    """일일 체크 수동 실행"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    checker = DailyChecker(db)
    result = await checker.run_daily_check(str(cluster_id), schedule_type)

    return result


@router.get("/results/{cluster_id}", response_model=List[DailyCheckResponse])
async def get_check_results(
    cluster_id: UUID,
    limit: int = 10,
    offset: int = 0,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    db: Session = Depends(get_db)
):
    """체크 결과 조회"""
    query = db.query(DailyCheckLog).filter(DailyCheckLog.cluster_id == cluster_id)

    if date_from:
        query = query.filter(DailyCheckLog.check_date >= datetime.combine(date_from, time.min))
    if date_to:
        query = query.filter(DailyCheckLog.check_date <= datetime.combine(date_to, time.max))

    results = query.order_by(desc(DailyCheckLog.checked_at)).offset(offset).limit(limit).all()
    return results


@router.get("/results/{cluster_id}/latest", response_model=Optional[DailyCheckResponse])
async def get_latest_check_result(
    cluster_id: UUID,
    db: Session = Depends(get_db)
):
    """최신 체크 결과 조회"""
    result = db.query(DailyCheckLog).filter(
        DailyCheckLog.cluster_id == cluster_id
    ).order_by(desc(DailyCheckLog.checked_at)).first()

    if not result:
        raise HTTPException(status_code=404, detail="No check results found")

    return result


@router.get("/summary", response_model=List[ClusterSummary])
async def get_all_clusters_summary(db: Session = Depends(get_db)):
    """전체 클러스터 요약 (대시보드용)"""
    clusters = db.query(Cluster).all()
    summaries = []

    today_start = datetime.combine(date.today(), time.min)

    for cluster in clusters:
        # 최신 체크 결과
        latest = db.query(DailyCheckLog).filter(
            DailyCheckLog.cluster_id == cluster.id
        ).order_by(desc(DailyCheckLog.checked_at)).first()

        # 오늘 체크 횟수
        today_count = db.query(DailyCheckLog).filter(
            DailyCheckLog.cluster_id == cluster.id,
            DailyCheckLog.checked_at >= today_start
        ).count()

        summaries.append(ClusterSummary(
            cluster_id=cluster.id,
            cluster_name=cluster.name,
            latest_check=latest,
            today_checks_count=today_count,
            status=cluster.status
        ))

    return summaries
