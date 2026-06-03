"""
Incident analysis router — POST /analyze/incident

Accepts a pod incident context and returns an LLM-generated (or rule-based) analysis.
Backend is selected at runtime via the ANALYZER_BACKEND environment variable.

Adds cluster/namespace/pod browsing endpoints so the UI can drill down from a
selected cluster instead of forcing the user to paste pod info manually.
"""

import fnmatch
import logging
import os
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from kubernetes import client as k8s_client, config as k8s_config
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.services.analyzers import (
    AnalysisResult,
    ArgocdStatus,
    IncidentContext,
    KubeEvent,
    RelatedWorkload,
    get_analyzer,
)
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

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
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
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


class IncidentContextSchema(BaseModel):
    pod_name: str = Field(..., min_length=1)
    namespace: str = Field(..., min_length=1)
    timestamp: str
    events: list[KubeEventSchema] = []
    current_logs: str = ""
    describe_output: str = ""
    previous_logs: Optional[str] = None
    related_workload: Optional[RelatedWorkloadSchema] = None
    argocd_status: Optional[ArgocdStatusSchema] = None


# ── Response schemas ──────────────────────────────────────────────────

class AnalysisResultSchema(BaseModel):
    severity: Literal["critical", "warning", "info"]
    root_cause: str
    suggested_actions: list[str]
    related_runbooks: list[str] = []
    confidence: float
    analyzed_by: Literal["claude", "local_llm", "rule_based"]
    analyzed_at: str


class AnalyzeResponse(BaseModel):
    status: Literal["ok", "error"]
    result: Optional[AnalysisResultSchema] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    backend: str
    available: bool


# ── Endpoints ─────────────────────────────────────────────────────────

@router.post("/incident", response_model=AnalyzeResponse)
async def analyze_incident(body: IncidentContextSchema):
    """Analyze a Kubernetes pod incident and return structured insights."""
    analyzer = get_analyzer()

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
        result: AnalysisResult = await analyzer.analyze(ctx)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Analyzer error: {exc}") from exc

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
        ),
    )


@router.get("/health", response_model=HealthResponse)
async def analyzer_health():
    """Check whether the configured analyzer backend is reachable."""
    backend = os.getenv("ANALYZER_BACKEND", "rule_based")
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


@router.get("/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod_name}/logs/stream")
def stream_pod_logs(
    cluster_id: UUID,
    namespace: str,
    pod_name: str,
    container: Optional[str] = None,
    tail_lines: int = 200,
    follow: bool = True,
    previous: bool = False,
    db: Session = Depends(get_db),
):
    """파드 로그 SSE 스트림 (읽기전용). follow=True 면 실시간 tail.

    OpenLens 류의 follow 로그 뷰어용. 인증된 fetch 로 ``text/event-stream`` 소비.
    멀티컨테이너 파드는 ``container`` 미지정 시 에러 → 컨테이너명을 지정한다.
    """
    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)

    def _gen():
        resp = None
        try:
            resp = v1.read_namespaced_pod_log(
                name=pod_name,
                namespace=namespace,
                container=container or None,
                follow=follow,
                tail_lines=max(1, min(tail_lines, 5000)),
                previous=previous,
                timestamps=False,
                _preload_content=False,
            )
            for chunk in resp.stream(amt=None, decode_content=True):
                text = (
                    chunk.decode("utf-8", errors="replace")
                    if isinstance(chunk, (bytes, bytearray))
                    else str(chunk)
                )
                for line in text.splitlines():
                    yield f"data: {line}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: [stream error] {str(e)[:200]}\n\n"
        finally:
            try:
                if resp is not None:
                    resp.release_conn()
            except Exception:  # noqa: BLE001
                pass

    return StreamingResponse(_gen(), media_type="text/event-stream")


@router.get(
    "/clusters/{cluster_id}/namespaces/{namespace}/pods/{pod_name}/context",
    response_model=IncidentContextFetchResponse,
)
def fetch_incident_context(
    cluster_id: UUID,
    namespace: str,
    pod_name: str,
    tail_lines: int = 200,
    db: Session = Depends(get_db),
):
    """선택된 pod 의 logs / events / describe 를 한 번에 수집.

    UI 에서 "자동 채우기" 버튼으로 호출 → 그대로 ``/analyze/incident`` 에 보내면 됨.
    """
    if tail_lines < 1 or tail_lines > 5000:
        raise HTTPException(status_code=422, detail="tail_lines 는 1~5000 사이여야 합니다")

    cluster = _require_cluster(cluster_id, db)
    v1 = _get_core_v1(cluster)

    # 1) Pod object — describe 와 컨테이너 목록을 위해 필요
    try:
        pod = v1.read_namespaced_pod(pod_name, namespace, _request_timeout=_K8S_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"pod 조회 실패: {str(e)[:200]}") from e

    # 2) Logs — 첫 번째 컨테이너 우선. previous 는 best-effort.
    container = (pod.spec.containers[0].name if pod.spec.containers else None)
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
    """Pod 의 비정상 여부와 사유 한 줄."""
    phase = pod.status.phase or ""
    if phase in ("Failed", "Unknown"):
        return True, phase
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
