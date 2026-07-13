"""K8s 실시간 이벤트 — kubewatch 웹훅 수신 + 조회 API."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.k8s_event import K8sEvent
from app.services.k8s_event_classifier import parse_kubewatch_payload

logger = logging.getLogger(__name__)

# 웹훅 수신 전용 — Bearer 토큰 인증 (JWT 없음, kubewatch/슈퍼팟 호출)
ingest_router = APIRouter(prefix="/events", tags=["K8s Events Ingest"])

# 일반 조회 — JWT 보호 (main.py 에서 get_current_user dependency 주입)
router = APIRouter(prefix="/events", tags=["K8s Events"])


# ── Schemas ───────────────────────────────────────────────────────────

class K8sEventOut(BaseModel):
    id: UUID
    cluster_id: Optional[UUID] = None
    event_type: str
    resource_kind: str
    resource_name: str
    namespace: Optional[str] = None
    reason: Optional[str] = None
    message: Optional[str] = None
    severity: str
    raw: Optional[dict[str, Any]] = None
    received_at: datetime

    class Config:
        from_attributes = True


class K8sEventListResponse(BaseModel):
    data: list[K8sEventOut]
    total: int


# ── 웹훅 수신 (ingest_router) ─────────────────────────────────────────

def _verify_kubewatch_token(authorization: str = Header(default="")) -> None:
    """Bearer <KUBEWATCH_TOKEN> 검증. 토큰 미설정 시 경고 로그 후 통과 (개발 편의)."""
    expected = settings.kubewatch_token
    if not expected:
        logger.warning("KUBEWATCH_TOKEN not set — accepting all webhook calls")
        return
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or token != expected:
        raise HTTPException(status_code=401, detail="Invalid kubewatch token")


@ingest_router.post("/kubewatch", status_code=201)
def receive_kubewatch_event(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    _: None = Depends(_verify_kubewatch_token),
) -> dict:
    """kubewatch 웹훅 수신 엔드포인트.

    payload 는 kubewatch 가 전송하는 raw JSON 그대로 받는다.
    파싱·severity 분류 후 DB 저장, critical 이면 알림 생성.
    """
    try:
        fields = parse_kubewatch_payload(payload)
        event = K8sEvent(
            cluster_id=None,  # kubewatch config 에 cluster_id env 가 있으면 활용 가능
            raw=payload,
            **fields,
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        if fields["severity"] == "critical":
            _create_notification(db, event)

        return {"id": str(event.id), "severity": event.severity}
    except Exception as exc:  # noqa: BLE001
        logger.error("kubewatch ingest error: %s", exc)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _create_notification(db: Session, event: K8sEvent) -> None:
    """critical 이벤트 → 인앱 알림 생성 (전체 사용자 대상 'all')."""
    try:
        from app.models.user_notification import UserNotification

        title = f"[CRITICAL] {event.resource_kind}/{event.resource_name}"
        body = event.reason or event.message or ""
        notif = UserNotification(
            recipient="all",
            type="k8s_event",
            title=title,
            body=body,
            link="/k8s-events",
        )
        db.add(notif)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("notification create failed: %s", exc)
        db.rollback()


# ── 조회 API (router — JWT 보호) ─────────────────────────────────────

@router.get("/", response_model=K8sEventListResponse)
def list_k8s_events(
    cluster_id: Optional[UUID] = None,
    severity: Optional[str] = None,
    resource_kind: Optional[str] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    db: Session = Depends(get_db),
) -> K8sEventListResponse:
    q = db.query(K8sEvent).order_by(desc(K8sEvent.received_at))
    if cluster_id:
        q = q.filter(K8sEvent.cluster_id == cluster_id)
    if severity:
        q = q.filter(K8sEvent.severity == severity)
    if resource_kind:
        q = q.filter(K8sEvent.resource_kind == resource_kind)
    total = q.count()
    events = q.offset(offset).limit(limit).all()
    return K8sEventListResponse(data=events, total=total)


@router.get("/{event_id}", response_model=K8sEventOut)
def get_k8s_event(event_id: UUID, db: Session = Depends(get_db)) -> K8sEventOut:
    event = db.query(K8sEvent).filter(K8sEvent.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@router.delete("/{event_id}", status_code=204)
def delete_k8s_event(event_id: UUID, db: Session = Depends(get_db)):
    event = db.query(K8sEvent).filter(K8sEvent.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    db.delete(event)
    db.commit()
