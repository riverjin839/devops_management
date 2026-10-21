"""
Incident analysis router — POST /analyze/incident

Accepts a pod incident context and returns an LLM-generated (or rule-based) analysis.
Backend is selected at runtime via the ANALYZER_BACKEND environment variable.

Adds cluster/namespace/pod browsing endpoints so the UI can drill down from a
selected cluster instead of forcing the user to paste pod info manually.
"""

import fnmatch
import json
import logging
import math
import os
import queue
import re
import threading
import time
import weakref
from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from kubernetes import client as k8s_client, watch as k8s_watch
from kubernetes.client.exceptions import ApiException
from pydantic import BaseModel, Field
from urllib3.exceptions import ProtocolError, ReadTimeoutError
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.config import settings
from app.database import get_db
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.cluster_access import require_cluster_access
from app.services.llm.service import llm_tenant_context
from app.services.tenant_scope import resolve_llm_tenant
from app.services.analyzers import (
    AnalysisResult,
    ArgocdStatus,
    IncidentContext,
    KubeEvent,
    RelatedWorkload,
    get_analyzer,
)
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.k8s_client_pool import get_api_client_for_path

logger = logging.getLogger(__name__)

# ── 로그/이벤트 SSE 스트림 동시 한도 (D-182) ─────────────────────────────
# kubernetes SDK 는 blocking urllib3 라 스트림 하나가 K8s 연결 하나와 스레드 하나를 쓴다.
# 사용자당 3 + 프로세스 전체 `log_stream_max_concurrent`(기본 20) 로 묶는다 — 한 사람이
# 스트림을 여러 번 열어 다른 운영자 전원이 429 를 받는 일을 막는다. 초과는 대기 없이 즉시 429.
# 슬롯 반환은 generator `finally` + 시작 전 끊김(generator 미시작 GC)의 `weakref.finalize`
# 두 경로로 보장하고, 반환은 멱등이다. (프로세스 단위 한도 — replica·worker 마다 따로 센다.)
_LOG_STREAM_PER_USER = 3


class _StreamSlot:
    """한도 슬롯 1개. `release()` 는 몇 번 불려도 한 번만 반환한다."""

    __slots__ = ("_limiter", "_user_key", "_released", "_lock", "__weakref__")

    def __init__(self, limiter: "_StreamLimiter", user_key: str):
        self._limiter = limiter
        self._user_key = user_key
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._limiter._release(self._user_key)


class _StreamLimiter:
    def __init__(self, per_user: int, total: int):
        self.per_user = max(1, int(per_user))
        self.total = max(1, int(total))
        self._lock = threading.Lock()
        self._count = 0
        self._by_user: dict[str, int] = {}

    def try_acquire(self, user_key: str) -> Optional[_StreamSlot]:
        with self._lock:
            if self._count >= self.total or self._by_user.get(user_key, 0) >= self.per_user:
                return None
            self._count += 1
            self._by_user[user_key] = self._by_user.get(user_key, 0) + 1
        return _StreamSlot(self, user_key)

    def _release(self, user_key: str) -> None:
        with self._lock:
            self._count = max(0, self._count - 1)
            left = self._by_user.get(user_key, 0) - 1
            if left > 0:
                self._by_user[user_key] = left
            else:
                self._by_user.pop(user_key, None)

    def in_use(self, user_key: Optional[str] = None) -> int:
        with self._lock:
            return self._count if user_key is None else self._by_user.get(user_key, 0)


_stream_limiter = _StreamLimiter(_LOG_STREAM_PER_USER, settings.log_stream_max_concurrent)

_K8S_TIMEOUT = 15
# 큰 클러스터(수천 namespace · 수만 pod) 대비 — 무거운 list 호출은 별도 타임아웃.
_K8S_NS_LIST_TIMEOUT = 30
_K8S_POD_LIST_TIMEOUT = 90
# K8s API 페이지네이션 한 번에 가져올 항목 수.
_K8S_LIST_PAGE = 500
_K8S_POD_LIST_PAGE = 1000

router = APIRouter(prefix="/analyze", tags=["analyze"])


def _get_core_v1(cluster: Cluster) -> k8s_client.CoreV1Api:
    """클러스터 kubeconfig 로 CoreV1Api 클라이언트 생성."""
    kc_path = ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(
            status_code=422,
            detail="kubeconfig 가 등록되지 않은 클러스터입니다. 먼저 kubeconfig 를 등록하세요.",
        )
    try:
        api_client = get_api_client_for_path(kc_path)
        return k8s_client.CoreV1Api(api_client)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"kubeconfig 로드 실패: {str(e)[:200]}") from e


def _require_cluster(cluster_id: UUID, db: Session) -> Cluster:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return cluster


# ── Request schemas ───────────────────────────────────────────────────

class KubeEventSchema(BaseModel):
    reason: str
    message: str
    count: int = 1
    first_time: str = ""
    last_time: str = ""
    type: str = "Normal"


class RelatedWorkloadSchema(BaseModel):
    kind: str
    name: str
    status: str


class ArgocdStatusSchema(BaseModel):
    app: str
    sync_status: str
    last_sync_at: str


# 분석 입력 상한 — 수 MB 로그를 그대로 붙여넣어 워커 메모리·LLM 토큰을 태우지 않게(D-114).
# 초과는 422 (pydantic 검증). 분석기는 어차피 tail 수천 자만 프롬프트에 싣는다.
_MAX_TEXT_CHARS = 200_000
_MAX_EVENTS = 500


class IncidentContextSchema(BaseModel):
    pod_name: str = Field(..., min_length=1)
    namespace: str = Field(..., min_length=1)
    timestamp: str
    # 선택 — 지정되면 그 클러스터의 read 권한을 확인한다(테넌트 바인딩).
    cluster_id: Optional[str] = None
    events: list[KubeEventSchema] = Field(default_factory=list, max_length=_MAX_EVENTS)
    current_logs: str = Field(default="", max_length=_MAX_TEXT_CHARS)
    describe_output: str = Field(default="", max_length=_MAX_TEXT_CHARS)
    previous_logs: Optional[str] = Field(default=None, max_length=_MAX_TEXT_CHARS)
    related_workload: Optional[RelatedWorkloadSchema] = None
    argocd_status: Optional[ArgocdStatusSchema] = None


# ── Response schemas ──────────────────────────────────────────────────

class AnalysisResultSchema(BaseModel):
    severity: Literal["critical", "warning", "info"]
    root_cause: str
    suggested_actions: list[str]
    related_runbooks: list[str] = []
    confidence: float
    # "rule_based" | "claude" | "local_llm[:<profile>:<model>]"
    analyzed_by: str
    analyzed_at: str
    # RAG 근거 인용 — {title, source_type, ref_id, route, snippet, similarity}
    citations: list[dict] = []
    # 분석기 실패(LLM 미가용·HTTP 오류)·응답 파싱 실패로 대체 결과를 돌려준 경우 True (D-115)
    degraded: bool = False
    degraded_reason: Optional[str] = None


class AnalyzeResponse(BaseModel):
    status: Literal["ok", "error"]
    result: Optional[AnalysisResultSchema] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    backend: str
    available: bool


# ── Endpoints ─────────────────────────────────────────────────────────

