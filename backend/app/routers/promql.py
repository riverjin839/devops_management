"""
PromQL Metric Cards router — CRUD + query execution.

Provides a No-Code dashboard builder: users create metric cards via the UI
with a PromQL query, and the backend executes them against Prometheus.
"""

import asyncio
import time
from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models.metric_card import MetricCard
from app.models.user import User
from app.schemas.metric_card import (
    MetricCardCreate,
    MetricCardUpdate,
    MetricCardResponse,
    MetricCardListResponse,
    MetricQueryResult,
    MetricSparklineResult,
    MetricSparklinePoint,
)
from app.services.prometheus_service import prometheus_service
from app.services.grafana_service import grafana_service

router = APIRouter(prefix="/promql", tags=["promql"])

# ── /query/all 캐시 ──────────────────────────────────────────────────
# 대시보드 탭이 여러 개 열려 있으면 각자 30초 폴링 → 카드 수 × 탭 수만큼 실
# Prometheus 쿼리가 나간다. 폴링 주기의 절반 정도 TTL 로 인메모리 캐시해 동시
# 폴링을 흡수한다. 카드 CRUD 시 아래 헬퍼로 즉시 무효화해 편집 직후에는 캐시가
# 아닌 최신 값이 보이게 한다. 프로세스(워커) 단위 캐시라 멀티 replica 에선
# replica 마다 별도로 채워지지만, 그래도 요청 수는 replica 수준으로 줄어든다.
_QUERY_ALL_CACHE_TTL = 15.0
_query_all_cache: dict = {"ts": 0.0, "data": None}


def _invalidate_query_all_cache() -> None:
    _query_all_cache["ts"] = 0.0
    _query_all_cache["data"] = None


# ── CRUD ──────────────────────────────────────────────────────────────

@router.get("/cards", response_model=MetricCardListResponse)
def list_cards(
    category: Optional[str] = None,
    enabled_only: bool = True,
    db: Session = Depends(get_db),
):
    """List all metric cards, optionally filtered by category."""
    q = db.query(MetricCard)
    if enabled_only:
        q = q.filter(MetricCard.enabled == True)  # noqa: E712
    if category:
        q = q.filter(MetricCard.category == category)
    cards = q.order_by(MetricCard.sort_order, MetricCard.created_at).all()
    return MetricCardListResponse(data=cards)


@router.get("/cards/{card_id}", response_model=MetricCardResponse)
def get_card(card_id: UUID, db: Session = Depends(get_db)):
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")
    return card


