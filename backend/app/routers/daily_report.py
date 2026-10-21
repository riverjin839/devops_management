"""일일 리포트 — K8S 자원 관리 NS 일 단위 리포트 API.

- `public_router` (`/public/daily-report/*`): **비인증** 마운트. `clusters` · `report` · `search`(NS/워크로드/파드 이름 검색). 로그인 없이 보는 공개 리포트 화면
  (`/daily-report`)이 쓴다. 설정 `public_enabled=false` 면 404. 노출 클러스터는 테넌트 바인딩이 없는
  클러스터(또는 설정 allowlist)만 — 테넌트 격리 클러스터가 공개 화면으로 새지 않게.
  읽기 전용이며 응답에 클러스터 id/이름과 NS 자원 수치 외 정보(엔드포인트·자격증명)는 싣지 않는다.
  공개 방식이 `link` 면 모든 공개 API 가 `?t=<공유 링크 토큰>` 을 요구한다(services/public_pages.py).
  `period` 는 주간·월간 추이 + 기간 평균 랭킹.
- `router` (`/daily-report/*`, JWT): 설정(공개 여부·공개 방식·보관 일수·랭킹 기준), NS 담당자 설정과
  "라벨 다시 읽기"(SSE 실시간 로그). 조회는 인증 사용자, 변경·실행은 require_admin (+감사).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin
from app.database import get_db
from app.models.user import User
from app.services import audit_logger, ns_owners
from app.services import public_pages as _pp
from app.services.k8s_efficiency import daily_report as _dr
from app.services.sse import Emit, log_evt, step_evt, stream_async_job

public_router = APIRouter(prefix="/public/daily-report", tags=["daily-report-public"])
router = APIRouter(prefix="/daily-report", tags=["daily-report"])


def _ensure_public(db: Session, token: Optional[str]) -> tuple[dict[str, Any], Any]:
    cfg = _dr.get_settings(db)
    if not cfg["public_enabled"]:
        raise HTTPException(status_code=404, detail="일일 리포트 공개가 비활성화되어 있습니다")
    return cfg, _pp.authorize(db, "daily_report", cfg["access_mode"], token)


def _clusters(db: Session, link) -> list:
    return _pp.filter_by_link(_dr.public_clusters(db), link)


def _public_cluster(db: Session, cluster_id: UUID, link):
    cluster = next((c for c in _clusters(db, link) if c.id == cluster_id), None)
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
def public_clusters(t: Optional[str] = Query(None, max_length=200), db: Session = Depends(get_db)):
    cfg, link = _ensure_public(db, t)
    today = _dr.today_local()
    return {
        "clusters": [{"id": str(c.id), "name": c.name} for c in _clusters(db, link)],
        "access_mode": cfg["access_mode"],
        "link_expires_at": link.expires_at.isoformat() if link else None,
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
    t: Optional[str] = Query(None, max_length=200),
    db: Session = Depends(get_db),
):
    cfg, link = _ensure_public(db, t)
    cluster = _public_cluster(db, cluster_id, link)
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
    t: Optional[str] = Query(None, max_length=200),
    db: Session = Depends(get_db),
):
    """본인 업무 모듈 찾기 — 네임스페이스·담당자·워크로드·파드 이름 부분 일치로 당일 NS 를 찾는다(TOP N 밖 포함)."""
    cfg, link = _ensure_public(db, t)
    cluster = _public_cluster(db, cluster_id, link)
    if rank_by not in _dr.RANK_KEYS:
        raise HTTPException(status_code=422, detail=f"rank_by 는 {', '.join(_dr.RANK_KEYS)} 중 하나")
    day = _check_day(day, cfg)
    try:
        return _dr.search_report(db, cluster, day, q, rank_by)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"일일 리포트 검색 실패: {str(e)[:200]}")


@public_router.get("/period")
def public_period(
    cluster_id: UUID,
    end: Optional[date] = Query(None),
    period: str = Query("week", pattern="^(week|month)$"),
    rank_by: str = Query("cpu_rate"),
    t: Optional[str] = Query(None, max_length=200),
    db: Session = Depends(get_db),
):
    """주간(7일)·월간(30일) — 일자별 사용률 추이 + 기간 평균 비효율 랭킹."""
    cfg, link = _ensure_public(db, t)
    cluster = _public_cluster(db, cluster_id, link)
    if rank_by not in _dr.RANK_KEYS:
        raise HTTPException(status_code=422, detail=f"rank_by 는 {', '.join(_dr.RANK_KEYS)} 중 하나")
    end = _check_day(end, cfg)
    try:
        return _dr.period_report(db, cluster, end, period, rank_by)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"기간 리포트 생성 실패: {str(e)[:200]}")


class DailyReportSettingsBody(BaseModel):
    public_enabled: Optional[bool] = None
    retention_days: Optional[int] = None
    top_n: Optional[int] = None
    min_cpu_req_m: Optional[int] = None
    min_mem_req_b: Optional[int] = None
    exclude_system_namespaces: Optional[bool] = None
    public_cluster_ids: Optional[list[str]] = None
    access_mode: Optional[str] = Field(None, pattern="^(open|link)$")


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


# ── NS 담당자 ──────────────────────────────────────────────────────────────────
class OwnerRule(BaseModel):
    pattern: str = Field(..., min_length=1, max_length=253)
    owner: str = Field(..., min_length=1, max_length=120)
    contact: Optional[str] = Field(None, max_length=200)
    cluster_id: Optional[str] = None


class OwnersBody(BaseModel):
    rules: Optional[list[OwnerRule]] = None
    label_keys: Optional[list[str]] = None
    show_contact: Optional[bool] = None


@router.get("/owners")
def get_owners(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    cache = ns_owners.label_cache(db)
    return {**ns_owners.get_settings(db),
            "label_cache": {cid: {"updated_at": v.get("updated_at"), "count": len(v.get("ns") or {})}
                            for cid, v in cache.items()}}


@router.put("/owners")
def put_owners(payload: OwnersBody, request: Request, db: Session = Depends(get_db),
               actor: User = Depends(require_admin)):
    values = payload.model_dump(exclude_none=True)
    val = ns_owners.set_settings(db, values)
    audit_logger.record(db, action="ns_owners.settings.update", actor=actor, status="success",
                        target_type="ns_owners", target_id="settings",
                        details={"rules": len(val["rules"]), "label_keys": val["label_keys"]}, request=request)
    return val


@router.post("/owners/refresh/stream")
async def refresh_owner_labels(request: Request, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    """NS 라벨 다시 읽기 — 공개 대상 클러스터(일일 리포트·외부 서비스 합집합)마다 SSE 로 진행을 흘린다."""
    from app.services import external_services as _es
    ids = {c.id for c in _dr.public_clusters(db)} | {c.id for c in _es.public_clusters(db)}
    audit_logger.record(db, action="ns_owners.labels.refresh", actor=actor, status="success",
                        target_type="ns_owners", target_id="labels", details={"clusters": len(ids)}, request=request)

    async def job(sdb: Session, emit: Emit):
        import asyncio
        from app.models import Cluster
        clusters = sdb.query(Cluster).filter(Cluster.id.in_(list(ids))).order_by(Cluster.name).all() if ids else []
        keys = ns_owners.get_settings(sdb)["label_keys"]
        log_evt(emit, "info", f"NS 담당자 라벨 다시 읽기 — 클러스터 {len(clusters)}개, 라벨 키 {', '.join(keys) or '(없음)'}")
        loop = asyncio.get_running_loop()
        ok = found = 0
        for c in clusters:
            step_evt(emit, str(c.id), c.name, "running")
            r = await loop.run_in_executor(None, lambda c=c: ns_owners.refresh_labels(
                sdb, c, emit=lambda lvl, msg: log_evt(emit, lvl, msg)))
            step_evt(emit, str(c.id), c.name, "done" if r.get("ok") else "failed")
            ok += 1 if r.get("ok") else 0
            found += r.get("found") or 0
        log_evt(emit, "info" if ok == len(clusters) else "warn",
                f"완료 — 성공 {ok}/{len(clusters)} 클러스터 · 담당자 라벨 {found}개")
        return {"clusters": len(clusters), "ok": ok, "found": found}

    return stream_async_job(job, name="ns-owner-labels-refresh")