def _parse_cluster_id(raw: Optional[str]) -> Optional[UUID]:
    if raw is None or not str(raw).strip():
        return None
    try:
        return UUID(str(raw).strip())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"cluster_id 형식이 올바르지 않습니다: {raw!r}") from e


def _audit_incident_analyze(
    db: Session,
    *,
    user: User,
    request: Request,
    body: "IncidentContextSchema",
    cluster_id: Optional[UUID],
    analyzer_name: str,
    degraded: Optional[bool],
    status: str,
    error: Optional[str] = None,
) -> None:
    """분석 1회 감사 기록 — 대상·입력 크기·분석기·degraded 만. **로그/describe 본문은 남기지 않는다.**"""
    try:
        details: dict = {
            "cluster_id": str(cluster_id) if cluster_id else None,
            "namespace": body.namespace,
            "pod": body.pod_name,
            "input": {
                "current_logs_chars": len(body.current_logs or ""),
                "previous_logs_chars": len(body.previous_logs or ""),
                "describe_chars": len(body.describe_output or ""),
                "events": len(body.events or []),
            },
            "analyzer": analyzer_name,
            "degraded": degraded,
        }
        if error:
            details["error"] = error[:200]
        audit_logger.record(
            db,
            action="incident.analyze",
            actor=user,
            status=status,
            target_type="cluster" if cluster_id else "pod",
            target_id=str(cluster_id) if cluster_id else f"{body.namespace}/{body.pod_name}",
            details=details,
            request=request,
        )
    except Exception as exc:  # noqa: BLE001 — 감사 실패가 분석 응답을 막으면 안 된다
        logger.warning("incident.analyze 감사 기록 실패 — 무시: %s", exc)