@router.post("/cards", response_model=MetricCardResponse)
def create_card(
    body: MetricCardCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    card = MetricCard(**body.model_dump())
    db.add(card)
    db.commit()
    db.refresh(card)
    _invalidate_query_all_cache()
    return card


@router.put("/cards/{card_id}", response_model=MetricCardResponse)
def update_card(
    card_id: UUID,
    body: MetricCardUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(card, key, value)
    db.commit()
    db.refresh(card)
    _invalidate_query_all_cache()
    return card


@router.delete("/cards/{card_id}")
def delete_card(
    card_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")
    db.delete(card)
    db.commit()
    _invalidate_query_all_cache()
    return {"message": "Metric card deleted"}


# ── Query execution ───────────────────────────────────────────────────
# 주의: /query/all 은 반드시 /query/{card_id} 보다 먼저 선언해야 한다.
# card_id: UUID 타입 검증이 "all" 문자열에서 먼저 실패해 422 를 내버리면
# 아래 /query/all 라우트로 폴백되지 않는다(Starlette 는 컨버터 실패 시
# 다음 라우트로 넘어가지 않음) — 실제로 이 순서가 뒤집혀 있어 전체
# Prometheus Insights 섹션이 항상 "Loading..." 에 멈춰있던 버그였다.

@router.get("/query/all", response_model=list[MetricQueryResult])
async def query_all_cards(db: Session = Depends(get_db)):
    """Execute all enabled metric cards and return results.

    카드를 병렬로 조회(과거엔 직렬 await 라 카드 하나가 느리면 응답 전체가 그만큼
    늦어졌다) + 짧은 TTL 캐시(동시 폴링 흡수).
    """
    now = time.monotonic()
    cached = _query_all_cache["data"]
    if cached is not None and now - _query_all_cache["ts"] < _QUERY_ALL_CACHE_TTL:
        return cached

    cards = (
        db.query(MetricCard)
        .filter(MetricCard.enabled == True)  # noqa: E712
        .order_by(MetricCard.sort_order, MetricCard.created_at)
        .all()
    )
    raw_results = await asyncio.gather(*(prometheus_service.query(card.promql) for card in cards))
    results = [
        MetricQueryResult(card_id=card.id, **result)
        for card, result in zip(cards, raw_results)
    ]
    _query_all_cache["ts"] = now
    _query_all_cache["data"] = results
    return results


@router.get("/query/{card_id}", response_model=MetricQueryResult)
async def query_card(card_id: UUID, db: Session = Depends(get_db)):
    """Execute the PromQL query for a specific card and return the result."""
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")

    result = await prometheus_service.query(card.promql)
    return MetricQueryResult(card_id=card.id, **result)


@router.get("/query/{card_id}/sparkline", response_model=MetricSparklineResult)
async def query_card_sparkline(card_id: UUID, db: Session = Depends(get_db)):
    """카드의 PromQL 을 최근 1시간 range query 로 실행 — KPI 카드 하단 Sparkline 용
    (DESIGN_SYSTEM §5②). Prometheus 미연결/쿼리 실패는 fail-safe 로 offline/error 반환,
    500 을 내지 않는다(PrometheusService 규약)."""
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")

    now = time.time()
    result = await prometheus_service.query_range(card.promql, now - 3600, now, "5m")
    if result["status"] != "ok":
        return MetricSparklineResult(card_id=card.id, status=result["status"], error=result.get("error"))

    series = result.get("series") or []
    if not series:
        return MetricSparklineResult(card_id=card.id, status="ok", points=[])

    points = [
        MetricSparklinePoint(ts=float(ts), value=float(val))
        for ts, val in series[0].get("values", [])
    ]
    return MetricSparklineResult(card_id=card.id, status="ok", points=points)


@router.post("/query/test")
async def test_query(body: dict, _: User = Depends(require_operator)):
    """Test an arbitrary PromQL query without saving it.

    임의 PromQL 을 즉시 실행하는 프로브라 내부 Prometheus 를 정찰하는 데 쓰일 수
    있음 — viewer 가 아닌 operator 이상만 허용.
    """
    promql = body.get("promql", "")
    if not promql:
        raise HTTPException(status_code=400, detail="promql is required")
    result = await prometheus_service.query(promql)
    return result


# ── Prometheus health ─────────────────────────────────────────────────

@router.get("/health")
async def prometheus_health():
    """Quick Prometheus availability probe."""
    return await prometheus_service.health_check()


@router.get("/cards/{card_id}/snapshot", response_class=Response)
async def snapshot_card(card_id: UUID, db: Session = Depends(get_db)):
    """Grafana Image Renderer 를 통해 패널 PNG 스냅샷 반환.

    MetricCard.grafana_panel_url 이 설정돼 있어야 한다 (예: /d-solo/abc/dash?panelId=2).
    renderer 오프라인 또는 URL 미설정 시 503 반환.
    """
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")
    if not card.grafana_panel_url:
        raise HTTPException(status_code=400, detail="grafana_panel_url not configured for this card")
    png = await grafana_service.render_panel(card.grafana_panel_url)
    if png is None:
        raise HTTPException(status_code=503, detail="Grafana renderer unavailable")
    return Response(content=png, media_type="image/png")


@router.get("/renderer/health")
async def renderer_health():
    """Grafana Image Renderer 가용성 프로브."""
    return await grafana_service.renderer_health_check()
