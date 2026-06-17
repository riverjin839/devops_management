"""Cilium BPF / Monitor / Hubble trace endpoints.

세 가지 워크플로우 제공:

1. `GET  /cilium/{cluster_id}/status`              — 설치 상태 점검
2. `GET  /cilium/{cluster_id}/agents`              — agent pod 목록
3. `POST /cilium/{cluster_id}/bpf-inspect`         — BPF map 단발 조회
4. `GET  /cilium/{cluster_id}/monitor/stream`      — cilium-dbg monitor SSE
5. `GET  /cilium/{cluster_id}/hubble/stream`       — hubble observe --follow SSE

SSE 응답은 `text/event-stream` 으로 한 줄씩 `data: <json>\\n\\n` 형식.
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models import Cluster
from app.models.user import User
from app.schemas.cilium_trace import (
    BpfInspectRequest,
    BpfInspectResponse,
    CiliumAgent,
    CiliumAgentsResponse,
    CiliumExecRequest,
    CiliumExecResponse,
    CiliumStatusResponse,
)
from app.services import audit_logger
from app.services.cilium_trace_service import (
    HubbleStreamOptions,
    MonitorOptions,
    bpf_inspect,
    detect_status,
    exec_cilium_command,
    hubble_stream,
    list_agents,
    monitor_stream,
)
from app.services.kubeconfig import ensure_kubeconfig_file

router = APIRouter(prefix="/cilium", tags=["cilium-trace"])


def _get_cluster_kubeconfig(cluster_id: UUID, db: Session) -> tuple[Cluster, str]:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    kc = ensure_kubeconfig_file(cluster)
    if not kc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig 가 없습니다. 먼저 kubeconfig 를 등록하세요.",
        )
    return cluster, kc


# ── Status & agent discovery ────────────────────────────────────────────────

@router.get("/{cluster_id}/status", response_model=CiliumStatusResponse)
def cilium_status(
    cluster_id: UUID,
    namespace: str = Query("kube-system", min_length=1, max_length=63),
    db: Session = Depends(get_db),
):
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    info = detect_status(kc, namespace=namespace)
    return CiliumStatusResponse(cluster_id=cluster_id, **info)


@router.get("/{cluster_id}/agents", response_model=CiliumAgentsResponse)
def cilium_agents(
    cluster_id: UUID,
    namespace: str = Query("kube-system", min_length=1, max_length=63),
    db: Session = Depends(get_db),
):
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    agents, err = list_agents(kc, namespace=namespace)
    return CiliumAgentsResponse(
        cluster_id=cluster_id,
        agents=[CiliumAgent(**a.__dict__) for a in agents],
        error=err,
    )


# ── BPF map inspector (POST 로 body 받음) ───────────────────────────────────

@router.post("/{cluster_id}/bpf-inspect", response_model=BpfInspectResponse)
def cilium_bpf_inspect(
    cluster_id: UUID,
    payload: BpfInspectRequest,
    db: Session = Depends(get_db),
):
    if payload.cluster_id != cluster_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="path cluster_id 와 body cluster_id 가 일치하지 않습니다.",
        )
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    result = bpf_inspect(
        kc,
        kind=payload.kind,
        pod_name=payload.pod_name,
        namespace=payload.namespace,
        endpoint_id=payload.endpoint_id,
    )
    return BpfInspectResponse(
        cluster_id=cluster_id,
        kind=payload.kind,
        **result,
    )


# ── Ad-hoc cilium-dbg 실행 (operator + 감사) ─────────────────────────────────
@router.post("/{cluster_id}/exec-command", response_model=CiliumExecResponse)
def cilium_exec_command(
    cluster_id: UUID,
    payload: CiliumExecRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """선택 pod 에서 임의 ``cilium-dbg <command_args>`` 실행. 목록에 없는 명령용."""
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    result = exec_cilium_command(
        kc,
        pod_name=payload.pod_name,
        namespace=payload.namespace,
        command_args=payload.command_args,
        timeout=payload.timeout,
    )
    audit_logger.record(
        db, action="cilium.exec", actor=actor,
        status="success" if not result.get("error") else "failure",
        target_type="cluster", target_id=str(cluster_id),
        details={"pod": result.get("pod_name"), "command": payload.command_args[:160],
                 "exit_code": result.get("exit_code")},
        request=request,
    )
    return CiliumExecResponse(cluster_id=cluster_id, command_args=payload.command_args, **{
        k: v for k, v in result.items() if k in {"raw", "exit_code", "error", "executed", "pod_name", "duration_ms"}
    })


# ── SSE: cilium monitor stream ───────────────────────────────────────────────

@router.get("/{cluster_id}/monitor/stream")
def cilium_monitor_stream(
    cluster_id: UUID,
    request: Request,
    pod_name: str = Query(..., min_length=1),
    namespace: str = Query("kube-system", min_length=1),
    types: Optional[str] = Query(
        None,
        description="쉼표 구분: drop,trace,capture,debug,recorder,agent,l7",
    ),
    related_to: Optional[str] = Query(None),
    hex_mode: bool = Query(False, alias="hex"),
    db: Session = Depends(get_db),
):
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    type_list = [t.strip() for t in (types or "").split(",") if t.strip()]
    opts = MonitorOptions(
        pod_name=pod_name,
        namespace=namespace,
        types=type_list,
        related_to=related_to,
        hex=hex_mode,
    )

    def generate():
        try:
            for line in monitor_stream(kc, opts):
                # 클라이언트가 끊겼으면 generator close → finally 에서 정리
                yield f"data: {line}\n\n"
        except GeneratorExit:
            return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ── SSE: hubble flow stream ──────────────────────────────────────────────────

@router.get("/{cluster_id}/hubble/stream")
def cilium_hubble_stream(
    cluster_id: UUID,
    request: Request,
    namespace: str = Query("kube-system"),
    relay_service: str = Query("hubble-relay"),
    relay_port: int = Query(80, ge=1, le=65535),
    from_pod: Optional[str] = Query(None),
    to_pod: Optional[str] = Query(None),
    from_namespace: Optional[str] = Query(None),
    to_namespace: Optional[str] = Query(None),
    protocol: Optional[str] = Query(None),
    verdict: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    opts = HubbleStreamOptions(
        namespace=namespace,
        relay_service=relay_service,
        relay_port=relay_port,
        from_pod=from_pod,
        to_pod=to_pod,
        from_namespace=from_namespace,
        to_namespace=to_namespace,
        protocol=protocol,
        verdict=verdict,
    )

    def generate():
        try:
            for line in hubble_stream(kc, opts):
                yield f"data: {line}\n\n"
        except GeneratorExit:
            return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
