"""ClusterItem 수집/관리 서비스.

현황 관리 대시보드의 '아이템' 카드 결과를 수집한다. 아이템 타입별 collector 를
ITEM_TYPES 레지스트리로 관리한다. 수집은 fail-safe — k8s/LLM 연결 실패나 예외가
나도 raise 하지 않고 item 의 last_status='error' + last_error 에 사유를 기록한다.

지원 타입
  · node_count         K8s 노드 수 (기본/builtin)
  · workload_count     파드 수(+ 네임스페이스 수)
  · k8s_version        K8s 서버 버전 (+ 노드 버전 skew 감지)
  · cert_expiry        API 서버 인증서 만료까지 남은 일수
  · ai_cluster_summary AI 클러스터 상태 요약 (Ollama LLM, 폐쇄망)
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import ssl
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional
from urllib.parse import urlparse

from kubernetes import client, config
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Cluster
from app.models.cluster_item import ClusterItem
from app.services.checkers.node_checker import NodeChecker
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

_TIMEOUT = getattr(settings, "check_timeout_seconds", 30) or 30


@dataclass
class ItemResult:
    """collector 반환값. value(수치) 또는 text(문자) 중 해당하는 것을 채운다."""
    value: Optional[float] = None
    text: Optional[str] = None
    status: Optional[str] = None   # healthy | warning | critical | info
    detail: dict = field(default_factory=dict)
    error: Optional[str] = None


# ── K8s client helper ──────────────────────────────────────
def _k8s(cluster: Cluster) -> tuple[client.CoreV1Api, client.VersionApi]:
    """클러스터별 K8s 클라이언트. BaseChecker._get_k8s_client 와 동일 로직."""
    kc_path = ensure_kubeconfig_file(cluster)
    if kc_path and os.path.exists(kc_path):
        config.load_kube_config(config_file=kc_path)
    else:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
    return client.CoreV1Api(), client.VersionApi()


# ── Collectors ─────────────────────────────────────────────
def _collect_node_count(item: ClusterItem, db: Session) -> ItemResult:
    result = NodeChecker(item.cluster, addon=None).check()
    d = result.details or {}
    total = d.get("total")
    not_ready = d.get("not_ready") or []
    return ItemResult(
        value=float(total) if total is not None else None,
        status="warning" if not_ready else "healthy",
        detail={"total": total, "ready": d.get("ready"), "not_ready": not_ready[:20]},
    )


def _collect_workload_count(item: ClusterItem, db: Session) -> ItemResult:
    core, _ = _k8s(item.cluster)
    ns = core.list_namespace(timeout_seconds=_TIMEOUT)
    ns_count = len(ns.items)
    pods = core.list_pod_for_all_namespaces(timeout_seconds=_TIMEOUT)
    pod_count = len(pods.items)
    running = sum(1 for p in pods.items if p.status and p.status.phase == "Running")
    pending = sum(1 for p in pods.items if p.status and p.status.phase == "Pending")
    failed = sum(1 for p in pods.items if p.status and p.status.phase == "Failed")
    return ItemResult(
        value=float(pod_count),
        status="warning" if (pending or failed) else "healthy",
        detail={
            "pods": pod_count,
            "namespaces": ns_count,
            "running": running,
            "pending": pending,
            "failed": failed,
        },
    )


def _collect_k8s_version(item: ClusterItem, db: Session) -> ItemResult:
    core, ver = _k8s(item.cluster)
    code = ver.get_code()
    server = getattr(code, "git_version", None) or "unknown"
    node_versions: dict[str, int] = {}
    try:
        nodes = core.list_node(timeout_seconds=_TIMEOUT)
        for n in nodes.items:
            info = n.status.node_info if (n.status and n.status.node_info) else None
            kv = getattr(info, "kubelet_version", None) if info else None
            if kv:
                node_versions[kv] = node_versions.get(kv, 0) + 1
    except Exception:  # noqa: BLE001 — 노드 버전 수집 실패해도 서버 버전은 반환
        pass
    skew = len(node_versions) > 1
    return ItemResult(
        text=server,
        status="warning" if skew else "healthy",
        detail={"server": server, "nodeVersions": node_versions, "skew": skew},
    )


def _collect_cert_expiry(item: ClusterItem, db: Session) -> ItemResult:
    """API 서버가 제공하는 TLS 인증서의 만료까지 남은 일수 (자체서명 검증 생략)."""
    endpoint = (item.cluster.api_endpoint or "").strip()
    if not endpoint:
        return ItemResult(error="api_endpoint 가 비어 있습니다", status="info")
    parsed = urlparse(endpoint if "://" in endpoint else f"https://{endpoint}")
    host = parsed.hostname
    port = parsed.port or 6443
    if not host:
        return ItemResult(error=f"endpoint 파싱 실패: {endpoint}", status="info")

    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=_TIMEOUT) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                der = ssock.getpeercert(binary_form=True)
        if not der:
            return ItemResult(error="인증서를 가져오지 못했습니다", status="info")
        not_after, subject = _parse_cert_not_after(der)
    except Exception as e:  # noqa: BLE001
        return ItemResult(error=f"{host}:{port} 인증서 조회 실패 — {str(e)[:160]}", status="info")

    now = datetime.now(timezone.utc)
    days = (not_after - now).days
    if days < 14:
        status = "critical"
    elif days < 30:
        status = "warning"
    else:
        status = "healthy"
    return ItemResult(
        value=float(days),
        status=status,
        detail={
            "host": f"{host}:{port}",
            "not_after": not_after.isoformat(),
            "subject": subject,
        },
    )


def _parse_cert_not_after(der: bytes) -> tuple[datetime, str]:
    """DER 인증서에서 notAfter(aware UTC) 와 subject 를 추출.

    cryptography 는 kubernetes SDK 의 전이 의존성으로 항상 설치돼 있다.
    """
    from cryptography import x509  # type: ignore

    cert = x509.load_der_x509_certificate(der)
    not_after = getattr(cert, "not_valid_after_utc", None)
    if not_after is None:  # cryptography < 42
        not_after = cert.not_valid_after.replace(tzinfo=timezone.utc)
    try:
        subject = cert.subject.rfc4514_string()
    except Exception:  # noqa: BLE001
        subject = ""
    return not_after, subject


def _collect_ai_summary(item: ClusterItem, db: Session) -> ItemResult:
    """Ollama LLM 으로 클러스터 상태를 한국어로 요약 + 위험도 산출 (폐쇄망)."""
    from app.models import DailyCheckLog
    from app.services.agent_service import agent_service

    cluster = item.cluster
    log = (
        db.query(DailyCheckLog)
        .filter(DailyCheckLog.cluster_id == cluster.id)
        .order_by(DailyCheckLog.checked_at.desc())
        .first()
    )

    context: dict = {
        "cluster_name": cluster.name,
        "cluster_status": getattr(cluster.status, "value", str(cluster.status)),
    }
    if log is not None:
        context["node_status"] = f"{log.ready_nodes}/{log.total_nodes} Ready"
        if log.error_messages:
            context["error_messages"] = log.error_messages
        context["extra"] = (
            f"overall={getattr(log.overall_status, 'value', log.overall_status)}, "
            f"api_server={getattr(log.api_server_status, 'value', log.api_server_status)}, "
            f"checked_at={log.checked_at}"
        )
    else:
        context["extra"] = "최근 일일점검 기록 없음 (수동 점검을 먼저 실행하세요)"

    query = (
        "위 Kubernetes 클러스터의 현재 상태를 운영자 관점에서 한국어 1~2문장으로 간결히 요약하세요. "
        "마지막 줄에 반드시 'RISK: healthy' 또는 'RISK: warning' 또는 'RISK: critical' 형식으로 "
        "위험도를 한 개만 출력하세요."
    )

    try:
        res = asyncio.run(agent_service.ask_agent(query, context))
    except RuntimeError:
        # 이미 이벤트 루프가 도는 컨텍스트일 경우 (대비) — 별도 루프 사용.
        loop = asyncio.new_event_loop()
        try:
            res = loop.run_until_complete(agent_service.ask_agent(query, context))
        finally:
            loop.close()

    if res.get("status") != "ok":
        # LLM 미가용 — 카드에 에러로 표기하되 대시보드는 영향 없음.
        return ItemResult(
            error=f"LLM 미가용: {str(res.get('answer', '')).strip()[:200]}",
            status="info",
            detail={"model": res.get("model", "")},
        )

    answer = (res.get("answer") or "").strip()
    risk = "info"
    summary_lines: list[str] = []
    for line in answer.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("RISK:") or upper.startswith("RISK :"):
            token = upper.split(":", 1)[1].strip().lower()
            if token.startswith("critical"):
                risk = "critical"
            elif token.startswith("warning"):
                risk = "warning"
            elif token.startswith("healthy"):
                risk = "healthy"
            continue
        if stripped:
            summary_lines.append(stripped)
    summary = " ".join(summary_lines).strip()[:400] or answer[:400]
    return ItemResult(
        text=summary,
        status=risk,
        detail={"model": res.get("model", ""), "raw": answer[:1500]},
    )


# ── Item type registry ─────────────────────────────────────
@dataclass
class ItemTypeSpec:
    item_type: str
    label: str
    icon: str
    unit: str
    description: str
    value_kind: str                # "number" | "text"
    collector: Callable[[ClusterItem, Session], ItemResult]
    default_source: str = "auto"   # manual | auto | ai
    default_schedule_hour: int = 1
    builtin: bool = False


ITEM_TYPES: dict[str, ItemTypeSpec] = {
    "node_count": ItemTypeSpec(
        item_type="node_count",
        label="K8s 노드 수",
        icon="🖥️",
        unit="대",
        description="클러스터 전체 노드 수 (기본 아이템)",
        value_kind="number",
        collector=_collect_node_count,
        default_schedule_hour=1,
        builtin=True,
    ),
    "workload_count": ItemTypeSpec(
        item_type="workload_count",
        label="파드 / 네임스페이스 수",
        icon="📦",
        unit="개",
        description="전체 Pod 수 (+ 네임스페이스 수, Pending/Failed 감지)",
        value_kind="number",
        collector=_collect_workload_count,
        default_schedule_hour=1,
    ),
    "k8s_version": ItemTypeSpec(
        item_type="k8s_version",
        label="K8s 버전",
        icon="🏷️",
        unit="",
        description="API 서버 버전 (+ 노드 kubelet 버전 skew 감지)",
        value_kind="text",
        collector=_collect_k8s_version,
        default_schedule_hour=2,
    ),
    "cert_expiry": ItemTypeSpec(
        item_type="cert_expiry",
        label="인증서 만료 임박",
        icon="🔐",
        unit="일",
        description="API 서버 TLS 인증서 만료까지 남은 일수 (30일↓ 경고, 14일↓ 위험)",
        value_kind="number",
        collector=_collect_cert_expiry,
        default_schedule_hour=2,
    ),
    "ai_cluster_summary": ItemTypeSpec(
        item_type="ai_cluster_summary",
        label="AI 클러스터 상태 요약",
        icon="🤖",
        unit="",
        description="Ollama LLM 으로 최근 점검 데이터를 요약 + 위험도 산출 (폐쇄망)",
        value_kind="text",
        collector=_collect_ai_summary,
        default_source="ai",
        default_schedule_hour=6,
    ),
}


def list_item_types() -> list[dict]:
    """프론트 '아이템 추가' 선택지용 메타데이터."""
    out: list[dict] = []
    for spec in ITEM_TYPES.values():
        sources = ["manual", "auto"]
        if spec.default_source == "ai":
            sources = ["ai", "manual"]
        out.append({
            "item_type": spec.item_type,
            "label": spec.label,
            "icon": spec.icon,
            "unit": spec.unit,
            "description": spec.description,
            "value_kind": spec.value_kind,
            "default_source": spec.default_source,
            "default_schedule_hour": spec.default_schedule_hour,
            "builtin": spec.builtin,
            "supported_sources": sources,
        })
    return out


# 클러스터마다 보장되는 기본(builtin) 아이템.
BUILTIN_ITEM_DEFS: list[dict] = [
    {
        "item_type": "node_count",
        "title": "K8s 노드 수",
        "icon": "🖥️",
        "description": "클러스터 전체 노드 수 (기본: 매일 새벽 1시 자동 점검, 수동 실행 가능)",
        "tier": "basic",
        "is_builtin": True,
        "source_mode": "auto",
        "auto_enabled": True,
        "schedule_hour": 1,
        "schedule_minute": 0,
        "card_size": "md",
        "unit": "대",
        "sort_order": 0,
    },
]


def ensure_builtin_items(db: Session, cluster: Cluster) -> list[ClusterItem]:
    """클러스터에 누락된 기본 아이템을 생성한다 (idempotent)."""
    existing = {
        i.item_type
        for i in db.query(ClusterItem)
        .filter(ClusterItem.cluster_id == cluster.id, ClusterItem.is_builtin.is_(True))
        .all()
    }
    created: list[ClusterItem] = []
    for d in BUILTIN_ITEM_DEFS:
        if d["item_type"] in existing:
            continue
        item = ClusterItem(cluster_id=cluster.id, **d)
        db.add(item)
        created.append(item)
    if created:
        db.commit()
        for item in created:
            db.refresh(item)
    return created


def run_item(db: Session, item: ClusterItem, source: str = "manual") -> ClusterItem:
    """아이템을 1회 수집하고 변경 추적을 반영한 뒤 커밋한다.

    source: manual | auto | ai — 결과를 어떤 방식으로 얻었는지 기록.
    """
    spec = ITEM_TYPES.get(item.item_type)
    now = datetime.utcnow()

    if spec is None:
        res = ItemResult(error=f"지원하지 않는 아이템 타입: {item.item_type}")
    else:
        try:
            res = spec.collector(item, db)
        except Exception as e:  # noqa: BLE001 — 수집 예외는 fail-safe 로 기록
            res = ItemResult(error=str(e)[:300])

    item.last_checked_at = now
    item.last_source = source

    if res.error is not None:
        item.last_status = "error"
        item.last_error = res.error
        if res.status:
            item.result_status = res.status
    else:
        item.last_status = "ok"
        item.last_error = None
        item.result_detail = res.detail or {}
        item.result_status = res.status

        changed = False
        if res.text is not None:
            if item.current_text is None:
                changed = True
            elif res.text != item.current_text:
                item.previous_text = item.current_text
                changed = True
            item.current_text = res.text
        if res.value is not None:
            if item.current_value is None:
                changed = True
            elif res.value != item.current_value:
                item.previous_value = item.current_value
                changed = True
            item.current_value = res.value
        if changed:
            item.last_changed_at = now

    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def run_due_auto_items(db: Session, hour: int) -> list[dict]:
    """현재 시(KST)와 schedule_hour 가 일치하는 자동/AI 아이템을 수집."""
    items = (
        db.query(ClusterItem)
        .filter(ClusterItem.enabled.is_(True))
        .filter(ClusterItem.auto_enabled.is_(True))
        .filter(ClusterItem.source_mode.in_(["auto", "ai"]))
        .filter(ClusterItem.schedule_hour == hour)
        .all()
    )
    results: list[dict] = []
    for item in items:
        source = "ai" if item.source_mode == "ai" else "auto"
        try:
            run_item(db, item, source=source)
            results.append({"item_id": str(item.id), "value": item.current_value, "text": item.current_text})
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.exception("auto cluster item collection failed (%s): %s", item.id, e)
            results.append({"item_id": str(item.id), "error": str(e)[:200]})
    return results
