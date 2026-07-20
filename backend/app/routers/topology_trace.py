from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
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


@router.post("", response_model=TopologyTraceResponse)
def topology_trace(payload: TopologyTraceRequest, db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == UUID(str(payload.cluster_id))).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

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
def packet_flow(payload: PacketFlowRequest, db: Session = Depends(get_db)):
    """외부 client 요청에서 내부 pod까지의 E2E 패킷 경로를 추적합니다."""
    cluster = db.query(Cluster).filter(Cluster.id == UUID(str(payload.cluster_id))).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

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
def packet_flow_v2(payload: PacketFlowRequestV2, db: Session = Depends(get_db)):
    """v2 — CiliumNetworkPolicy / KubernetesNetworkPolicy / Identity 해석 포함.
    direction=north-south|east-west 지원.
    """
    cluster = db.query(Cluster).filter(Cluster.id == UUID(str(payload.cluster_id))).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

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
def hubble_flows(payload: HubbleFlowsRequest, db: Session = Depends(get_db)):
    """Cilium Hubble Relay 에서 최근 flow 를 조회.

    전제: 클러스터에 Hubble Relay(svc/hubble-relay) 배포. 백엔드 이미지에
    kubectl + hubble CLI 설치. 없으면 error 필드에 이유 채워서 반환.
    """
    cluster = db.query(Cluster).filter(Cluster.id == UUID(str(payload.cluster_id))).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

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
    _: User = Depends(require_operator),
):
    """선택한 원격 호스트(노드)에 SSH 로 붙어 tcpdump 를 1회 수행.

    - 자격증명은 요청에만 존재, DB 저장 안 함 (bulk-exec 와 동일 패턴).
    - BPF 필터는 shlex.quote 로 감싸서 전달.
    """
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=422,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    result = tcpdump_capture(
        target,
        interface=payload.interface,
        bpf_filter=payload.bpf_filter,
        duration_sec=payload.duration_sec,
        packet_count=payload.packet_count,
        use_sudo=payload.use_sudo,
        connect_timeout=payload.connect_timeout,
    )
    return TcpdumpCaptureResponse(**result.to_dict())


@router.post("/tcpdump/interfaces", response_model=TcpdumpInterfacesResponse)
def tcpdump_interfaces(
    payload: TcpdumpInterfacesRequest,
    _: User = Depends(require_operator),
):
    """원격 호스트의 네트워크 인터페이스 목록 조회 (`ip -o link show`)."""
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=422,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )
    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    ifaces = list_remote_interfaces(target, connect_timeout=payload.connect_timeout)
    return TcpdumpInterfacesResponse(host=payload.host, interfaces=ifaces)
