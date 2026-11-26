"""알람 등록 요청 — 상태 전이·카탈로그 시드·응답 직렬화·알림.

상태: requested(요청됨) → reviewing(검토 중) → approved(승인) → applied(반영 완료), 어느 단계에서든
rejected(반려, 사유 필수). applied/rejected 는 끝 상태다. 요청자는 requested 인 동안만 수정·취소한다.

「반영 완료」는 관리자가 PrometheusRule 등 실제 알람 규칙에 반영한 뒤 표시하는 처리 기록이다 — 이 모듈은
클러스터에 아무 명령도 보내지 않는다. 대신 반영 완료된 수정 임계치를 카탈로그 기본 임계치로 올려
다음 요청의 「기본 임계치」가 현재 운영 값이 되게 한다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.alarm_request import AlarmCatalogItem, AlarmRequest
from app.models.cluster import Cluster
from app.models.user import User

_log = logging.getLogger(__name__)

DEFAULT_SERVICES = ["k8s", "cilium", "aistor", "cnpg", "keycloak", "nexus", "jenkins", "argocd"]

STATUSES = [
    {"key": "requested", "label": "요청됨"},
    {"key": "reviewing", "label": "검토 중"},
    {"key": "approved", "label": "승인"},
    {"key": "applied", "label": "반영 완료"},
    {"key": "rejected", "label": "반려"},
]
STATUS_LABEL = {s["key"]: s["label"] for s in STATUSES}
SEVERITIES = [
    {"key": "critical", "label": "Critical"},
    {"key": "warning", "label": "Warning"},
    {"key": "info", "label": "Info"},
]

# 관리자 처리 → 허용되는 현재 상태
TRANSITIONS: dict[str, set[str]] = {
    "reviewing": {"requested"},
    "approved": {"requested", "reviewing"},
    "rejected": {"requested", "reviewing", "approved"},
    "applied": {"approved"},
}
ACTION_LABEL = {
    "created": "요청 등록", "updated": "요청 수정",
    "reviewing": "검토 시작", "approved": "승인", "rejected": "반려", "applied": "반영 완료",
}


def code_of(req_id: int) -> str:
    return f"AR-{req_id:04d}"


def display_name(user: User) -> str:
    return (user.display_name or user.username or "").strip()


def is_staff(user: User) -> bool:
    role = "viewer" if user.role == "user" else user.role
    return role in ("admin", "operator")


# ── 카탈로그 시드 ─────────────────────────────────────────────────────────────
def _t(sev: str, expr: str, for_: str) -> dict[str, str]:
    return {"severity": sev, "expr": expr, "for": for_}


SEED_CATALOG: list[dict[str, Any]] = [
    {"service": "k8s", "metric_name": "KubeNodeNotReady",
     "meaning": "노드가 Ready 상태가 아님. kubelet·네트워크·리소스 고갈 의심",
     "thresholds": [_t("warning", 'kube_node_status_condition{condition="Ready",status="true"} == 0', "15m")]},
    {"service": "k8s", "metric_name": "KubePodCrashLooping", "meaning": "컨테이너가 반복 재시작 중",
     "thresholds": [_t("warning", 'max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}[5m]) >= 1', "15m")]},
    {"service": "k8s", "metric_name": "NodeFilesystemSpaceFillingUp", "meaning": "노드 파일시스템 여유 공간 부족",
     "thresholds": [_t("warning", "node_filesystem_avail_bytes / node_filesystem_size_bytes * 100 < 15", "30m"),
                    _t("critical", "node_filesystem_avail_bytes / node_filesystem_size_bytes * 100 < 5", "10m")]},
    {"service": "cilium", "metric_name": "CiliumAgentUnreachableNodes",
     "meaning": "Cilium 에이전트가 다른 노드에 도달하지 못함 — 파드 간 통신 장애 가능",
     "thresholds": [_t("warning", "sum by (node) (cilium_unreachable_nodes) > 0", "10m")]},
    {"service": "cilium", "metric_name": "CiliumBpfMapPressure",
     "meaning": "BPF 맵 사용률이 높아 신규 연결·정책 반영이 실패할 수 있음",
     "thresholds": [_t("warning", "cilium_bpf_map_pressure > 0.8", "10m"), _t("critical", "cilium_bpf_map_pressure > 0.95", "5m")]},
    {"service": "aistor", "metric_name": "AIStorDriveOffline",
     "meaning": "AIStor(MinIO) 드라이브가 오프라인 — 이레이저 코딩 여유 감소",
     "thresholds": [_t("critical", "minio_cluster_drive_offline_total > 0", "5m")]},
    {"service": "aistor", "metric_name": "AIStorCapacityUsage", "meaning": "클러스터 사용 용량이 임계치 초과",
     "thresholds": [_t("warning", "minio_cluster_capacity_usable_free_bytes / minio_cluster_capacity_usable_total_bytes < 0.2", "30m")]},
    {"service": "cnpg", "metric_name": "CNPGReplicationLag", "meaning": "CloudNativePG 스탠바이 복제 지연(초)",
     "thresholds": [_t("warning", "cnpg_pg_replication_lag > 30", "5m"), _t("critical", "cnpg_pg_replication_lag > 300", "5m")]},
    {"service": "cnpg", "metric_name": "CNPGConnectionsHigh", "meaning": "max_connections 대비 연결 수가 높음",
     "thresholds": [_t("warning", 'sum by (pod) (cnpg_backends_total) / on(pod) cnpg_pg_settings_setting{name="max_connections"} > 0.8', "10m")]},
    {"service": "keycloak", "metric_name": "KeycloakLoginFailureRate",
     "meaning": "로그인 실패 비율 급증 — 계정 대입 시도 또는 LDAP 연동 장애",
     "thresholds": [_t("warning", "sum(rate(keycloak_failed_login_attempts_total[5m])) / sum(rate(keycloak_logins_total[5m])) > 0.3", "10m")]},
    {"service": "nexus", "metric_name": "NexusBlobStoreUsage",
     "meaning": "Nexus blob store 사용량이 높음 — 이미지·패키지 업로드 실패 위험",
     "thresholds": [_t("warning", "nexus_blobstore_used_bytes / nexus_blobstore_total_bytes > 0.85", "30m")]},
    {"service": "jenkins", "metric_name": "JenkinsQueueTooLong", "meaning": "빌드 대기열이 길게 유지됨 — 에이전트 부족",
     "thresholds": [_t("warning", "jenkins_queue_size_value > 20", "15m")]},
    {"service": "argocd", "metric_name": "ArgoCDAppOutOfSync", "meaning": "애플리케이션이 Git 과 동기화되지 않은 상태가 지속",
     "thresholds": [_t("warning", 'argocd_app_info{sync_status="OutOfSync"} == 1', "30m")]},
    {"service": "argocd", "metric_name": "ArgoCDAppUnhealthy", "meaning": "애플리케이션 헬스가 Degraded",
     "thresholds": [_t("critical", 'argocd_app_info{health_status="Degraded"} == 1', "10m")]},
]


def seed_catalog(db: Session) -> int:
    """카탈로그가 비어 있을 때만 기본 항목을 넣는다(지운 항목은 되살리지 않는다)."""
    if db.query(AlarmCatalogItem.id).first() is not None:
        return 0
    for row in SEED_CATALOG:
        db.add(AlarmCatalogItem(**row, enabled=True, updated_by="system"))
    db.commit()
    return len(SEED_CATALOG)


def service_list(db: Session) -> list[str]:
    seen = list(DEFAULT_SERVICES)
    for (svc,) in db.query(AlarmCatalogItem.service).distinct().all():
        if svc and svc not in seen:
            seen.append(svc)
    return seen


def find_catalog_item(db: Session, service: str, metric_name: str) -> AlarmCatalogItem | None:
    return db.query(AlarmCatalogItem).filter(
        AlarmCatalogItem.service == service.strip(), AlarmCatalogItem.metric_name == metric_name.strip()).first()


def catalog_id_for(db: Session, service: str, metric_name: str) -> int | None:
    """요청이 가리키는 카탈로그 항목 id — 클라이언트가 보낸 id 대신 서버가 (서비스, 알람 항목)으로 정한다."""
    item = find_catalog_item(db, service, metric_name)
    return item.id if item else None


# ── 요청 검증·직렬화 ─────────────────────────────────────────────────────────
def resolve_clusters(db: Session, user: User, cluster_ids: list[str]) -> list[dict[str, str]]:
    """요청한 클러스터 id 를 실제 클러스터로 풀고(없으면 422) 사용자가 볼 수 있는지 확인한다(못 보면 403)."""
    from app.services.cluster_access import hidden_cluster_ids

    ids: list[uuid.UUID] = []
    for raw in dict.fromkeys(cluster_ids):
        try:
            ids.append(uuid.UUID(str(raw)))
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"클러스터 id 형식이 아닙니다: {raw}")
    rows = {c.id: c for c in db.query(Cluster).filter(Cluster.id.in_(ids)).all()}
    missing = [str(i) for i in ids if i not in rows]
    if missing:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"등록되지 않은 클러스터입니다: {', '.join(missing)}")
    hidden = hidden_cluster_ids(db, user)
    if any(i in hidden for i in ids):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="볼 수 없는 클러스터가 포함돼 있습니다.")
    return [{"id": str(i), "name": rows[i].name} for i in ids]


def normalize_thresholds(rows: list[Any]) -> list[dict[str, str]]:
    out = []
    for r in rows:
        d = r.model_dump() if hasattr(r, "model_dump") else dict(r)
        out.append({k: (d.get(k) or "").strip() for k in ("severity", "base_expr", "base_for", "new_expr", "new_for")})
    if not any(t["new_expr"] for t in out):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="수정 임계치 expr 을 한 행 이상 입력하세요.")
    sevs = [t["severity"] for t in out]
    if len(sevs) != len(set(sevs)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="같은 심각도 행이 두 번 있습니다.")
    return out


def add_history(req: AlarmRequest, actor: User, action: str, comment: str | None = None) -> None:
    entry = {"at": datetime.utcnow().isoformat(timespec="seconds"), "by": display_name(actor),
             "action": action, "comment": (comment or "").strip() or None}
    req.history = [*(req.history or []), entry]   # JSONB 변경 감지를 위해 새 리스트로 교체


def serialize(req: AlarmRequest, hidden: frozenset) -> dict[str, Any]:
    clusters = []
    for c in req.clusters or []:
        try:
            is_hidden = uuid.UUID(str(c.get("id"))) in hidden
        except ValueError:
            is_hidden = False
        clusters.append({"id": c.get("id"), "name": "숨겨진 클러스터" if is_hidden else c.get("name"), "hidden": is_hidden})
    return {
        "id": req.id, "code": code_of(req.id), "status": req.status, "service": req.service,
        "metric_name": req.metric_name, "meaning": req.meaning, "catalog_item_id": req.catalog_item_id,
        "thresholds": req.thresholds or [], "clusters": clusters, "note": req.note,
        "requested_by": req.requested_by, "requester_name": req.requester_name,
        "review_comment": req.review_comment, "reviewed_by": req.reviewed_by, "reviewed_at": req.reviewed_at,
        "applied_at": req.applied_at, "history": req.history or [],
        "created_at": req.created_at, "updated_at": req.updated_at,
    }


# ── 관리자 처리 ──────────────────────────────────────────────────────────────
def apply_action(db: Session, req: AlarmRequest, actor: User, action: str, comment: str | None) -> None:
    allowed = TRANSITIONS.get(action, set())
    if req.status not in allowed:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f"'{STATUS_LABEL.get(req.status, req.status)}' 상태에서는 {ACTION_LABEL[action]} 할 수 없습니다.",
        )
    comment = (comment or "").strip() or None
    if action == "rejected" and not comment:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="반려 사유를 입력하세요.")
    now = datetime.utcnow()
    req.status = action
    req.reviewed_by = display_name(actor)
    req.reviewed_at = now
    if comment:
        req.review_comment = comment
    if action == "applied":
        req.applied_at = now
        promote_to_catalog(db, req, actor)
    add_history(req, actor, action, comment)


def promote_to_catalog(db: Session, req: AlarmRequest, actor: User) -> AlarmCatalogItem:
    """반영 완료된 요청의 수정 임계치(비어 있으면 기본값)를 카탈로그 기본 임계치로 올린다."""
    # 요청의 catalog_item_id 는 믿지 않는다 — 항상 (서비스, 알람 항목)으로 찾는다. 다른 항목 id 가 들어와도
    # 그 항목의 임계치를 덮어쓰지 않게.
    item = find_catalog_item(db, req.service, req.metric_name)
    thresholds = []
    for t in req.thresholds or []:
        expr = t.get("new_expr") or t.get("base_expr")
        if expr:
            thresholds.append({"severity": t.get("severity"), "expr": expr, "for": t.get("new_for") or t.get("base_for") or ""})
    if item is None:
        item = AlarmCatalogItem(service=req.service, metric_name=req.metric_name, meaning=req.meaning, enabled=True)
        db.add(item)
    item.thresholds = thresholds
    if not item.meaning:
        item.meaning = req.meaning
    item.updated_by = display_name(actor)
    db.flush()
    req.catalog_item_id = item.id
    return item


# ── 알림 ─────────────────────────────────────────────────────────────────────
def link_of(req: AlarmRequest) -> str:
    return f"/alarm-requests?id={req.id}"


def notify_created(db: Session, req: AlarmRequest) -> None:
    """새 요청 → 관리자(admin·operator)에게. 실패해도 요청 등록은 유지한다."""
    from app.services.user_notify import notify_broadcast

    try:
        notify_broadcast(
            db, type="alarm_request", roles=("admin", "operator"),
            title=f"알람 등록 요청 {code_of(req.id)} — {req.metric_name}",
            body=f"{req.requester_name or req.requested_by} · {req.service} · 클러스터 {len(req.clusters or [])}개",
            link=link_of(req),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        _log.warning("alarm_request: 관리자 알림 실패 id=%s", req.id, exc_info=True)


def notify_status(db: Session, req: AlarmRequest, actor: User) -> None:
    """처리 결과 → 요청자에게(본인 처리는 제외)."""
    from app.services.user_notify import notify_names

    try:
        body = req.review_comment if req.status == "rejected" else ""
        notify_names(
            db, [req.requested_by], exclude_user_ids=[actor.id], type="alarm_request_status",
            title=f"{code_of(req.id)} {req.metric_name} — {STATUS_LABEL.get(req.status, req.status)}",
            body=body or "", link=link_of(req),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        _log.warning("alarm_request: 요청자 알림 실패 id=%s", req.id, exc_info=True)
