"""토폴로지·패킷 흐름 추적 + Hubble 조회 + 원격 tcpdump.

권한(D-169 ①②, 정책 6):
- 본문에 ``cluster_id`` 가 있어 경로 기반 ``enforce_cluster_access`` 가 작동하지 않으므로 엔드포인트마다
  직접 판정한다. 추적·패킷 흐름·Hubble 조회는 **read**(viewer 허용 + 테넌트 판정).
- tcpdump 캡처·인터페이스 조회는 operator + **operate** — 화면이 보낸 ``cluster_id`` 와 host 가 실제로
  속한 클러스터 전부. 어느 클러스터에도 속하지 않는 host 는 허용하고 감사 ``target_type=host``(정책 5).
- tcpdump 캡처(`tcpdump.capture`)·인터페이스 조회(`tcpdump.interfaces`)는 실행 후 결과로 감사(D-170).
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.schemas.topology_trace import (
    HubbleFlowsRequest,
    HubbleFlowsResponse,
    PacketFlowRequest,
    PacketFlowRequestV2,
    PacketFlowResponse,
    PacketFlowResponseV2,
    TcpdumpCaptureRequest,
    TcpdumpCaptureResponse,
    TcpdumpInterfacesRequest,
    TcpdumpInterfacesResponse,
    TopologyTraceRequest,
    TopologyTraceResponse,
)
from app.services import audit_logger
from app.services.cluster_access import (
    cluster_ids_for_hosts,
    require_cluster_access,
    require_clusters_access,
)
from app.services.command_mask import audit_command, audit_error
from app.services.hubble_client import HubbleFilter, fetch_flows
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.ssh_runner import SSHTarget
from app.services.tcpdump_runner import (
    capture as tcpdump_capture,
    list_remote_interfaces,
)
from app.services.topology_trace_service import (
    PacketFlowRequest as PacketFlowReqDC,
    PacketFlowRequestV2 as PacketFlowReqV2DC,
    TopologyTraceService,
    TraceTarget,
    map_k8s_or_trace_error,
)

router = APIRouter(prefix="/topology-trace", tags=["topology-trace"])


def _readable_cluster(db: Session, user: User, cluster_id) -> Cluster:
    """본문 cluster_id → Cluster. 테넌트 read 판정(정책 6) 후 반환, 없으면 404."""
    cid = UUID(str(cluster_id))
    require_cluster_access(db, user, cid, "read")
    cluster = db.query(Cluster).filter(Cluster.id == cid).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return cluster


def _ssh_scope(db: Session, user: User, host: str, cluster_id: UUID | None) -> tuple[str, str]:
    """tcpdump 대상 host 의 operate 판정 + 감사 대상(target_type, target_id) 반환."""
    require_clusters_access(db, user, [cluster_id, *cluster_ids_for_hosts(db, [host])])
    if cluster_id is not None:
        return "cluster", str(cluster_id)
    return "host", host


@router.post("", response_model=TopologyTraceResponse)
def topology_trace(
    payload: TopologyTraceRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cluster = _readable_cluster(db, user, payload.cluster_id)

    service = TopologyTraceService(db=db, cluster=cluster)
    try:
        hops = service.trace(
            namespace=payload.namespace,
            target=TraceTarget(target_type=payload.target_type, target_name=payload.target_name),
        )
    except Exception as e:
        status_code, detail = map_k8s_or_trace_error(e)
        raise HTTPException(status_code=status_code, detail=detail) from e

    return TopologyTraceResponse(
        cluster_id=payload.cluster_id,
        namespace=payload.namespace,
        target_type=payload.target_type,
        target_name=payload.target_name,
        hops=hops,
    )


@router.post("/packet-flow", response_model=PacketFlowResponse)
def packet_flow(
    payload: PacketFlowRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """외부 client 요청에서 내부 pod까지의 E2E 패킷 경로를 추적합니다."""
    cluster = _readable_cluster(db, user, payload.cluster_id)

    service = TopologyTraceService(db=db, cluster=cluster)
    try:
        hops = service.trace_packet_flow(
            PacketFlowReqDC(host=payload.host, path=payload.path, protocol=payload.protocol),
        )
    except Exception as e:
        status_code, detail = map_k8s_or_trace_error(e)
        raise HTTPException(status_code=status_code, detail=detail) from e

    return PacketFlowResponse(
        cluster_id=payload.cluster_id,
        host=payload.host,
        path=payload.path,
        protocol=payload.protocol,
        hops=hops,
    )


@router.post("/packet-flow-v2", response_model=PacketFlowResponseV2)
def packet_flow_v2(
    payload: PacketFlowRequestV2,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """v2 — CiliumNetworkPolicy / KubernetesNetworkPolicy / Identity 해석 포함.
    direction=north-south|east-west 지원.
    """
    cluster = _readable_cluster(db, user, payload.cluster_id)

    service = TopologyTraceService(db=db, cluster=cluster)
    try:
        hops = service.trace_v2(PacketFlowReqV2DC(
            direction=payload.direction,
            source=payload.source,
            destination=payload.destination,
            protocol=payload.protocol,
            port=payload.port,
            path=payload.path,
        ))
    except Exception as e:
        status_code, detail = map_k8s_or_trace_error(e)
        raise HTTPException(status_code=status_code, detail=detail) from e

    return PacketFlowResponseV2(
        cluster_id=payload.cluster_id,
        direction=payload.direction,
        source=payload.source,
        destination=payload.destination,
        protocol=payload.protocol,
        port=payload.port,
        path=payload.path,
        hops=hops,
    )


@router.post("/hubble-flows", response_model=HubbleFlowsResponse)
def hubble_flows(
    payload: HubbleFlowsRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cilium Hubble Relay 에서 최근 flow 를 조회.

    전제: 클러스터에 Hubble Relay(svc/hubble-relay) 배포. 백엔드 이미지에
    kubectl + hubble CLI 설치. 없으면 error 필드에 이유 채워서 반환.
    """
    cluster = _readable_cluster(db, user, payload.cluster_id)

    kc = ensure_kubeconfig_file(cluster)
    if not kc:
        return HubbleFlowsResponse(
            cluster_id=payload.cluster_id, flows=[], count=0,
            error="kubeconfig 가 없습니다. 먼저 kubeconfig 를 등록하세요.",
        )

    result = fetch_flows(
        kubeconfig_path=kc,
        filt=HubbleFilter(
            from_pod=payload.from_pod, to_pod=payload.to_pod,
            from_namespace=payload.from_namespace, to_namespace=payload.to_namespace,
            to_service=payload.to_service, protocol=payload.protocol,
            verdict=payload.verdict, since_seconds=payload.since_seconds,
            limit=payload.limit,
        ),
        hubble_ns=payload.hubble_namespace,
        hubble_svc=payload.hubble_service,
        hubble_port=payload.hubble_port,
    )
    return HubbleFlowsResponse(
        cluster_id=payload.cluster_id,
        flows=result["flows"],
        count=result.get("count", 0),
        error=result.get("error"),
        executed=result.get("executed"),
    )


