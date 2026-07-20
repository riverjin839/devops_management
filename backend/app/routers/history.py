from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from uuid import UUID
from typing import Optional
import csv
import io

from app.database import get_db
from app.models import CheckLog
from app.schemas import CheckLogListResponse, CheckLogResponse

router = APIRouter(prefix="/history", tags=["history"])


@router.get("", response_model=CheckLogListResponse)
def get_check_logs(
    cluster_id: Optional[UUID] = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db)
):
    """점검 히스토리 조회"""
    # joinedload 로 cluster/addon 을 한 쿼리에서 LEFT JOIN 으로 함께 가져온다.
    # 예전엔 join(Cluster) 만 걸고 아래에서 log.cluster.name/log.addon_id 조회를
    # 각 행마다 별도 쿼리로 실행해(N+1) 페이지 20행에 최대 41쿼리가 나갔다.
    query = db.query(CheckLog).options(
        joinedload(CheckLog.cluster), joinedload(CheckLog.addon),
    )

    if cluster_id:
        query = query.filter(CheckLog.cluster_id == cluster_id)

    # 총 개수
    total = query.count()

    # 페이지네이션
    logs = (
        query
        .order_by(CheckLog.checked_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # Response 변환
    log_responses = []
    for log in logs:
        addon_name = log.addon.name if log.addon else None

        log_responses.append(CheckLogResponse(
            id=log.id,
            cluster_id=log.cluster_id,
            cluster_name=log.cluster.name,
            addon_id=log.addon_id,
            addon_name=addon_name,
            status=log.status,
            message=log.message,
            raw_output=log.raw_output,
            checked_at=log.checked_at
        ))
    
    return CheckLogListResponse(
        data=log_responses,
        total=total,
        page=page,
        page_size=page_size
    )


@router.get("/{cluster_id}/export")
def export_logs_csv(
    cluster_id: UUID,
    limit: int = Query(default=5000, ge=1, le=20000, description="최대 export 행 수 (메모리 보호용)"),
    db: Session = Depends(get_db),
):
    """클러스터 로그 CSV 내보내기 (최대 limit 행). 예전엔 상한 없이 클러스터 전체
    이력을 한 번에 메모리에 올려 로그가 오래 쌓인 클러스터에서 응답이 커지고
    느려질 수 있었다."""
    logs = (
        db.query(CheckLog)
        .filter(CheckLog.cluster_id == cluster_id)
        .order_by(CheckLog.checked_at.desc())
        .limit(limit)
        .all()
    )
    
    # CSV 생성
    output = io.StringIO()
    writer = csv.writer(output)
    
    # 헤더
    writer.writerow(["ID", "Status", "Message", "Checked At"])
    
    # 데이터
    for log in logs:
        writer.writerow([
            str(log.id),
            log.status.value,
            log.message,
            log.checked_at.isoformat()
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=cluster_{cluster_id}_logs.csv"
        }
    )
