"""
PromQL Metric Cards router — CRUD + query execution.

Provides a No-Code dashboard builder: users create metric cards via the UI
with a PromQL query, and the backend executes them against Prometheus.
"""

from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.metric_card import MetricCard
from app.schemas.metric_card import (
    MetricCardCreate,
    MetricCardUpdate,
    MetricCardResponse,
    MetricCardListResponse,
    MetricQueryResult,
)
from app.services.prometheus_service import prometheus_service
from app.services.grafana_service import grafana_service

router = APIRouter(prefix="/promql", tags=["promql"])


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
def create_card(body: MetricCardCreate, db: Session = Depends(get_db)):
    card = MetricCard(**body.model_dump())
    db.add(card)
    db.commit()
    db.refresh(card)
    return card


@router.put("/cards/{card_id}", response_model=MetricCardResponse)
def update_card(card_id: UUID, body: MetricCardUpdate, db: Session = Depends(get_db)):
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(card, key, value)
    db.commit()
    db.refresh(card)
    return card


@router.delete("/cards/{card_id}")
def delete_card(card_id: UUID, db: Session = Depends(get_db)):
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")
    db.delete(card)
    db.commit()
    return {"message": "Metric card deleted"}


# ── Query execution ───────────────────────────────────────────────────

@router.get("/query/{card_id}", response_model=MetricQueryResult)
async def query_card(card_id: UUID, db: Session = Depends(get_db)):
    """Execute the PromQL query for a specific card and return the result."""
    card = db.query(MetricCard).filter(MetricCard.id == card_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Metric card not found")

    result = await prometheus_service.query(card.promql)
    return MetricQueryResult(card_id=card.id, **result)


@router.post("/query/test")
async def test_query(body: dict):
    """Test an arbitrary PromQL query without saving it."""
    promql = body.get("promql", "")
    if not promql:
        raise HTTPException(status_code=400, detail="promql is required")
    result = await prometheus_service.query(promql)
    return result


@router.get("/query/all", response_model=list[MetricQueryResult])
async def query_all_cards(db: Session = Depends(get_db)):
    """Execute all enabled metric cards and return results."""
    cards = (
        db.query(MetricCard)
        .filter(MetricCard.enabled == True)  # noqa: E712
        .order_by(MetricCard.sort_order, MetricCard.created_at)
        .all()
    )
    results = []
    for card in cards:
        result = await prometheus_service.query(card.promql)
        results.append(MetricQueryResult(card_id=card.id, **result))
    return results


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