@router.post("/tcpdump", response_model=TcpdumpCaptureResponse)
def tcpdump_run(
    payload: TcpdumpCaptureRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """선택한 원격 호스트(노드)에 SSH 로 붙어 tcpdump 를 1회 수행.

    - 자격증명은 요청에만 존재, DB 저장 안 함 (bulk-exec 와 동일 패턴).
    - BPF 필터는 shlex.quote 로 감싸서 전달.
    - 화면이 보낸 ``cluster_id`` 와 host 소속 클러스터 전부의 operate 를 본다(D-169 ②).
    """
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=422,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )
    target_type, target_id = _ssh_scope(db, actor, payload.host, payload.cluster_id)

    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    # 감사는 try/finally 로 정확히 1행 — 캡처 도중 예외도 failure(마스킹한 예외 요약)로 남긴다.
    result = None
    exc: BaseException | None = None
    try:
        result = tcpdump_capture(
            target,
            interface=payload.interface,
            bpf_filter=payload.bpf_filter,
            duration_sec=payload.duration_sec,
            packet_count=payload.packet_count,
            use_sudo=payload.use_sudo,
            connect_timeout=payload.connect_timeout,
        )
    except BaseException as e:  # noqa: BLE001 — 감사 후 그대로 다시 올린다
        exc = e
        raise
    finally:
        if result is not None:
            details = {
                "host": payload.host,
                "interface": payload.interface,
                "command": audit_command(result.executed),
                "result": result.status,
                "exit_code": result.exit_code,
                "duration_ms": result.duration_ms,
                "packets": len(result.packets),
                "error": audit_command(result.error, 200) or None,
            }
        else:
            details = {
                "host": payload.host,
                "interface": payload.interface,
                "command": None,
                "result": "exception",
                "exit_code": None,
                "duration_ms": None,
                "packets": 0,
                "error": audit_error(exc) or "실행이 끝나기 전에 중단됨",
            }
        audit_logger.record(
            db, action="tcpdump.capture", actor=actor,
            status="success" if result is not None and result.status == "ok" else "failure",
            target_type=target_type, target_id=target_id,
            details=details,
            request=request,
        )
    return TcpdumpCaptureResponse(**result.to_dict())


@router.post("/tcpdump/interfaces", response_model=TcpdumpInterfacesResponse)
def tcpdump_interfaces(
    payload: TcpdumpInterfacesRequest,
    request: Request,
    cluster_id: UUID | None = Query(None, description="화면이 선택한 클러스터(선택) — 테넌트 판정에 함께 쓴다"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """원격 호스트의 네트워크 인터페이스 목록 조회 (`ip -o link show`)."""
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=422,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )
    target_type, target_id = _ssh_scope(db, actor, payload.host, cluster_id)
    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    ifaces: list | None = None
    exc: BaseException | None = None
    try:
        ifaces = list_remote_interfaces(target, connect_timeout=payload.connect_timeout)
    except BaseException as e:  # noqa: BLE001 — 감사 후 그대로 다시 올린다(정확히 1행)
        exc = e
        raise
    finally:
        details = {"host": payload.host, "command": "ip -o link show", "count": len(ifaces or [])}
        if exc is not None:
            details["error"] = audit_error(exc)
        audit_logger.record(
            db, action="tcpdump.interfaces", actor=actor,
            # list_remote_interfaces 는 실패를 빈 목록으로 돌려준다 — 빈 목록 = 실패로 본다.
            status="success" if ifaces else "failure",
            target_type=target_type, target_id=target_id,
            details=details,
            request=request,
        )
    return TcpdumpInterfacesResponse(host=payload.host, interfaces=ifaces)
