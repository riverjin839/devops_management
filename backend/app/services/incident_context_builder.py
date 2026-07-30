"""알람(AlertEvent) → 분석기 입력(IncidentContext) 조립 — 자동 분석 경로 전용.

원칙 (docs/AIRGAP_LLM_ARCHITECTURE.md §0):
- **read-only** — 알람 필드 + DB 에 이미 수신된 K8s 이벤트가 기본 재료다.
- 파드 로그 수집은 규칙별 ``include_logs`` opt-in 일 때만, get/list 권한의
  read API 로만 수행한다 (실패해도 분석은 로그 없이 계속 — fail-safe).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.alert_event import AlertEvent
from app.services.analyzers.base import IncidentContext, KubeEvent

logger = logging.getLogger(__name__)

_MAX_EVENTS = 10
_MAX_LOG_CHARS = 8000


def _recent_k8s_events(db: Session, event: AlertEvent) -> list[KubeEvent]:
    """같은 클러스터/네임스페이스의 최근 수신 K8s 이벤트 (DB 조회 — 클러스터 호출 없음)."""
    try:
        from app.models.k8s_event import K8sEvent
        q = db.query(K8sEvent).filter(K8sEvent.cluster_id == event.cluster_id)
        if event.namespace:
            q = q.filter(K8sEvent.namespace == event.namespace)
        rows = q.order_by(K8sEvent.received_at.desc()).limit(_MAX_EVENTS).all()
        return [
            KubeEvent(
                reason=r.reason or "",
                message=(r.message or "")[:500],
                count=1,
                first_time=str(r.received_at or ""),
                last_time=str(r.received_at or ""),
                type="Warning" if (r.severity in ("warning", "critical")) else "Normal",
            )
            for r in rows
        ]
    except Exception as exc:  # noqa: BLE001
        logger.debug("K8s 이벤트 조회 실패 — 이벤트 없이 진행: %s", exc)
        return []


def _fetch_pod_logs(db: Session, event: AlertEvent) -> Optional[str]:
    """규칙 opt-in 시에만 — resource 가 파드로 보이면 현재 로그 tail 을 읽는다 (read-only)."""
    if not (event.namespace and event.resource):
        return None
    try:
        from kubernetes import client as k8s_client, config as k8s_config

        from app.models import Cluster
        from app.services.kubeconfig import ensure_kubeconfig_file

        cluster = db.query(Cluster).filter(Cluster.id == event.cluster_id).first()
        if cluster is None:
            return None
        kc_path = ensure_kubeconfig_file(cluster)
        if not kc_path:
            return None
        k8s_config.load_kube_config(config_file=kc_path)
        core = k8s_client.CoreV1Api()
        logs = core.read_namespaced_pod_log(
            name=event.resource, namespace=event.namespace,
            tail_lines=200, _request_timeout=15,
        )
        return (logs or "")[-_MAX_LOG_CHARS:]
    except Exception as exc:  # noqa: BLE001
        logger.debug("파드 로그 수집 실패 — 로그 없이 진행: %s", exc)
        return None


def build_context_from_alert(
    db: Session, event: AlertEvent, *, include_logs: bool = False
) -> IncidentContext:
    """AlertEvent 를 분석기 입력으로 변환한다. 절대 raise 하지 않는다."""
    describe_parts: list[str] = [
        f"Alert: {event.alertname} (severity={event.severity}, status={event.status})",
    ]
    if event.summary:
        describe_parts.append(f"Summary: {event.summary}")
    if event.description:
        describe_parts.append(f"Description: {event.description[:1000]}")
    if event.labels:
        labels = ", ".join(f"{k}={v}" for k, v in list(event.labels.items())[:20])
        describe_parts.append(f"Labels: {labels}")
    if event.occurrences and event.occurrences > 1:
        describe_parts.append(f"동일 알람 반복 수신: {event.occurrences}회")

    current_logs = ""
    if include_logs:
        current_logs = _fetch_pod_logs(db, event) or ""

    return IncidentContext(
        pod_name=event.resource or event.alertname or "unknown",
        namespace=event.namespace or "",
        timestamp=str(event.starts_at or datetime.now(timezone.utc).isoformat()),
        events=_recent_k8s_events(db, event),
        current_logs=current_logs,
        describe_output="\n".join(describe_parts),
    )
