"""기술 동향(/trends) — 다이제스트·항목 조회, 수집(동기·SSE), 소스 관리, 설정.

권한(A-7):
  - 조회(GET)는 인증 사용자 전체(라우터 마운트 `_auth`).
  - 수집(`POST /collect`, `POST /collect/stream`)·소스 생성/수정/토글/비활성화는 ``require_operator`` + 감사
    (`trends.collect`, `trends.source.create|update|delete`).
  - 소스 하드 삭제(`DELETE /sources/{id}?hard=true`, 항목까지 삭제)·설정 변경(`PUT /settings`)은 admin 전용.

수집 동시 실행: 다이제스트(날짜) 단위 Redis 락 — 진행 중이면 409 "이미 수집 중입니다".
SSE 이벤트는 `services/sse.py` 규약(log/step/result/error). result 는 동기 `POST /collect` 응답과 같은 본문.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_admin, require_operator
from app.database import get_db
from app.models.user import User
from app.services import audit_logger
from app.services.sse import Emit, log_evt, step_evt, stream_async_job
from app.services.trends import trend_settings
from app.services.trends.collect_lock import collect_lock
from app.services.trends.trend_service import TrendCollectBusy, TrendService, effective_item_type
from app.services.trends.url_guard import validate_feed_url, validate_github_slug

router = APIRouter(prefix="/trends", tags=["trends"])

BUSY_DETAIL = "이미 수집 중입니다"
SourceType = Literal["github_release", "rss"]
ItemType = Literal["release", "blog", "news"]


# ── Response Schemas ────────────────────────────────────────────

class TrendSourceOut(BaseModel):
    id: UUID
    name: str
    source_type: str
    url: str
    category: str
    item_type: str
    enabled: bool
    last_status: Optional[str] = None       # ok | empty | error
    last_message: Optional[str] = None      # error 면 실패 사유
    last_item_count: Optional[int] = 0
    last_collected_at: Optional[str] = None
    last_success_at: Optional[str] = None


class TrendSourceCreateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    source_type: SourceType
    url: str = Field(..., min_length=1, max_length=500)
    category: str = Field(..., min_length=1, max_length=50)
    item_type: ItemType = "blog"
    enabled: bool = True


class TrendSourceUpdateIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    source_type: Optional[SourceType] = None
    url: Optional[str] = Field(None, min_length=1, max_length=500)
    category: Optional[str] = Field(None, min_length=1, max_length=50)
    item_type: Optional[ItemType] = None
    enabled: Optional[bool] = None


class TrendItemOut(BaseModel):
    id: UUID
    title: str
    url: str
    published_at: str
    summary_ko: Optional[str] = None
    summary_status: str                      # ok | failed | pending
    summary_error: Optional[str] = None
    summary_attempts: int = 0
    version: Optional[str] = None
    item_type: str
    source_name: str
    category: str


class TrendCollectSourceOut(BaseModel):
    id: str
    name: str
    status: str                              # ok | empty | error
    new_count: int
    fetched: int
    error: Optional[str] = None


class TrendCollectRunOut(BaseModel):
    mode: str                                # incremental | backfill
    lookback_days: Optional[int] = None
    source_total: int
    source_ok: int
    source_failed: int
    new_items: int
    summary_total: int
    summary_ok: int
    summary_failed: int
    overall_summary: str                     # ok | failed | skipped
    sources: list[TrendCollectSourceOut]


class TrendDigestOut(BaseModel):
    id: UUID
    digest_date: date
    overall_summary_ko: Optional[str] = None
    item_count: int
    status: str                              # pending|collecting|summarizing|done|partial|failed
    error_message: Optional[str] = None
    updated_at: Optional[str] = None
    summary_ok: int = 0
    summary_failed: int = 0
    summary_pending: int = 0
    run: Optional[TrendCollectRunOut] = None  # 수집 응답에만(이번 실행 요약)


class ToggleSourceRequest(BaseModel):
    enabled: bool


class TrendCollectIn(BaseModel):
    target_date: Optional[date] = None
    # 지정하면 백필(모든 소스를 N일 되돌아봄), 비우면 증분(소스별 마지막 성공 수집 이후)
    lookback_days: Optional[int] = Field(None, ge=1, le=365)


class TrendSettingsOut(BaseModel):
    github_api_url: str
    allowed_hosts: list[str]
    token_set: bool
    token_source: Optional[str] = None       # app_setting | env | null
    github_api_url_source: str = "env"       # app_setting | env


class TrendSettingsIn(BaseModel):
    github_api_url: Optional[str] = Field(None, max_length=500)
    allowed_hosts: Optional[list[str]] = None
    # write-only — None=유지, ""=삭제(env 폴백), 값=암호화 저장. 응답에 절대 싣지 않는다.
    github_token: Optional[str] = Field(None, max_length=500)
    clear_token: bool = False


# ── 수집 ────────────────────────────────────────────────────────

def _collect_params(
    payload: Optional[TrendCollectIn], target_date: Optional[date], lookback_days: Optional[int],
) -> tuple[date, Optional[int]]:
    """본문(JSON) 우선, 없으면 쿼리 파라미터(구 클라이언트 호환)."""
    td = (payload.target_date if payload and payload.target_date else None) or target_date or date.today()
    lb = (payload.lookback_days if payload and payload.lookback_days else None) or lookback_days
    if lb is not None and (lb < 1 or lb > 365):
        raise HTTPException(status_code=422, detail="lookback_days 는 1~365 사이여야 합니다")
    return td, lb


def _acquire_or_409(td: date) -> str:
    token = collect_lock.acquire(td)
    if token is None:
        raise HTTPException(status_code=409, detail=BUSY_DETAIL)
    return token


@router.post("/collect", response_model=TrendDigestOut)
async def trigger_collect(
    request: Request,
    payload: Optional[TrendCollectIn] = Body(None),
    target_date: Optional[date] = None,
    lookback_days: Optional[int] = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """수집 동기 실행(구 클라이언트·스크립트 호환). 화면은 `POST /collect/stream` 을 쓴다.

    ``lookback_days`` 를 주면 백필, 비우면 증분 수집.
    """
    td, lb = _collect_params(payload, target_date, lookback_days)
    token = _acquire_or_409(td)
    try:
        audit_logger.record(db, action="trends.collect", actor=user, status="success",
                            target_type="trend_digest", target_id=str(td),
                            details={"mode": "sync", "lookback_days": lb}, request=request)
        svc = TrendService(db)
    except Exception:
        collect_lock.release(td, token)
        raise
    try:
        digest = await svc.run_daily_collect(td, lookback_days=lb, lock_token=token)
    except TrendCollectBusy:
        raise HTTPException(status_code=409, detail=BUSY_DETAIL) from None
    return _digest_out(svc, digest, run=svc.last_run)


@router.post("/collect/stream")
async def trigger_collect_stream(
    request: Request,
    payload: Optional[TrendCollectIn] = Body(None),
    target_date: Optional[date] = None,
    lookback_days: Optional[int] = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """수집 SSE — 소스별 한 줄(`이름 · 신규 n[ · 실패 사유]`), 요약 진행(`요약 i/N · 제목`), 합계 줄.

    step: collect(소스 수집) → summarize(항목 요약) → digest(종합 요약). result = `POST /collect` 응답 본문.
    이미 수집 중이면 스트림을 열기 전에 409.
    """
    td, lb = _collect_params(payload, target_date, lookback_days)
    token = _acquire_or_409(td)
    try:
        audit_logger.record(db, action="trends.collect", actor=user, status="success",
                            target_type="trend_digest", target_id=str(td),
                            details={"mode": "stream", "lookback_days": lb}, request=request)
    except Exception:  # noqa: BLE001 — audit_logger 는 원래 삼키지만 락 누수 방지
        pass

    async def job(sdb: Session, emit: Emit):
        try:
            svc = TrendService(sdb)
        except Exception:
            collect_lock.release(td, token)
            raise
        digest = await svc.run_daily_collect(
            td, lookback_days=lb, lock_token=token,
            log=lambda lvl, msg: log_evt(emit, lvl, msg),
            step=lambda name, label, st: step_evt(emit, name, label, st),
        )
        return _digest_out(svc, digest, run=svc.last_run)

    return stream_async_job(job, name=f"trends-collect-{td}")


# ── 조회 ────────────────────────────────────────────────────────

@router.get("/digests", response_model=list[TrendDigestOut])
def list_digests(limit: int = Query(30, ge=1, le=365), db: Session = Depends(get_db)):
    svc = TrendService(db)
    digests = svc.list_digests(limit)
    counts = svc.summary_counts([d.digest_date for d in digests])
    return [_digest_out(svc, d, counts=counts.get(d.digest_date)) for d in digests]


@router.get("/digests/{target_date}", response_model=TrendDigestOut)
def get_digest(target_date: date, db: Session = Depends(get_db)):
    svc = TrendService(db)
    d = svc.get_digest(target_date)
    if not d:
        raise HTTPException(status_code=404, detail="해당 날짜의 다이제스트가 없습니다")
    return _digest_out(svc, d)


@router.get("/items/{target_date}", response_model=list[TrendItemOut])
def list_items(
    target_date: date,
    category: Optional[str] = None,
    item_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    svc = TrendService(db)
    items = svc.list_items(target_date, category, item_type)
    return [_item_out(i) for i in items]


@router.get("/sources", response_model=list[TrendSourceOut])
def list_sources(db: Session = Depends(get_db)):
    svc = TrendService(db)
    return [_source_out(s) for s in svc.list_sources()]


# ── 소스 관리 (operator) ─────────────────────────────────────────

def _validate_source(db: Session, source_type: str, url: str) -> str:
    try:
        if source_type == "github_release":
            return validate_github_slug(url)
        return validate_feed_url(url, trend_settings.effective(db)["allowed_hosts"])
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.patch("/sources/{source_id}", response_model=TrendSourceOut)
def toggle_source(source_id: UUID, body: ToggleSourceRequest, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(require_operator)):
    svc = TrendService(db)
    src = svc.toggle_source(str(source_id), body.enabled)
    if not src:
        raise HTTPException(status_code=404, detail="소스를 찾을 수 없습니다")
    audit_logger.record(db, action="trends.source.update", actor=user, status="success",
                        target_type="trend_source", target_id=str(source_id),
                        details={"name": src.name, "enabled": body.enabled}, request=request)
    return _source_out(src)


@router.post("/sources", response_model=TrendSourceOut, status_code=201)
def create_source(body: TrendSourceCreateIn, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(require_operator)):
    url = _validate_source(db, body.source_type, body.url)
    svc = TrendService(db)
    src = svc.create_source(
        name=body.name, source_type=body.source_type,
        url=url, category=body.category, enabled=body.enabled, item_type=body.item_type,
    )
    audit_logger.record(db, action="trends.source.create", actor=user, status="success",
                        target_type="trend_source", target_id=str(src.id),
                        details={"name": src.name, "source_type": src.source_type, "url": src.url,
                                 "category": src.category, "item_type": src.item_type}, request=request)
    return _source_out(src)


@router.put("/sources/{source_id}", response_model=TrendSourceOut)
def update_source(source_id: UUID, body: TrendSourceUpdateIn, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(require_operator)):
    svc = TrendService(db)
    cur = svc.get_source(str(source_id))
    if not cur:
        raise HTTPException(status_code=404, detail="소스를 찾을 수 없습니다")
    url = body.url
    if body.url is not None or body.source_type is not None:
        url = _validate_source(db, body.source_type or cur.source_type, body.url if body.url is not None else cur.url)
    changes = body.model_dump(exclude_none=True)
    src = svc.update_source(
        str(source_id),
        name=body.name, source_type=body.source_type,
        url=url, category=body.category, enabled=body.enabled, item_type=body.item_type,
    )
    audit_logger.record(db, action="trends.source.update", actor=user, status="success",
                        target_type="trend_source", target_id=str(source_id),
                        details={"name": src.name, "changes": changes}, request=request)
    return _source_out(src)


@router.delete("/sources/{source_id}", status_code=204)
def delete_source(source_id: UUID, request: Request, hard: bool = False,
                  db: Session = Depends(get_db), user: User = Depends(require_operator)):
    """기본 = 비활성화(과거 다이제스트 항목 보존). ``?hard=true`` 는 admin 만 — 항목까지 삭제."""
    svc = TrendService(db)
    src = svc.get_source(str(source_id))
    if not src:
        raise HTTPException(status_code=404, detail="소스를 찾을 수 없습니다")
    name = src.name
    if hard:
        if (user.role or "") != "admin":
            raise HTTPException(status_code=403, detail="소스 완전 삭제는 관리자만 할 수 있습니다(항목까지 삭제됨)")
        svc.delete_source(str(source_id))
    else:
        svc.deactivate_source(str(source_id))
    audit_logger.record(db, action="trends.source.delete", actor=user, status="success",
                        target_type="trend_source", target_id=str(source_id),
                        details={"name": name, "mode": "hard" if hard else "deactivate"}, request=request)
    return None


# ── 설정 ────────────────────────────────────────────────────────

@router.get("/settings", response_model=TrendSettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return trend_settings.public_view(db)


@router.put("/settings", response_model=TrendSettingsOut)
def put_settings(body: TrendSettingsIn, request: Request,
                 db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    try:
        out = trend_settings.update(
            db, github_api_url=body.github_api_url, allowed_hosts=body.allowed_hosts,
            github_token=body.github_token, clear_token=body.clear_token,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    details = {k: v for k, v in body.model_dump(exclude_none=True).items() if k != "github_token"}
    details["token_changed"] = body.github_token is not None or body.clear_token
    audit_logger.record(db, action="trends.settings.update", actor=actor, status="success",
                        target_type="trends", target_id="settings", details=details, request=request)
    return out


# ── helpers ─────────────────────────────────────────────────────

def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _digest_out(svc: TrendService, d, *, counts: Optional[dict] = None, run: Optional[dict] = None) -> dict:
    if counts is None:
        counts = svc.summary_counts([d.digest_date]).get(d.digest_date, {})
    return {
        "id": d.id,
        "digest_date": d.digest_date,
        "overall_summary_ko": d.overall_summary_ko,
        "item_count": d.item_count or 0,
        "status": d.status,
        "error_message": d.error_message,
        "updated_at": _iso(d.updated_at),
        "summary_ok": counts.get("ok", 0),
        "summary_failed": counts.get("failed", 0),
        "summary_pending": counts.get("pending", 0),
        "run": run,
    }


def _source_out(s) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "source_type": s.source_type,
        "url": s.url,
        "category": s.category,
        "item_type": effective_item_type(s),
        "enabled": bool(s.enabled),
        "last_status": s.last_status,
        "last_message": s.last_message,
        "last_item_count": s.last_item_count or 0,
        "last_collected_at": _iso(s.last_collected_at),
        "last_success_at": _iso(s.last_success_at),
    }


def _item_out(i) -> dict:
    return {
        "id": i.id,
        "title": i.title,
        "url": i.url,
        "published_at": i.published_at.isoformat(),
        "summary_ko": i.summary_ko,
        "summary_status": i.summary_status or "pending",
        "summary_error": i.summary_error,
        "summary_attempts": i.summary_attempts or 0,
        "version": i.version,
        "item_type": i.item_type,
        "source_name": i.source.name if i.source else "",
        "category": i.source.category if i.source else "",
    }
