"""K8s 실시간 이벤트 — kubewatch 웹훅 수신 + 조회 API."""
from __future__ import annotations

import logging
import secrets
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.auth.deps import get_cluster_scope, require_operator
from app.services.cluster_access import ClusterScope, require_cluster_access
from app.config import settings
from app.database import get_db
from app.models.cluster import Cluster
from app.models.k8s_event import K8sEvent
from app.models.user import User
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
    # AI 자동 분석 연결 — null(미대상) | queued | running | done | failed | skipped
    analysis_id: Optional[UUID] = None
    analysis_status: Optional[str] = None

    class Config:
        from_attributes = True


class K8sEventListResponse(BaseModel):
    data: list[K8sEventOut]
    total: int


# ── 웹훅 수신 (ingest_router) ─────────────────────────────────────────

def _verify_kubewatch_token(authorization: str = Header(default="")) -> None:
    """Bearer <KUBEWATCH_TOKEN> 검증.

    Fail-closed: 토큰 미설정 시 무인증으로 통과시키지 않고 ingest 자체를 비활성화한다
    (deep_check ingest 의 _verify_superpod_token 과 동일 정책). 예전에는 토큰 미설정 시
    경고 로그만 남기고 통과시켜, 배포자가 KUBEWATCH_TOKEN 설정을 빠뜨리면 인증 없이
    위조 K8s 이벤트를 주입할 수 있었다.
    비교는 타이밍 공격 방지를 위해 secrets.compare_digest 사용.
    """
    expected = (settings.kubewatch_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                "Ingest 비활성화: KUBEWATCH_TOKEN 이 설정되지 않았습니다. "
                "관리자가 토큰을 설정해야 kubewatch 웹훅 수신이 허용됩니다."
            ),
        )
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid kubewatch token")


def _resolve_cluster_ref(db: Session, ref: Optional[str]) -> tuple[Optional[UUID], Optional[str]]:
    """웹훅 URL 의 `?cluster=` 값(클러스터 id 또는 이름) → cluster_id. 못 찾으면 (None, 사유)."""
    ref = (ref or "").strip()
    if not ref:
        return None, None
    try:
        cluster = db.query(Cluster).filter(Cluster.id == UUID(ref)).first()
    except ValueError:
        cluster = db.query(Cluster).filter(Cluster.name == ref).first()
    if cluster is None:
        return None, f"알 수 없는 클러스터 '{ref}' — 클러스터 미지정으로 저장했습니다."
    return cluster.id, None


@ingest_router.post("/kubewatch", status_code=201)
def receive_kubewatch_event(
    payload: dict[str, Any],
    cluster: Optional[str] = Query(
        default=None,
        description="이 kubewatch 가 감시하는 클러스터(id 또는 이름). 웹훅 URL 에 `?cluster=<이름>` 으로 붙인다.",
    ),
    db: Session = Depends(get_db),
    _: None = Depends(_verify_kubewatch_token),
) -> dict:
    """kubewatch 웹훅 수신 엔드포인트.

    payload 는 kubewatch 가 전송하는 raw JSON 그대로 받는다(클러스터 정보가 없다).
    그래서 클러스터는 웹훅 URL 의 `?cluster=` 로 받는다 — 없으면 클러스터 미지정(전체 공개)으로
    저장된다(D-101: 예전엔 항상 미지정이라 클러스터 필터가 늘 빈 목록이고 테넌트 격리가 무력했다).
    파싱·severity 분류 후 DB 저장, critical 이면 그 클러스터를 볼 수 있는 사용자에게 알림.
    """
    try:
        cluster_id, cluster_warning = _resolve_cluster_ref(db, cluster)
        if cluster_warning:
            logger.warning("kubewatch ingest: %s", cluster_warning)
        fields = parse_kubewatch_payload(payload)
        event = K8sEvent(
            cluster_id=cluster_id,
            raw=payload,
            **fields,
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        if fields["severity"] == "critical":
            _create_notification(db, event)

        # AI 자동 분석 훅 — scope 매칭 시 전용 llm 큐로 enqueue. 어떤 실패도
        # 이벤트 수신을 막지 않는다 (maybe_enqueue_analysis_for_k8s_event 자체가
        # 절대 raise 안 함 — alert 파이프라인과 동일한 fail-safe 계약).
        try:
            from app.services.observability.analysis_hook import maybe_enqueue_analysis_for_k8s_event
            maybe_enqueue_analysis_for_k8s_event(db, event)
            db.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("k8s_event 자동 분석 훅 실패 — 무시 (%s)", exc)

        out = {"id": str(event.id), "severity": event.severity,
               "cluster_id": str(cluster_id) if cluster_id else None}
        if cluster_warning:
            out["warning"] = cluster_warning
        return out
    except Exception as exc:  # noqa: BLE001
        # 내부 예외 문구는 로그에만 — 웹훅 호출자에게 스택/SQL 을 흘리지 않는다.
        logger.exception("kubewatch ingest error: %s", exc)
        db.rollback()
        raise HTTPException(status_code=500, detail="이벤트 저장에 실패했습니다 — 서버 로그를 확인하세요.") from exc


def _create_notification(db: Session, event: K8sEvent) -> None:
    """critical 이벤트 → 인앱 알림 생성 (활성 사용자 전체에 개인 행으로 팬아웃).

    과거에는 `recipient="all"` 공유 행 하나를 넣었는데, 조회 쪽(`notifications._me_ids`)이
    그 센티널을 매칭하지 않아 이 알림이 아무에게도 보이지 않았다.
    """
    try:
        from app.services.user_notify import notify_broadcast

        notify_broadcast(
            db,
            type="k8s_event",
            title=f"[CRITICAL] {event.resource_kind}/{event.resource_name}",
            body=event.reason or event.message or "",
            link="/k8s-events",
            cluster_id=event.cluster_id,  # 바인딩된 클러스터면 볼 수 있는 사용자에게만(D-101)
        )
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
    scope: ClusterScope = Depends(get_cluster_scope),
) -> K8sEventListResponse:
    q = scope.apply(db.query(K8sEvent), K8sEvent.cluster_id, nullable=True).order_by(desc(K8sEvent.received_at))
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
def get_k8s_event(event_id: UUID, db: Session = Depends(get_db),
                  scope: ClusterScope = Depends(get_cluster_scope)) -> K8sEventOut:
    event = db.query(K8sEvent).filter(K8sEvent.id == event_id).first()
    if not event or not scope.visible(event.cluster_id):
        raise HTTPException(status_code=404, detail="Event not found")
    return event