@router.post("/incident", response_model=AnalyzeResponse)
async def analyze_incident(
    body: IncidentContextSchema,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Analyze a Kubernetes pod incident and return structured insights.

    - ``cluster_id`` 가 있으면 그 클러스터 read 권한을 확인한다(없으면 403).
    - 사용자 테넌트의 LLM 라우팅 컨텍스트 안에서 분석한다(``llm_tenant_context``).
    - 분석 1회마다 감사 로그(``incident.analyze``)를 남긴다 — 본문 없이 크기·대상만.
    """
    cluster_id = _parse_cluster_id(body.cluster_id)
    require_cluster_access(db, user, cluster_id, "read")

    llm_tenant = resolve_llm_tenant(db, user)
    analyzer_name = "unknown"

    ctx = IncidentContext(
        pod_name=body.pod_name,
        namespace=body.namespace,
        timestamp=body.timestamp,
        events=[
            KubeEvent(
                reason=e.reason,
                message=e.message,
                count=e.count,
                first_time=e.first_time,
                last_time=e.last_time,
                type=e.type,
            )
            for e in body.events
        ],
        current_logs=body.current_logs,
        describe_output=body.describe_output,
        previous_logs=body.previous_logs,
        related_workload=(
            RelatedWorkload(
                kind=body.related_workload.kind,
                name=body.related_workload.name,
                status=body.related_workload.status,
            )
            if body.related_workload
            else None
        ),
        argocd_status=(
            ArgocdStatus(
                app=body.argocd_status.app,
                sync_status=body.argocd_status.sync_status,
                last_sync_at=body.argocd_status.last_sync_at,
            )
            if body.argocd_status
            else None
        ),
    )

    try:
        # 멀티테넌시 4단계 — 사용자 테넌트의 LLM 라우팅 오버라이드 + 사용량 귀속.
        # 분석기 선택도 컨텍스트 안에서 한다: 테넌트가 incident_analysis LLM 을 지정했으면
        # Claude 직접 호출 대신 게이트웨이 경유 분석기를 고른다(factory.tenant_pins_incident_llm).
        with llm_tenant_context(llm_tenant):
            analyzer = get_analyzer(db)
            analyzer_name = type(analyzer).__name__
            result: AnalysisResult = await analyzer.analyze(ctx)
    except Exception as exc:
        _audit_incident_analyze(
            db, user=user, request=request, body=body, cluster_id=cluster_id,
            analyzer_name=analyzer_name, degraded=None, status="failure",
            error=f"{type(exc).__name__}: {exc}",
        )
        raise HTTPException(status_code=502, detail=f"Analyzer error: {str(exc)[:300]}") from exc

    _audit_incident_analyze(
        db, user=user, request=request, body=body, cluster_id=cluster_id,
        analyzer_name=result.analyzed_by, degraded=bool(result.degraded), status="success",
    )

    return AnalyzeResponse(
        status="ok",
        result=AnalysisResultSchema(
            severity=result.severity,
            root_cause=result.root_cause,
            suggested_actions=result.suggested_actions,
            related_runbooks=result.related_runbooks,
            confidence=result.confidence,
            analyzed_by=result.analyzed_by,
            analyzed_at=result.analyzed_at,
            citations=list(getattr(result, "citations", None) or []),
            degraded=bool(getattr(result, "degraded", False)),
            degraded_reason=getattr(result, "degraded_reason", None),
        ),
    )


@router.get("/health", response_model=HealthResponse)
async def analyzer_health():
    """Check whether the configured analyzer backend is reachable."""
    from app.services.analyzers.factory import get_analyzer_backend
    backend = get_analyzer_backend()
    analyzer = get_analyzer()
    available = await analyzer.health_check()
    return HealthResponse(backend=backend, available=available)


# ── Cluster → Namespace → Pod 드릴다운 ──────────────────────────────

class NamespaceItem(BaseModel):
    name: str
    pod_count: Optional[int] = None
    has_unhealthy: bool = False


class NamespacesResponse(BaseModel):
    cluster_id: UUID
    cluster_name: str
    namespaces: list[NamespaceItem]


class PodItem(BaseModel):
    name: str
    namespace: str
    phase: str
    ready: str  # "1/1" 형식
    restart_count: int = 0
    node: Optional[str] = None
    age_seconds: Optional[int] = None
    has_issue: bool = False
    issue_reason: Optional[str] = None  # CrashLoopBackOff, ImagePullBackOff, OOMKilled ...


class PodsResponse(BaseModel):
    cluster_id: UUID
    cluster_name: str
    namespace: str
    pods: list[PodItem]


@router.get("/clusters/{cluster_id}/namespaces", response_model=NamespacesResponse)
def list_namespaces(
    cluster_id: UUID,
    only_with_issues: bool = False,
    with_counts: bool = False,
    namespace_pattern: str = "",
    pod_pattern: str = "",
    db: Session = Depends(get_db),
):
    """장애 분석 UI 의 namespace 드롭다운용.

    **빠른 경로 (기본)**: pod 목록을 가져오지 않고 ns 이름만 반환 → 거대 클러스터에서도
    즉시 응답. ``pod_count`` / ``has_unhealthy`` 는 모두 None / False.

    **느린 경로 (opt-in)**:
      - ``only_with_issues=true`` → 비정상 pod 가 있는 ns 만 (필터)
      - ``with_counts=true``      → 각 ns 의 pod 수 + 이상 여부 표기
    둘 중 하나라도 켜지면 pod fetch 가 발동된다. 이 때 비용을 줄이기 위해:

      - ``namespace_pattern`` (CSV glob, 예: "kube-*,monitoring") 이 주어지면 ns 페이지네이션
        fetch 직후 인메모리에서 1차 필터 → pod fetch 대상 ns 가 줄어든다.
      - 필터 후 ns 가 50개 이하면 ns 별 ``list_namespaced_pod`` 를 순차 호출해 클러스터
        전체 pod (수만~수십만 개) fetch 를 피한다. 50개 초과면 기존처럼
        ``list_pod_for_all_namespaces`` 한 방으로 가져온 뒤 인메모리 필터.
      - ``pod_pattern`` 이 주어지면 pod 순회 중에 매칭되는 pod 만 ``_is_pod_unhealthy``
        평가 대상이 된다.

    namespace 자체도 페이지네이션(_continue) 으로 가져와 ns 가 1만개여도 견딘다.
    """
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)

    # 1) namespace 페이지네이션 fetch
    try:
        ns_items = []
        token: str | None = None
        # 안전 상한 — ns 가 5만개 같은 비현실적인 케이스 방어.
        for _ in range(200):
            kwargs: dict = {"_request_timeout": _K8S_NS_LIST_TIMEOUT, "limit": _K8S_LIST_PAGE}
            if token:
                kwargs["_continue"] = token
            page = v1.list_namespace(**kwargs)
            ns_items.extend(page.items)
            token = (page.metadata._continue or None) if page.metadata else None
            if not token:
                break
    except Exception as e:
        msg = str(e)[:200]
        is_timeout = "timeout" in msg.lower() or "timed out" in msg.lower()
        raise HTTPException(
            status_code=504 if is_timeout else 502,
            detail=f"namespace 조회 실패: {msg}",
        ) from e

    # 1.5) namespace_pattern 으로 1차 필터 — pod fetch 비용 절감.
    if namespace_pattern.strip():
        ns_items = [
            ns for ns in ns_items
            if _matches_csv_glob(ns.metadata.name, namespace_pattern)
        ]

    counts: dict[str, int] = {}
    unhealthy: dict[str, bool] = {}

    # 2) pod fetch — 사용자가 명시적으로 요구할 때만.
    if (only_with_issues or with_counts) and ns_items:
        # 필터 후 ns 가 적게 남았으면 ns 별 순차 fetch (큰 클러스터에서 압도적으로 빠름).
        target_ns_names = {ns.metadata.name for ns in ns_items}
        use_per_ns = len(target_ns_names) <= 50

        def _consume_pod(p) -> None:
            ns_name = p.metadata.namespace
            if ns_name not in target_ns_names:
                return
            if pod_pattern.strip() and not _matches_csv_glob(p.metadata.name, pod_pattern):
                return
            if with_counts:
                counts[ns_name] = counts.get(ns_name, 0) + 1
            if _is_pod_unhealthy(p):
                unhealthy[ns_name] = True

        try:
            if use_per_ns:
                for ns_name in target_ns_names:
                    pod_token: str | None = None
                    for _ in range(200):
                        kwargs = {
                            "_request_timeout": _K8S_POD_LIST_TIMEOUT,
                            "limit": _K8S_POD_LIST_PAGE,
                        }
                        if pod_token:
                            kwargs["_continue"] = pod_token
                        page = v1.list_namespaced_pod(ns_name, **kwargs)
                        for p in page.items:
                            _consume_pod(p)
                        pod_token = (page.metadata._continue or None) if page.metadata else None
                        if not pod_token:
                            break
            else:
                pod_token = None
                for _ in range(200):
                    kwargs = {
                        "_request_timeout": _K8S_POD_LIST_TIMEOUT,
                        "limit": _K8S_POD_LIST_PAGE,
                    }
                    if pod_token:
                        kwargs["_continue"] = pod_token
                    page = v1.list_pod_for_all_namespaces(**kwargs)
                    for p in page.items:
                        _consume_pod(p)
                    pod_token = (page.metadata._continue or None) if page.metadata else None
                    if not pod_token:
                        break
        except Exception as e:
            # pod 조회 실패는 경고만 — namespace 리스트 자체는 반환.
            logger.warning("pod list 실패 (counts/unhealthy 미반영): %s", str(e)[:200])

    items: list[NamespaceItem] = []
    for ns in ns_items:
        name = ns.metadata.name
        item = NamespaceItem(
            name=name,
            pod_count=counts.get(name) if with_counts else None,
            has_unhealthy=unhealthy.get(name, False),
        )
        if only_with_issues and not item.has_unhealthy:
            continue
        items.append(item)

    # 비정상 ns 를 위로
    items.sort(key=lambda i: (not i.has_unhealthy, i.name))

    return NamespacesResponse(
        cluster_id=cluster_id, cluster_name=cluster.name, namespaces=items,
    )


@router.get("/clusters/{cluster_id}/namespaces/{namespace}/pods", response_model=PodsResponse)
def list_pods(
    cluster_id: UUID,
    namespace: str,
    only_with_issues: bool = False,
    db: Session = Depends(get_db),
):
    """선택된 namespace 의 pod 목록 — UI 의 pod 드롭다운/리스트용."""
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)

    # ns 안에 pod 가 수만 개일 수도 있으므로 페이지네이션 + 긴 타임아웃 사용.
    try:
        pod_items = []
        token: str | None = None
        for _ in range(200):
            kwargs: dict = {"_request_timeout": _K8S_POD_LIST_TIMEOUT, "limit": _K8S_POD_LIST_PAGE}
            if token:
                kwargs["_continue"] = token
            page = v1.list_namespaced_pod(namespace, **kwargs)
            pod_items.extend(page.items)
            token = (page.metadata._continue or None) if page.metadata else None
            if not token:
                break

        class _Bag:
            pass
        pods = _Bag()
        pods.items = pod_items
    except Exception as e:
        msg = str(e)[:200]
        is_timeout = "timeout" in msg.lower() or "timed out" in msg.lower()
        raise HTTPException(
            status_code=504 if is_timeout else 502,
            detail=f"pod 조회 실패: {msg}",
        ) from e

    items: list[PodItem] = []
    now = datetime.utcnow()
    for p in pods.items:
        unhealthy, reason = _pod_issue(p)
        if only_with_issues and not unhealthy:
            continue

        ready_n = sum(1 for cs in (p.status.container_statuses or []) if cs.ready)
        ready_total = len(p.spec.containers or [])
        restart_count = sum((cs.restart_count or 0) for cs in (p.status.container_statuses or []))

        age_seconds = None
        if p.status.start_time:
            try:
                start = p.status.start_time.replace(tzinfo=None)
                age_seconds = int((now - start).total_seconds())
            except Exception:
                age_seconds = None

        items.append(PodItem(
            name=p.metadata.name,
            namespace=p.metadata.namespace,
            phase=p.status.phase or "Unknown",
            ready=f"{ready_n}/{ready_total}",
            restart_count=restart_count,
            node=p.spec.node_name,
            age_seconds=age_seconds,
            has_issue=unhealthy,
            issue_reason=reason,
        ))

    items.sort(key=lambda i: (not i.has_issue, -(i.restart_count or 0), i.name))

    return PodsResponse(
        cluster_id=cluster_id, cluster_name=cluster.name, namespace=namespace, pods=items,
    )


# ── Pod 상세 컨텍스트 자동 수집 ──────────────────────────────────────

class IncidentContextFetchResponse(BaseModel):
    cluster_id: UUID
    cluster_name: str
    pod_name: str
    namespace: str
    timestamp: str
    events: list[KubeEventSchema]
    current_logs: str
    previous_logs: Optional[str] = None
    describe_output: str
    # 로그를 수집한 컨테이너 — 쿼리 → default-container 어노테이션 → 실패·재시작 컨테이너 → 첫 컨테이너
    container: Optional[str] = None


# ── SSE 스트림 공용 (D-182·D-187) ─────────────────────────────────────
# 계약(프론트 PodLogStream·이벤트 탭이 이 형식에 맞춰 구현됨):
#   - 로그/이벤트 1건: `data: <line>\n\n`
#   - 종료:  `event: end\ndata: {"reason": "eof"|"max_duration"|"truncated", "bytes": N}\n\n` 후 닫음
#   - 오류:  `event: error\ndata: {"message": "<한국어>"}\n\n` 후 닫음
#   - 하트비트: 데이터가 없으면 ≤15초마다 `: ping\n\n`(SSE 주석 — 화면은 무시). 쓰기가 일어나야
#     서버가 끊긴 클라이언트를 알아채므로 슬롯이 바로 반환된다.
# 구조: K8s 읽기는 데몬 리더 스레드가 하고 큐로 넘긴다. 응답 generator 는 큐를 하트비트 주기로
# 기다리므로 조용한 파드에서도 최대 시간·연결 해제를 벽시계로 확인한다. K8s 읽기 자체는
# 읽기 타임아웃(30초)으로 깨어나 마지막 수신 시점 기준 `since_seconds` 로 이어 읽는다
# (timestamps=true 고정 → 겹친 줄은 타임스탬프로 걸러 공백·중복 없음).
_LOG_STREAM_HEARTBEAT_SECONDS = 15.0
_LOG_STREAM_REQUEST_TIMEOUT = (10, 30)  # (connect, read) 초
_LOG_STREAM_MAX_BYTES = 10_000_000  # 스트림 1개가 보내는 로그 본문 상한 → 넘으면 end(truncated)
_LOG_STREAM_RESUME_MARGIN_SECONDS = 5  # 이어 읽기 창 여유(겹침은 타임스탬프로 제거)
_LOG_STREAM_MAX_RECONNECTS = 3  # 데이터 없이 연속 끊김(타임아웃 제외) 허용 횟수
_LOG_STREAM_QUEUE_MAX = 2000
_LOG_STREAM_DRAIN_BATCH = 500

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    # nginx 의 기본 proxy_buffering 을 이 응답에 한해 끔 — 없으면 nginx 가
    # 응답을 다 모을 때까지 버퍼링해 로그 스트림 실시간성이 사라진다.
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
    # GZipMiddleware 는 이 헤더가 있으면 압축을 건너뛴다 — SSE 를 gzip 하면
    # zlib 내부 버퍼링 때문에 위 X-Accel-Buffering:no 의 실시간성이 깨진다.
    "Content-Encoding": "identity",
}

# kubelet 이 붙이는 RFC3339Nano 타임스탬프 (timestamps=true).
# 끝은 `Z` 또는 `+09:00` 같은 오프셋 — containerd 가 노드 로컬 시간대로 쓴 줄도 kubelet 이 그대로 넘긴다.
_LOG_TS_RE = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$")


def _stream_limit_detail() -> str:
    return (
        f"동시 로그 스트림 한도(사용자당 {_stream_limiter.per_user}·전체 {_stream_limiter.total})를 "
        "넘었습니다. 다른 스트림을 닫고 다시 시도하세요."
    )


def _acquire_stream_slot(user: User) -> _StreamSlot:
    slot = _stream_limiter.try_acquire(str(getattr(user, "id", None) or getattr(user, "username", "")))
    if slot is None:
        raise HTTPException(status_code=429, detail=_stream_limit_detail())
    return slot


def _sse_event(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _sse_data(text: str) -> str:
    # SSE data 필드는 줄바꿈을 담을 수 없다 — 한 줄 = 한 이벤트.
    return f"data: {text.replace(chr(13), '').replace(chr(10), ' ')}\n\n"


def _is_read_timeout(exc: BaseException) -> bool:
    seen = 0
    cur: Optional[BaseException] = exc
    while cur is not None and seen < 6:
        if isinstance(cur, (ReadTimeoutError, TimeoutError)):
            return True
        if "read timed out" in str(cur).lower():
            return True
        cur = cur.__cause__ or cur.__context__
        seen += 1
    return False


def _is_conn_broken(exc: BaseException) -> bool:
    return isinstance(exc, (ProtocolError, ConnectionError))


def _stream_error_message(exc: BaseException, what: str) -> str:
    if isinstance(exc, ApiException):
        msg = ""
        try:
            body = json.loads(exc.body or "{}")
            msg = str(body.get("message") or "")
        except Exception:  # noqa: BLE001
            msg = ""
        return f"{what} 실패 (HTTP {exc.status}): {(msg or exc.reason or '').strip()[:200]}"
    if _is_read_timeout(exc):
        return f"{what} 실패: K8s API 응답이 없습니다(읽기 타임아웃)."
    return f"{what} 실패: {str(exc)[:200] or type(exc).__name__}"


def _log_ts_key(line: str) -> tuple[Optional[tuple[str, int]], str]:
    """`<RFC3339Nano> <본문>` → ((초 단위 시각, 나노초), 본문). 타임스탬프가 없으면 (None, line)."""
    ts, _sep, rest = line.partition(" ")
    m = _LOG_TS_RE.match(ts)
    if not m:
        return None, line
    nanos = int((m.group(2) or "0").ljust(9, "0"))
    secs = m.group(1)
    if m.group(3) != "Z":
        # 오프셋 시각은 UTC 로 맞춰 비교한다(재연결 중복 제거 키는 UTC 초 문자열 + 나노초).
        try:
            secs = (datetime.fromisoformat(secs + m.group(3)).astimezone(timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            return None, line
    return (secs, nanos), rest


def _shutdown_resp(resp) -> None:
    """다른 스레드에서 막혀 있는 urllib3 응답 읽기를 깨운다 (urllib3 ≥2.3 `shutdown`)."""
    if resp is None:
        return
    try:
        shutdown = getattr(resp, "shutdown", None)
        if callable(shutdown):
            shutdown()
    except Exception:  # noqa: BLE001
        pass


def _close_resp(resp) -> None:
    if resp is None:
        return
    for fn in ("close", "release_conn"):
        try:
            getattr(resp, fn)()
        except Exception:  # noqa: BLE001
            pass


class _StreamChannel:
    """리더 스레드 → 응답 generator 큐. `put` 은 소비자가 떠나면(stop) 포기한다."""

    def __init__(self) -> None:
        self.q: "queue.Queue[tuple[str, str]]" = queue.Queue(maxsize=_LOG_STREAM_QUEUE_MAX)
        self.stop = threading.Event()
        self.resp = None  # 현재 읽는 urllib3 응답 (끊을 때 shutdown)
        self.watch = None  # 현재 Watch (끊을 때 stop)

    def put(self, kind: str, value: str) -> bool:
        while not self.stop.is_set():
            try:
                self.q.put((kind, value), timeout=1.0)
                return True
            except queue.Full:
                continue
        return False

    def close(self) -> None:
        self.stop.set()
        _shutdown_resp(self.resp)
        w = self.watch
        if w is not None:
            try:
                w.stop()
            except Exception:  # noqa: BLE001
                pass


class _SlotStream:
    """SSE generator 래퍼 — `close()` 가 (한 번도 시작 안 된 generator 여도) 슬롯을 반환한다.

    시작 전 generator 의 `close()` 는 본문 `finally` 를 돌리지 않으므로 여기서 직접 반환하고,
    아무도 닫지 않고 버려지면 `weakref.finalize` 가 반환한다(응답 시작 전 클라이언트 끊김).
    """

    def __init__(self, gen, slot: _StreamSlot):
        self._gen = gen
        self._slot = slot
        weakref.finalize(self, slot.release)

    def __iter__(self):
        return self

    def __next__(self) -> str:
        return next(self._gen)

    def close(self) -> None:
        try:
            self._gen.close()
        finally:
            self._slot.release()


def _sse_stream(reader, slot: _StreamSlot, *, max_bytes: Optional[int], what: str, thread_name: str):
    """리더(`reader(channel)`)를 데몬 스레드로 돌리고 큐를 SSE 로 내보내는 iterator.

    종료·오류 이벤트는 리더를 멈추고 슬롯을 반환한 **뒤** 마지막으로 내보낸다. 클라이언트가
    끊어 generator 가 닫히면 `finally` 가 같은 정리를 한다.
    """

    def _run(ch: _StreamChannel) -> None:
        try:
            reader(ch)
        except Exception as e:  # noqa: BLE001
            if not ch.stop.is_set():
                logger.info("%s stream reader error: %s", what, e)
                ch.put("error", _stream_error_message(e, what))

    def _pump(ch: _StreamChannel):
        """로그·하트비트를 yield 하고, 끝나면 마지막(종료/오류) 청크를 return 한다."""
        sent = 0
        deadline = time.monotonic() + max(1, int(settings.log_stream_max_duration_seconds))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return _sse_event("end", {"reason": "max_duration", "bytes": sent})
            try:
                first = ch.q.get(timeout=min(_LOG_STREAM_HEARTBEAT_SECONDS, remaining))
            except queue.Empty:
                if deadline - time.monotonic() > 0:
                    yield ": ping\n\n"
                continue
            items = [first]
            while len(items) < _LOG_STREAM_DRAIN_BATCH:
                try:
                    items.append(ch.q.get_nowait())
                except queue.Empty:
                    break
            parts: list[str] = []
            for kind, value in items:
                if kind == "line":
                    size = len(value.encode("utf-8", errors="replace"))
                    if max_bytes is not None and sent + size > max_bytes:
                        parts.append(_sse_event("end", {"reason": "truncated", "bytes": sent}))
                        return "".join(parts)
                    sent += size
                    parts.append(_sse_data(value))
                elif kind == "end":
                    parts.append(_sse_event("end", {"reason": value, "bytes": sent}))
                    return "".join(parts)
                else:
                    parts.append(_sse_event("error", {"message": value}))
                    return "".join(parts)
            if parts:
                yield "".join(parts)

    def _gen():
        ch = _StreamChannel()
        try:
            threading.Thread(target=_run, args=(ch,), name=thread_name, daemon=True).start()
            final = yield from _pump(ch)
        finally:
            ch.close()
            slot.release()
        if final:
            yield final

    return _SlotStream(_gen(), slot)


def _pod_log_reader(
    v1: k8s_client.CoreV1Api,
    *,
    pod_name: str,
    namespace: str,
    container: Optional[str],
    follow: bool,
    previous: bool,
    timestamps: bool,
    tail_lines: int,
    since_seconds: Optional[int],
):
    """파드 로그 리더 — 읽기 타임아웃이면 마지막 수신 시점 기준으로 이어 읽는다."""

    def _reader(ch: _StreamChannel) -> None:
        last_key: Optional[tuple[str, int]] = None
        seen_at_last: set[str] = set()
        last_rx: Optional[float] = None
        connected_at = time.monotonic()
        first = True
        broken = 0
        while not ch.stop.is_set():
            kwargs: dict = dict(
                name=pod_name,
                namespace=namespace,
                container=container or None,
                follow=follow,
                previous=previous,
                # 이어 읽기 중복 제거에 필요해 항상 받고, 사용자가 끄면 본문만 보낸다.
                timestamps=True,
                _preload_content=False,
                _request_timeout=_LOG_STREAM_REQUEST_TIMEOUT,
            )
            if first:
                kwargs["tail_lines"] = max(1, min(tail_lines, 5000))
                if since_seconds is not None and since_seconds > 0:
                    kwargs["since_seconds"] = since_seconds
            else:
                ref = last_rx if last_rx is not None else connected_at
                kwargs["since_seconds"] = max(
                    1, int(math.ceil(time.monotonic() - ref)) + _LOG_STREAM_RESUME_MARGIN_SECONDS,
                )
            resumed = not first
            first = False
            connected_at = time.monotonic()
            resp = v1.read_namespaced_pod_log(**kwargs)
            ch.resp = resp
            buf = b""
            try:
                try:
                    for chunk in resp.stream(amt=None, decode_content=True):
                        if ch.stop.is_set():
                            return
                        if not chunk:
                            continue
                        buf += chunk if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode("utf-8")
                        *complete, buf = buf.split(b"\n")
                        for raw in complete:
                            line = raw.decode("utf-8", errors="replace").rstrip("\r")
                            key, body = _log_ts_key(line)
                            if resumed and key is not None and last_key is not None:
                                if key < last_key or (key == last_key and line in seen_at_last):
                                    continue
                            if key is not None:
                                if key != last_key:
                                    last_key = key
                                    seen_at_last = set()
                                if len(seen_at_last) < 1000:
                                    seen_at_last.add(line)
                            last_rx = time.monotonic()
                            broken = 0
                            if not ch.put("line", line if (timestamps or key is None) else body):
                                return
                except Exception as e:  # noqa: BLE001
                    if ch.stop.is_set():
                        return
                    if follow and _is_read_timeout(e):
                        continue  # 조용한 파드 — 이어 읽기 (미완성 줄은 다시 받는다)
                    if follow and _is_conn_broken(e) and broken < _LOG_STREAM_MAX_RECONNECTS:
                        broken += 1
                        ch.stop.wait(1.0)
                        continue
                    raise
                if buf:
                    line = buf.decode("utf-8", errors="replace").rstrip("\r")
                    key, body = _log_ts_key(line)
                    if not (resumed and key is not None and last_key is not None and key <= last_key and line in seen_at_last):
                        ch.put("line", line if (timestamps or key is None) else body)
                ch.put("end", "eof")
                return
            finally:
                ch.resp = None
                _close_resp(resp)

    return _reader


@router.get("/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod_name}/logs/stream")
def stream_pod_logs(
    cluster_id: UUID,
    namespace: str,
    pod_name: str,
    container: Optional[str] = None,
    tail_lines: int = 200,
    follow: bool = True,
    previous: bool = False,
    timestamps: bool = False,
    since_seconds: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """파드 로그 SSE 스트림 (읽기전용). follow=True 면 실시간 tail.

    OpenLens 류의 follow 로그 뷰어용. 인증된 fetch 로 ``text/event-stream`` 소비.
    멀티컨테이너 파드는 ``container`` 미지정 시 에러 → 컨테이너명을 지정한다.
    ``timestamps=True`` 면 각 줄 앞에 RFC3339 타임스탬프가 붙는다(표시 토글은 프론트).
    종료·오류·하트비트 형식은 위 SSE 계약 주석 참고. 동시 한도 초과는 429(JSON ``detail``).
    """
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)
    slot = _acquire_stream_slot(current_user)
    try:
        reader = _pod_log_reader(
            v1,
            pod_name=pod_name,
            namespace=namespace,
            container=container,
            follow=follow,
            previous=previous,
            timestamps=timestamps,
            tail_lines=tail_lines,
            since_seconds=since_seconds,
        )
        gen = _sse_stream(
            reader, slot, max_bytes=_LOG_STREAM_MAX_BYTES, what="로그 조회", thread_name="pod-log-stream",
        )
    except Exception:
        slot.release()
        raise
    return StreamingResponse(gen, media_type="text/event-stream", headers=dict(_SSE_HEADERS))


class PodContainerInfo(BaseModel):
    name: str
    init: bool = False
    state: Optional[str] = None  # running | waiting | terminated
    restart_count: int = 0


class PodContainersResponse(BaseModel):
    containers: list[PodContainerInfo]
    default_container: Optional[str] = None


@router.get(
    "/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod_name}/containers",
    response_model=PodContainersResponse,
)
def list_pod_containers(
    cluster_id: UUID,
    namespace: str,
    pod_name: str,
    db: Session = Depends(get_db),
):
    """파드의 컨테이너(+init) 목록 — 로그/터미널 컨테이너 셀렉터용.

    ``kubectl.kubernetes.io/default-container`` 어노테이션이 있으면 그것을,
    없으면 첫 일반 컨테이너를 default 로 반환한다.
    """
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)
    pod = _read_pod(v1, pod_name, namespace)

    items: list[PodContainerInfo] = []
    spec = pod.spec
    status = pod.status
    for c in (spec.containers if spec else None) or []:
        state, restarts = _state_of(status.container_statuses if status else None, c.name)
        items.append(PodContainerInfo(name=c.name, init=False, state=state, restart_count=restarts))
    for c in (spec.init_containers if spec else None) or []:
        state, restarts = _state_of(status.init_container_statuses if status else None, c.name)
        items.append(PodContainerInfo(name=c.name, init=True, state=state, restart_count=restarts))

    # 로그/터미널 셀렉터의 기본값 — 어노테이션 → 첫 일반 컨테이너 (실패 컨테이너 우선 선택은
    # 장애 컨텍스트 수집에만 쓴다: 터미널 기본값이 죽은 init 컨테이너가 되면 exec 가 실패한다).
    default = _pick_container(pod, prefer_failing=False)
    return PodContainersResponse(containers=items, default_container=default)


@router.get("/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod_name}/logs/download")
def download_pod_logs(
    cluster_id: UUID,
    namespace: str,
    pod_name: str,
    container: Optional[str] = None,
    previous: bool = False,
    tail_lines: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """파드 로그 전체 다운로드 (non-follow, 최대 10MB).

    10MB 상한에 걸려 잘렸으면 응답 헤더 ``X-Log-Truncated: 1`` (D-187 ⑦ — 화면이 토스트로 알림).
    """
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)
    try:
        kwargs = dict(
            name=pod_name,
            namespace=namespace,
            container=container or None,
            previous=previous,
            limit_bytes=_LOG_STREAM_MAX_BYTES,
            _request_timeout=60,
        )
        if tail_lines is not None and tail_lines > 0:
            kwargs["tail_lines"] = tail_lines
        text = v1.read_namespaced_pod_log(**kwargs)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"로그 조회 실패: {str(e)[:200]}") from e
    filename = f"{pod_name}_{container or 'default'}{'.previous' if previous else ''}.log"
    body = text or ""
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        # 교차 출처(개발 서버 등)에서도 fetch 가 헤더를 읽을 수 있게 노출.
        "Access-Control-Expose-Headers": "Content-Disposition, X-Log-Truncated",
    }
    # kubelet 은 limit_bytes 에서 줄 중간이라도 자른다 — 상한에 닿았으면 잘린 것으로 본다.
    if len(body.encode("utf-8", errors="replace")) >= _LOG_STREAM_MAX_BYTES:
        headers["X-Log-Truncated"] = "1"
    return PlainTextResponse(body, headers=headers)


@router.get("/clusters/{cluster_id}/events/stream")
def stream_cluster_events(
    cluster_id: UUID,
    namespace: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """클러스터 이벤트 SSE 스트림 (읽기전용, Lens 의 Events 탭).

    초기 스냅샷을 보낸 뒤 watch 로 신규 이벤트를 실시간 push 한다. 각 ``data:`` 는
    JSON 1건. 종료·오류·하트비트·동시 한도는 파드 로그 스트림과 같은 SSE 계약이다 —
    watch 는 읽기 타임아웃(30초)·서버 타임아웃마다 마지막 resourceVersion 으로 이어 붙고,
    최대 시간(`log_stream_max_duration_seconds`)이 지나면 ``event: end`` (max_duration).
    """
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)
    slot = _acquire_stream_slot(current_user)

    def _evt_payload(ev_type: str, obj) -> str:
        io = getattr(obj, "involved_object", None)
        ts = getattr(obj, "last_timestamp", None) or getattr(obj, "event_time", None)
        first = getattr(obj, "first_timestamp", None)
        src = getattr(obj, "source", None)
        source = None
        if src is not None:
            source = getattr(src, "component", None) or getattr(src, "host", None)
        if not source:
            source = getattr(obj, "reporting_component", None) or None
        payload = {
            "watchType": ev_type,
            "uid": getattr(obj.metadata, "uid", None) if obj.metadata else None,
            "name": getattr(obj.metadata, "name", None) if obj.metadata else None,
            "type": getattr(obj, "type", None),  # Normal | Warning
            "reason": getattr(obj, "reason", None),
            "message": (getattr(obj, "message", None) or "")[:500],
            "namespace": getattr(obj.metadata, "namespace", None) if obj.metadata else None,
            "involvedKind": getattr(io, "kind", None) if io else None,
            "involvedName": getattr(io, "name", None) if io else None,
            "source": source,
            "count": getattr(obj, "count", None),
            "firstTimestamp": first.isoformat() if first else None,
            "lastTimestamp": ts.isoformat() if ts else None,
        }
        return json.dumps(payload, ensure_ascii=False)

    def _reader(ch: _StreamChannel) -> None:
        rv: Optional[str] = None
        broken = 0
        while not ch.stop.is_set():
            w = k8s_watch.Watch()
            ch.watch = w
            kwargs: dict = dict(timeout_seconds=300, _request_timeout=_LOG_STREAM_REQUEST_TIMEOUT)
            if rv:
                kwargs["resource_version"] = rv
            started = time.monotonic()
            got = 0
            try:
                if namespace:
                    stream = w.stream(v1.list_namespaced_event, namespace, **kwargs)
                else:
                    stream = w.stream(v1.list_event_for_all_namespaces, **kwargs)
                for ev in stream:
                    if ch.stop.is_set():
                        return
                    try:
                        payload = _evt_payload(ev.get("type", "?"), ev["object"])
                    except Exception:  # noqa: BLE001
                        continue
                    got += 1
                    broken = 0
                    if not ch.put("line", payload):
                        return
            except ApiException as e:
                if ch.stop.is_set():
                    return
                if e.status == 410:  # resourceVersion 만료 — 처음부터 다시 watch
                    rv = None
                    continue
                raise
            except Exception as e:  # noqa: BLE001
                if ch.stop.is_set():
                    return
                if _is_read_timeout(e):
                    rv = w.resource_version or rv
                    continue
                if _is_conn_broken(e) and broken < _LOG_STREAM_MAX_RECONNECTS:
                    broken += 1
                    rv = w.resource_version or rv
                    ch.stop.wait(1.0)
                    continue
                raise
            finally:
                ch.watch = None
            # 서버 쪽 timeout_seconds 로 watch 가 정상 종료 — 이어 붙인다(빈 응답 반복이면 숨 고르기).
            rv = w.resource_version or rv
            if got == 0 and time.monotonic() - started < 1.0:
                ch.stop.wait(1.0)

    try:
        gen = _sse_stream(_reader, slot, max_bytes=None, what="이벤트 조회", thread_name="event-stream")
    except Exception:
        slot.release()
        raise
    return StreamingResponse(gen, media_type="text/event-stream", headers=dict(_SSE_HEADERS))


@router.get(
    "/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod_name}/context",
    response_model=IncidentContextFetchResponse,
)
def fetch_incident_context(
    cluster_id: UUID,
    namespace: str,
    pod_name: str,
    tail_lines: int = 200,
    container: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """선택된 pod 의 logs / events / describe 를 한 번에 수집.

    UI 에서 "자동 채우기" 버튼으로 호출 → 그대로 ``/analyze/incident`` 에 보내면 됨.
    로그 컨테이너는 ``container`` 쿼리 → ``kubectl.kubernetes.io/default-container`` 어노테이션
    → 실패·재시작 중인 컨테이너(init 포함) → 첫 컨테이너 순으로 고르고, 응답 ``container`` 에 싣는다.
    """
    if tail_lines < 1 or tail_lines > 5000:
        raise HTTPException(status_code=422, detail="tail_lines 는 1~5000 사이여야 합니다")

    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)

    # 1) Pod object — describe 와 컨테이너 목록을 위해 필요
    pod = _read_pod(v1, pod_name, namespace)

    # 2) Logs — 선택 규칙은 _pick_container. previous 는 best-effort.
    requested = (container or "").strip() or None
    if requested and requested not in _container_names(pod):
        raise HTTPException(
            status_code=422,
            detail=f"컨테이너 '{requested}' 가 pod {namespace}/{pod_name} 에 없습니다 "
                   f"(있는 컨테이너: {', '.join(_container_names(pod)) or '-'})",
        )
    container = requested or _pick_container(pod, prefer_failing=True)
    current_logs = ""
    previous_logs: Optional[str] = None
    if container:
        try:
            current_logs = v1.read_namespaced_pod_log(
                pod_name, namespace, container=container,
                tail_lines=tail_lines, _request_timeout=_K8S_TIMEOUT * 2,
            ) or ""
        except Exception as e:
            current_logs = f"[로그 조회 실패] {type(e).__name__}: {str(e)[:200]}"
        try:
            previous_logs = v1.read_namespaced_pod_log(
                pod_name, namespace, container=container, previous=True,
                tail_lines=tail_lines, _request_timeout=_K8S_TIMEOUT * 2,
            )
        except Exception:
            previous_logs = None  # previous 컨테이너 없으면 정상

    # 3) Events — Pod 한정
    events: list[KubeEventSchema] = []
    try:
        ev_list = v1.list_namespaced_event(
            namespace,
            field_selector=f"involvedObject.name={pod_name}",
            _request_timeout=_K8S_TIMEOUT,
        )
        for ev in ev_list.items:
            events.append(KubeEventSchema(
                reason=ev.reason or "",
                message=ev.message or "",
                count=ev.count or 1,
                first_time=str(ev.first_timestamp) if ev.first_timestamp else "",
                last_time=str(ev.last_timestamp) if ev.last_timestamp else "",
                type=ev.type or "Normal",
            ))
    except Exception as e:
        logger.warning("event 조회 실패: %s", e)

    # 4) describe 텍스트 — kubernetes SDK 는 describe 를 직접 안 주므로 핵심 필드를 직접 만들어준다.
    describe_output = _build_describe_text(pod, events)

    return IncidentContextFetchResponse(
        cluster_id=cluster_id,
        cluster_name=cluster.name,
        pod_name=pod_name,
        namespace=namespace,
        timestamp=datetime.utcnow().isoformat() + "Z",
        events=events,
        current_logs=current_logs[:20000] if current_logs else "",
        previous_logs=previous_logs[:20000] if previous_logs else None,
        describe_output=describe_output,
        container=container,
    )


# ── helpers ─────────────────────────────────────────────────────────


def _matches_csv_glob(name: str, csv_glob: str) -> bool:
    """CSV 로 구분된 glob 패턴 중 하나라도 매치하면 True.

    빈 문자열(공백만 포함 포함) 이면 "필터 없음" 으로 간주해 True 반환.
    빈 세그먼트(연속 콤마)는 무시 — 그 자체로 모든 것을 매치하지 않음.

    예:
        _matches_csv_glob("kube-system", "kube-*,monitoring") -> True
        _matches_csv_glob("default",     "kube-*,monitoring") -> False
        _matches_csv_glob("anything",    "")                  -> True
    """
    if not csv_glob.strip():
        return True
    for pat in csv_glob.split(","):
        pat = pat.strip()
        if pat and fnmatch.fnmatch(name, pat):
            return True
    return False


_BAD_WAITING_REASONS = {
    "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull",
    "CreateContainerError", "CreateContainerConfigError", "InvalidImageName",
    "RunContainerError",
}
_BAD_TERMINATED_REASONS = {"OOMKilled", "Error", "ContainerCannotRun"}


def _pod_issue(pod) -> tuple[bool, Optional[str]]:
    """Pod 의 비정상 여부와 사유 한 줄. init 컨테이너 실패도 본다(Init:… 접두사)."""
    phase = pod.status.phase or ""
    if phase in ("Failed", "Unknown"):
        return True, phase
    # init 컨테이너가 실패하면 일반 컨테이너는 아직 Waiting(PodInitializing)이라 아래 루프로는 안 잡힌다.
    for cs in (pod.status.init_container_statuses or []):
        st = cs.state
        if st and st.waiting and st.waiting.reason in _BAD_WAITING_REASONS:
            return True, f"Init:{st.waiting.reason}"
        if st and st.terminated and (
            st.terminated.reason in _BAD_TERMINATED_REASONS or (st.terminated.exit_code or 0) != 0
        ):
            return True, f"Init:{st.terminated.reason or 'Error'}"
        # 재시작이 잦았어도 결국 정상 완료(exit 0)한 init 은 문제가 아니다 — 계속 이상으로 남기지 않는다.
        completed_ok = bool(st and st.terminated and (st.terminated.exit_code or 0) == 0)
        if (cs.restart_count or 0) >= 5 and not completed_ok:
            return True, f"Init:Restarts={cs.restart_count}"
    for cs in (pod.status.container_statuses or []):
        st = cs.state
        if st and st.waiting and st.waiting.reason in _BAD_WAITING_REASONS:
            return True, st.waiting.reason
        if st and st.terminated and st.terminated.reason in _BAD_TERMINATED_REASONS:
            return True, st.terminated.reason
        if (cs.restart_count or 0) >= 5:
            return True, f"Restarts={cs.restart_count}"
    if phase == "Pending":
        # Pending 도 비정상 후보로 (스케줄 안 되거나 PVC pending 등)
        return True, "Pending"
    return False, None


def _is_pod_unhealthy(pod) -> bool:
    return _pod_issue(pod)[0]


_DEFAULT_CONTAINER_ANNOTATION = "kubectl.kubernetes.io/default-container"
# 정상 기동 과정에서도 잠깐 보이는 waiting 사유 — 실패로 치지 않는다.
_BENIGN_WAITING_REASONS = {"ContainerCreating", "PodInitializing"}


def _read_pod(v1: k8s_client.CoreV1Api, pod_name: str, namespace: str):
    """pod 단건 조회 — K8s API 오류 상태를 그대로 매핑한다 (404→404, 403→403, 그 밖은 502)."""
    try:
        return v1.read_namespaced_pod(pod_name, namespace, _request_timeout=_K8S_TIMEOUT)
    except ApiException as e:
        reason = (getattr(e, "reason", None) or "") or str(e)[:200]
        if e.status == 404:
            raise HTTPException(
                status_code=404, detail=f"pod {namespace}/{pod_name} 를 찾을 수 없습니다 ({reason})",
            ) from e
        if e.status == 403:
            raise HTTPException(
                status_code=403,
                detail=f"클러스터가 pod {namespace}/{pod_name} 조회를 거부했습니다 — "
                       f"kubeconfig 계정의 RBAC 를 확인하세요 ({reason})",
            ) from e
        raise HTTPException(
            status_code=502, detail=f"pod 조회 실패 (K8s API {e.status}): {reason}",
        ) from e
    except Exception as e:  # noqa: BLE001 — 연결 실패·타임아웃 등
        raise HTTPException(
            status_code=502, detail=f"pod 조회 실패: {type(e).__name__}: {str(e)[:200]}",
        ) from e


def _state_of(statuses, name: str) -> tuple[Optional[str], int]:
    """컨테이너 상태 요약 — (running|waiting|terminated|None, restart_count)."""
    for st in statuses or []:
        if st.name != name:
            continue
        s = st.state
        state = None
        if s is not None:
            if s.running:
                state = "running"
            elif s.terminated:
                state = "terminated"
            elif s.waiting:
                state = "waiting"
        return state, int(st.restart_count or 0)
    return None, 0


def _container_names(pod) -> list[str]:
    spec = pod.spec
    if spec is None:
        return []
    return [c.name for c in (spec.containers or [])] + [c.name for c in (spec.init_containers or [])]


def _container_failing(cs) -> bool:
    """이 컨테이너 상태가 실패로 보이는가 — 비정상 waiting, 비정상 종료(exit≠0 / OOMKilled 등)."""
    st = cs.state
    if st is None:
        return False
    if st.waiting and (st.waiting.reason or "") not in _BENIGN_WAITING_REASONS:
        return True
    if st.terminated and (
        st.terminated.reason in _BAD_TERMINATED_REASONS or (st.terminated.exit_code or 0) != 0
    ):
        return True
    return False


def _pick_container(pod, *, prefer_failing: bool) -> Optional[str]:
    """pod 에서 기본으로 볼 컨테이너 이름.

    ``kubectl.kubernetes.io/default-container`` 어노테이션(실재하는 컨테이너일 때) →
    (``prefer_failing`` 이면) 실패·재시작 중인 컨테이너 — init 포함, 실패 여부 우선 그다음
    restart_count 큰 것, 동률이면 init 이 먼저(init 실패가 일반 컨테이너 기동을 막으므로).
    재시작했어도 결국 정상 완료(exit 0)한 init 은 후보에서 뺀다(``_pod_issue`` 와 같은 규칙) →
    첫 일반 컨테이너 → 첫 init 컨테이너.
    """
    names = _container_names(pod)
    if not names:
        return None
    annotations = (pod.metadata.annotations or {}) if pod.metadata else {}
    annotated = (annotations.get(_DEFAULT_CONTAINER_ANNOTATION) or "").strip()
    if annotated and annotated in names:
        return annotated

    if prefer_failing and pod.status is not None:
        best: Optional[tuple[tuple[bool, int], str]] = None
        init_statuses = list(pod.status.init_container_statuses or [])
        init_names = {cs.name for cs in init_statuses}
        statuses = init_statuses + list(pod.status.container_statuses or [])
        for cs in statuses:
            if cs.name not in names:
                continue
            failing = _container_failing(cs)
            restarts = int(cs.restart_count or 0)
            if not failing and restarts == 0:
                continue
            st = cs.state
            if (cs.name in init_names and not failing and st is not None and st.terminated
                    and (st.terminated.exit_code or 0) == 0):
                continue
            key = (failing, restarts)
            if best is None or key > best[0]:
                best = (key, cs.name)
        if best is not None:
            return best[1]

    spec = pod.spec
    regular = [c.name for c in ((spec.containers if spec else None) or [])]
    return regular[0] if regular else names[0]


def _build_describe_text(pod, events: list[KubeEventSchema]) -> str:
    lines: list[str] = []
    md = pod.metadata
    sp = pod.spec
    st = pod.status

    lines.append(f"Name:         {md.name}")
    lines.append(f"Namespace:    {md.namespace}")
    if sp and sp.node_name:
        lines.append(f"Node:         {sp.node_name}")
    if md.creation_timestamp:
        lines.append(f"Start Time:   {md.creation_timestamp}")
    if md.labels:
        lines.append("Labels:       " + ",".join(f"{k}={v}" for k, v in list(md.labels.items())[:10]))
    if st:
        lines.append(f"Status:       {st.phase}")
        if st.pod_ip:
            lines.append(f"IP:           {st.pod_ip}")

    if sp and sp.containers:
        lines.append("Containers:")
        for c in sp.containers:
            lines.append(f"  {c.name}:")
            if c.image:
                lines.append(f"    Image:    {c.image}")
            cs = next(
                (s for s in (st.container_statuses or []) if s.name == c.name),
                None,
            )
            if cs:
                state = cs.state
                if state and state.running:
                    lines.append(f"    State:    Running (since {state.running.started_at})")
                elif state and state.waiting:
                    lines.append(f"    State:    Waiting — {state.waiting.reason}")
                    if state.waiting.message:
                        lines.append(f"      Message: {state.waiting.message[:300]}")
                elif state and state.terminated:
                    lines.append(f"    State:    Terminated — {state.terminated.reason} (exit {state.terminated.exit_code})")
                    if state.terminated.message:
                        lines.append(f"      Message: {state.terminated.message[:300]}")
                lines.append(f"    Ready:    {cs.ready}")
                lines.append(f"    Restart:  {cs.restart_count}")

    if events:
        lines.append("Events:")
        for ev in events[-20:]:
            lines.append(f"  {ev.type:8s} {ev.reason:24s} x{ev.count:<4d} {ev.message[:200]}")

    return "\n".join(lines)
