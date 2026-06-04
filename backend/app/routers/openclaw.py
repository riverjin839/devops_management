"""
OpenClaw router — webhook receiver and status/history endpoints.

POST /openclaw/webhook   ← OpenClaw agent sends alerts here
GET  /openclaw/status    ← integration health check
GET  /openclaw/alerts    ← recent alert history
"""

import logging
import time
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.openclaw_alert_service import openclaw_alert_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/openclaw", tags=["openclaw"])

# 이슈→자동 재점검: 같은 클러스터 재트리거 쿨다운(초) — alert 폭주 시 점검 폭주 방지.
_RECHECK_COOLDOWN_SEC = 300
_last_recheck: dict[str, float] = {}


def _resolve_cluster_id(cluster_id: Optional[str], cluster_name: Optional[str]) -> Optional[str]:
    """alert 를 클러스터로 매핑 — id > name > (단일 클러스터면 그 클러스터)."""
    from app.database import SessionLocal
    from app.models import Cluster

    db = SessionLocal()
    try:
        if cluster_id:
            c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
            if c:
                return str(c.id)
        if cluster_name:
            c = db.query(Cluster).filter(Cluster.name == cluster_name).first()
            if c:
                return str(c.id)
        rows = db.query(Cluster).limit(2).all()
        if len(rows) == 1:
            return str(rows[0].id)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("auto-recheck: cluster 매핑 실패: %s", e)
        return None
    finally:
        db.close()


def _maybe_trigger_recheck(severity: str, cluster_id: Optional[str], cluster_name: Optional[str]) -> bool:
    """critical/warning alert 이고 클러스터가 매핑되며 쿨다운 밖이면 일일 점검을 enqueue."""
    if severity not in ("critical", "warning"):
        return False
    cid = _resolve_cluster_id(cluster_id, cluster_name)
    if not cid:
        return False
    now = time.time()
    if now - _last_recheck.get(cid, 0.0) < _RECHECK_COOLDOWN_SEC:
        return False
    _last_recheck[cid] = now
    try:
        from app.celery_app import run_scheduled_single_check
        run_scheduled_single_check.delay(cid, "manual")
        logger.info("auto-recheck: cluster %s 점검 enqueue (alert severity=%s)", cid, severity)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("auto-recheck: enqueue 실패 (Celery?) — %s", e)
        return False


# ── Schemas ──────────────────────────────────────────────────────────

class AlertWebhookRequest(BaseModel):
    severity: str = Field(default="warning", description="critical | warning | info")
    pod_name: str = Field(..., min_length=1, description="Affected pod name")
    namespace: str = Field(default="default", description="K8s namespace")
    reason: str = Field(default="", description="K8s event reason")
    message: str = Field(default="", description="Human-readable alert message")
    timestamp: Optional[str] = Field(default=None, description="ISO 8601 timestamp")
    # 이슈→자동 재점검용 — agent 가 보내주면 해당 클러스터를 자동 점검. 미지정 시 단일 클러스터면 자동.
    cluster_id: Optional[str] = Field(default=None, description="대상 클러스터 id (선택)")
    cluster_name: Optional[str] = Field(default=None, description="대상 클러스터 이름 (선택)")


class AlertWebhookResponse(BaseModel):
    status: str = Field(..., description="dispatched | no_channel")
    channels: list[str] = Field(default_factory=list, description="Channels that received the alert")
    ai_enriched: bool = Field(default=False, description="Whether AI suggestion was added")
    recheck_triggered: bool = Field(default=False, description="이슈 발생으로 자동 점검을 트리거했는지")


class OpenClawStatusResponse(BaseModel):
    enabled: bool
    channels: dict
    recent_alert_count: int


class AlertRecord(BaseModel):
    severity: str
    pod_name: str
    namespace: str
    reason: str
    message: str
    ai_suggestion: str = ""
    timestamp: str
    dispatched: dict


# ── Endpoints ────────────────────────────────────────────────────────

@router.post("/webhook", response_model=AlertWebhookResponse)
async def receive_alert(body: AlertWebhookRequest):
    """
    Webhook endpoint for OpenClaw agent.
    Receives K8s error alerts and dispatches to Telegram/Slack.
    """
    result = await openclaw_alert_service.process_alert(body.model_dump())
    # 이슈 발생 시 해당 클러스터 일일 점검 자동 트리거(쿨다운·fail-safe). webhook 응답은 막지 않음.
    recheck = False
    try:
        recheck = _maybe_trigger_recheck(body.severity, body.cluster_id, body.cluster_name)
    except Exception as e:  # noqa: BLE001
        logger.warning("auto-recheck 처리 중 오류 무시: %s", e)
    return AlertWebhookResponse(**result, recheck_triggered=recheck)


@router.get("/status", response_model=OpenClawStatusResponse)
async def openclaw_status():
    """Check OpenClaw integration status and configured channels."""
    return OpenClawStatusResponse(**openclaw_alert_service.get_status())


@router.get("/alerts", response_model=list[AlertRecord])
async def recent_alerts(limit: int = 20):
    """Retrieve recent alerts processed through OpenClaw."""
    data = openclaw_alert_service.get_recent_alerts(limit=limit)
    return [AlertRecord(**a) for a in data]
