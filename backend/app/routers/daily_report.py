"""일일 리포트 — K8S 자원 관리 NS 일 단위 리포트 API.

- `public_router` (`/public/daily-report/*`): **비인증** 마운트. `clusters` · `report` · `search`(NS/워크로드/파드 이름 검색). 로그인 없이 보는 공개 리포트 화면
  (`/daily-report`)이 쓴다. 설정 `public_enabled=false` 면 404. 노출 클러스터는 테넌트 바인딩이 없는
  클러스터(또는 설정 allowlist)만 — 테넌트 격리 클러스터가 공개 화면으로 새지 않게.
  읽기 전용이며 응답에 클러스터 id/이름과 NS 자원 수치 외 정보(엔드포인트·자격증명)는 싣지 않는다.
- `router` (`/daily-report/settings`): 공개 여부·보관 일수·랭킹 기준 설정. 조회는 인증 사용자,
  변경은 require_admin (+감사).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin
from app.database import get_db
from app.models.user import User
from app.services import audit_logger
from app.services.k8s_efficiency import daily_report as _dr

public_router = APIRouter(prefix="/public/daily-report", tags=["daily-report-public"])
router = APIRouter(prefix="/daily-report", tags=["daily-report"])


def _ensure_public(db: Session) -> dict[str, Any]:
    cfg = _dr.get_settings(db)
    if not cfg["public_enabled"]:
        raise HTTPException(status_code=404, detail="일일 리포트 공개가 비활성화되어 있습니다")
    return cfg


def _public_cluster(db: Session, cluster_id: UUID):
    cluster = next((c for c in _dr.public_clusters(db) if c.id == cluster_id), None)
    if cluster is None:
        raise HTTPException(status_code=404, detail="공개 대상 클러스터가 아닙니다")
    return cluster


def _check_day(day: Optional[date], cfg: dict[str, Any]) -> date:
    today = _dr.today_local()
    day = day or today
    if day > today:
        raise HTTPException(status_code=400, detail="미래 날짜는 조회할 수 없습니다")
    if day < today - timedelta(days=cfg["retention_days"]):
        raise HTTPException(status_code=400,
                            detail=f"보관 기간({cfg['retention_days']}일)을 벗어난 날짜입니다")
    return day


@public_router.get("/clusters")
def public_clusters(db: Session = Depends(get_db)):
    cfg = _ensure_public(db)
    today = _dr.today_local()
    return {
        "clusters": [{"id": str(c.id), "name": c.name} for c in _dr.public_clusters(db)],
        "today": today.isoformat(),
        "min_date": (today - timedelta(days=cfg["retention_days"])).isoformat(),
        "retention_days": cfg["retention_days"],
        "top_n": cfg["top_n"],
        "timezone": str(_dr.report_tz()),
    }


@public_router.get("/report")
def public_report(
    cluster_id: UUID,
    day: Optional[date] = Query(None, alias="date"),
    rank_by: str = Query("cpu_rate"),
    db: Session = Depends(get_db),
):
    cfg = _ensure_public(db)
    cluster = _public_cluster(db, cluster_id)
    if rank_by not in _dr.RANK_KEYS:
        raise HTTPException(status_code=422, detail=f"rank_by 는 {', '.join(_dr.RANK_KEYS)} 중 하나")
    day = _check_day(day, cfg)
    try:
        return _dr.build_report(db, cluster, day, rank_by)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"일일 리포트 생성 실패: {str(e)[:200]}")


@public_router.get("/search")
def public_search(
    cluster_id: UUID,
    q: str = Query(..., min_length=2, max_length=100),
    day: Optional[date] = Query(None, alias="date"),
    rank_by: str = Query("cpu_rate"),
    db: Session = Depends(get_db),
):
    """본인 업무 모듈 찾기 — 네임스페이스·워크로드·파드 이름 부분 일치로 당일 NS 를 찾는다(TOP N 밖 포함)."""
    cfg = _ensure_public(db)
    cluster = _public_cluster(db, cluster_id)
    if rank_by not in _dr.RANK_KEYS:
        raise HTTPException(status_code=422, detail=f"rank_by 는 {', '.join(_dr.RANK_KEYS)} 중 하나")
    day = _check_day(day, cfg)
    try:
        return _dr.search_report(db, cluster, day, q, rank_by)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"일일 리포트 검색 실패: {str(e)[:200]}")


class DailyReportSettingsBody(BaseModel):
    public_enabled: Optional[bool] = None
    retention_days: Optional[int] = None
    top_n: Optional[int] = None
    min_cpu_req_m: Optional[int] = None
    min_mem_req_b: Optional[int] = None
    exclude_system_namespaces: Optional[bool] = None
    public_cluster_ids: Optional[list[str]] = None


@router.get("/settings")
def get_settings(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return _dr.get_settings(db)


@router.put("/settings")
def put_settings(payload: DailyReportSettingsBody, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_admin)):
    values = payload.model_dump(exclude_none=True)
    val = _dr.set_settings(db, values)
    audit_logger.record(db, action="daily_report.settings.update", actor=actor, status="success",
                        target_type="daily_report", target_id="settings", details=values, request=request)
    return val
