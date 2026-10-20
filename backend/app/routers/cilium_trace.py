"""Cilium BPF / Monitor / Hubble trace endpoints.

세 가지 워크플로우 제공:

1. `GET  /cilium/{cluster_id}/status`              — 설치 상태 점검
2. `GET  /cilium/{cluster_id}/agents`              — agent pod 목록
3. `POST /cilium/{cluster_id}/bpf-inspect`         — BPF map 단발 조회
4. `GET  /cilium/{cluster_id}/monitor/stream`      — cilium-dbg monitor SSE
5. `GET  /cilium/{cluster_id}/hubble/stream`       — hubble observe --follow SSE

SSE 응답은 `text/event-stream` 으로 한 줄씩 `data: <json>\\n\\n` 형식.

직접 명령(`POST /cilium/{cluster_id}/exec-command`)은 서버 읽기 전용 allowlist
(`services/cilium_trace_service.CILIUM_READONLY_COMMANDS`, 정책 2)에 맞으면 operator, 목록 밖은
admin 만 실행한다. 허용 목록은 `GET /cilium/{cluster_id}/exec-command/allowlist` 로 화면에 노출한다.
실행·거부 모두 `cilium.exec` 감사(명령은 마스킹 후 500자).
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
    BpfDownloadRequest,
    BpfInspectRequest,
    BpfInspectResponse,
    CiliumAgent,
    CiliumAgentsResponse,
    CiliumExecRequest,
    CiliumExecResponse,
    CiliumStatusResponse,
)
from app.services import audit_logger
from app.services.command_mask import audit_command
from app.services.cilium_trace_service import (
    HubbleStreamOptions,
    MonitorOptions,
    bpf_inspect,
    bpf_raw_stream,
    cilium_readonly_command_labels,
    detect_status,
    exec_cilium_command,
    is_cilium_readonly_command,
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


@router.post("/{cluster_id}/bpf-inspect/download")
def cilium_bpf_download(
    cluster_id: UUID,
    payload: BpfDownloadRequest,
    db: Session = Depends(get_db),
):
    """BPF 맵 원본을 파일로 **흘려보낸다** — 조회 응답(`bpf-inspect`)은 JSON 이면 원본을 싣지 않으므로 원본이
    필요할 때 이걸 쓴다. 출력을 워커 메모리에 모으지 않는다(`bpf_raw_stream`)."""
    if payload.cluster_id != cluster_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="path cluster_id 와 body cluster_id 가 일치하지 않습니다.",
        )
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    pod, executed, stream, err = bpf_raw_stream(
        kc, payload.kind, as_json=payload.format == "json", pod_name=payload.pod_name,
        namespace=payload.namespace, endpoint_id=payload.endpoint_id,
    )
    if err or stream is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=err or "실행할 수 없습니다.")
    ext, media = ("json", "application/json") if payload.format == "json" else ("txt", "text/plain; charset=utf-8")
    filename = f"cilium-bpf-{payload.kind}-{pod}.{ext}"
    return StreamingResponse(stream, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Bpf-Pod": pod,
        # gzip 미들웨어가 스트림을 버퍼링하지 않도록(다운로드 진행이 바로 보이게)
        "Content-Encoding": "identity",
    })


# ── Ad-hoc cilium-dbg 실행 (operator + 읽기 전용 allowlist + 감사) ──────────────
@router.get("/{cluster_id}/exec-command/allowlist")
def cilium_exec_allowlist(cluster_id: UUID):
    """직접 명령의 읽기 전용 허용 목록 — 목록 밖 명령은 admin 만 실행할 수 있다(정책 2)."""
    return {"cluster_id": str(cluster_id), "commands": cilium_readonly_command_labels(),
            "admin_only_outside": True}


@router.post("/{cluster_id}/exec-command", response_model=CiliumExecResponse)
def cilium_exec_command(
    cluster_id: UUID,
    payload: CiliumExecRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """선택 pod 에서 ``cilium-dbg <command_args>`` 실행. 목록에 없는 명령용.

    읽기 전용 allowlist 밖 명령은 admin 이 아니면 403(실행 전 차단, 감사 ``status=failure``).
    """
    readonly = is_cilium_readonly_command(payload.command_args)
    is_admin = actor.role == "admin"
    if not readonly and not is_admin:
        audit_logger.record(
            db, action="cilium.exec", actor=actor, status="failure",
            target_type="cluster", target_id=str(cluster_id),
            details={"pod": payload.pod_name, "command": audit_command(payload.command_args),
                     "readonly": False, "reason": "not_in_readonly_allowlist"},
            request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(f"읽기 전용 허용 목록 밖의 cilium-dbg 명령은 admin 만 실행할 수 있습니다 "
                    f"(현재: {actor.role}). 허용: {', '.join(cilium_readonly_command_labels())}"),
        )
    _, kc = _get_cluster_kubeconfig(cluster_id, db)
    result = exec_cilium_command(
        kc,
        pod_name=payload.pod_name,
        namespace=payload.namespace,
        command_args=payload.command_args,
        timeout=payload.timeout,
        allow_any=is_admin,
    )
    audit_logger.record(
        db, action="cilium.exec", actor=actor,
        status="success" if not result.get("error") else "failure",
        target_type="cluster", target_id=str(cluster_id),
        details={"pod": result.get("pod_name"), "command": audit_command(payload.command_args),
                 "readonly": readonly, "exit_code": result.get("exit_code"),
                 "duration_ms": result.get("duration_ms"),
                 "error": audit_command(result.get("error"), 200) or None},
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
            "Content-Encoding": "identity",
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
            "Content-Encoding": "identity",
        },
    )