def _load_visible_event(db: Session, event_id: UUID, scope: ClusterScope) -> K8sEvent:
    """보이지 않는(다른 테넌트 클러스터) 이벤트는 존재 자체를 숨긴다 — 404."""
    event = db.query(K8sEvent).filter(K8sEvent.id == event_id).first()
    if not event or not scope.visible(event.cluster_id):
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@router.delete("/{event_id}", status_code=204)
def delete_k8s_event(
    event_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """이벤트 삭제 — operator 이상 + 이벤트 클러스터 operate 권한(D-102)."""
    event = _load_visible_event(db, event_id, scope)
    require_cluster_access(db, user, event.cluster_id, "operate")
    db.delete(event)
    db.commit()


@router.get("/{event_id}/analysis")
def get_k8s_event_analysis(
    event_id: UUID,
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """이벤트에 연결된 AI 분석 결과 조회 (최신 1건)."""
    from app.models.incident_analysis import IncidentAnalysis
    from app.schemas.observability import IncidentAnalysisOut

    _load_visible_event(db, event_id, scope)
    row = (
        db.query(IncidentAnalysis)
        .filter(IncidentAnalysis.k8s_event_id == event_id)
        .order_by(IncidentAnalysis.created_at.desc())
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="이 이벤트에 대한 AI 분석이 없습니다.")
    return {"data": IncidentAnalysisOut(
        id=row.id,
        alert_event_id=row.alert_event_id,
        k8s_event_id=row.k8s_event_id,
        cluster_id=row.cluster_id,
        namespace=row.namespace,
        resource=row.resource,
        trigger=row.trigger,
        status=row.status,
        severity=row.severity,
        root_cause=row.root_cause,
        suggested_actions=list(row.suggested_actions or []),
        related_runbooks=list(row.related_runbooks or []),
        confidence=row.confidence,
        citations=list(row.citations or []),
        analyzed_by=row.analyzed_by,
        matched_rule_id=row.matched_rule_id,
        duration_ms=row.duration_ms,
        error=row.error,
        created_at=row.created_at,
        finished_at=row.finished_at,
    )}


@router.post("/{event_id}/analyze")
def trigger_k8s_event_analysis(
    event_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """수동 AI 분석 실행 — scope 규칙과 무관하게 즉시 llm 큐로 보낸다 (operator+, 클러스터 operate)."""
    event = _load_visible_event(db, event_id, scope)
    require_cluster_access(db, user, event.cluster_id, "operate")
    if event.analysis_status in ("queued", "running"):
        return {"ok": True, "status": event.analysis_status, "detail": "이미 분석이 진행 중입니다."}
    try:
        from app.celery_app import run_auto_incident_analysis_k8s_event
        run_auto_incident_analysis_k8s_event.apply_async(args=[str(event.id)], queue="llm")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"분석 큐잉 실패: {e}")
    event.analysis_status = "queued"
    db.commit()
    return {"ok": True, "status": "queued"}
