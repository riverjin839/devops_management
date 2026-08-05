"""Bulk SSH/SCP 엔드포인트 + 클러스터 노드 목록 조회."""
import asyncio
import os
import time
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from kubernetes import client as k8s_client, config as k8s_config
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.bulk_exec import (
    BulkExecRequest, BulkExecResponse, BulkExecResultItem,
    FetchFileRequest, FetchFileResponse,
    NodeListResponse, NodeSummary,
)
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.script_wrap import wrap_script_for_language
from app.services.ssh_runner import SSHTarget, fetch_remote_file, run_bulk
from app.services import audit_logger

router = APIRouter(tags=["bulk-exec"])


# ── Node list (for target selection UI) ─────────────────────────────────────

@router.get("/clusters/{cluster_id}/node-list", response_model=NodeListResponse)
def list_cluster_nodes(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터의 노드 목록을 반환.

    SSH 일괄 실행 대상을 선택하기 위한 용도. kubeconfig 로 k8s API 에 붙어
    노드 이름 + InternalIP + roles + 상태를 가져온다.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    kc_path = ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig 가 없습니다. 먼저 kubeconfig 를 등록하세요.",
        )

    try:
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
        v1 = k8s_client.CoreV1Api(api_client)
        nodes = v1.list_node(_request_timeout=10)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"노드 조회 실패: {str(e)[:200]}",
        )

    master_role_keys = ("node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master")
    items: list[NodeSummary] = []
    for n in nodes.items:
        labels = n.metadata.labels or {}
        roles: list[str] = []
        if any(k in labels for k in master_role_keys):
            roles.append("control-plane")
        # node-role.kubernetes.io/<role>=""
        for k in labels:
            if k.startswith("node-role.kubernetes.io/") and k not in master_role_keys:
                roles.append(k.split("/", 1)[1])
        if not roles:
            roles.append("worker")

        internal_ip: str | None = None
        external_ip: str | None = None
        for addr in (n.status.addresses or []):
            if addr.type == "InternalIP" and not internal_ip:
                internal_ip = addr.address
            elif addr.type == "ExternalIP" and not external_ip:
                external_ip = addr.address

        ready = False
        for c in (n.status.conditions or []):
            if c.type == "Ready":
                ready = (c.status == "True")
                break

        ni = n.status.node_info
        items.append(NodeSummary(
            name=n.metadata.name,
            internal_ip=internal_ip,
            external_ip=external_ip,
            roles=sorted(set(roles)),
            ready=ready,
            os=getattr(ni, "os_image", None),
            kubelet_version=getattr(ni, "kubelet_version", None),
        ))

    return NodeListResponse(
        cluster_id=cluster_id,
        cluster_name=cluster.name,
        nodes=sorted(items, key=lambda x: x.name),
    )


# ── Bulk Exec ────────────────────────────────────────────────────────────────

@router.post("/bulk-exec/run", response_model=BulkExecResponse)
async def bulk_exec_run(
    payload: BulkExecRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """여러 호스트에 SSH/SCP 일괄 실행.

    인증 정보는 요청에만 존재하고 저장되지 않는다.
    """
    audit_logger.record(
        db,
        action="bulk_exec.run",
        actor=actor,
        status="success",
        target_type="bulk_exec",
        details={
            "action": payload.action,
            "target_count": len(payload.targets or []),
            "language": payload.language,
        },
        request=request,
    )
    if payload.action == "ssh" and not (payload.command and payload.command.strip()):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="command 는 필수입니다 (ssh 모드).")
    if payload.action == "scp":
        if not (payload.scp_content is not None and (payload.scp_remote_path or "").strip()):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="scp_content / scp_remote_path 는 필수입니다.")

    if not payload.password and not payload.private_key:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="password 또는 private_key 중 하나는 필수입니다.")

    targets = [
        SSHTarget(
            host=t.host,
            port=t.port or payload.port,
            username=t.username or payload.username,
            password=payload.password,
            private_key=payload.private_key,
            name=t.name,
            # UUID -> str (SSHTarget 는 str 보존; 응답 시 다시 UUID 로 변환)
            cluster_id=str(t.cluster_id) if t.cluster_id else None,
            cluster_name=t.cluster_name,
        )
        for t in payload.targets
    ]

    command = payload.command
    if payload.action == "ssh" and payload.language == "python" and command:
        command = wrap_script_for_language(command, "python")

    start = time.monotonic()
    results = await run_bulk(
        targets,
        action=payload.action,
        command=command,
        scp_content=(payload.scp_content.encode("utf-8") if payload.scp_content is not None else None),
        scp_remote_path=payload.scp_remote_path,
        mode=payload.mode,
        connect_timeout=payload.connect_timeout,
        exec_timeout=payload.exec_timeout,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
    )
    total_elapsed = int((time.monotonic() - start) * 1000)

    items = [BulkExecResultItem(**r.to_dict()) for r in results]
    ok = sum(1 for r in results if r.status == "ok")
    err = len(results) - ok

    return BulkExecResponse(
        action=payload.action,
        mode=payload.mode,
        total=len(results),
        ok_count=ok,
        error_count=err,
        total_duration_ms=total_elapsed,
        results=items,
    )


# ── SCP: 다른 노드에서 불러오기 ───────────────────────────────────────────────

@router.post("/bulk-exec/fetch-file", response_model=FetchFileResponse)
async def bulk_exec_fetch_file(
    payload: FetchFileRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """SCP 업로드 내용 입력을 다른 노드에 이미 있는 텍스트 파일로 채운다.

    파일을 직접 다른 노드로 복사하는 게 아니라, 내용을 화면으로 가져와 검토·수정한
    뒤 (필요하면 다시) 여러 노드에 업로드하는 용도. 인증 정보는 요청에만 존재하고
    저장되지 않는다(bulk_exec_run 과 동일 원칙).
    """
    audit_logger.record(
        db,
        action="bulk_exec.fetch_file",
        actor=actor,
        status="success",
        target_type="bulk_exec",
        details={"host": payload.host, "remote_path": payload.remote_path},
        request=request,
    )
    if not payload.password and not payload.private_key:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="password 또는 private_key 중 하나는 필수입니다.")

    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    result = await asyncio.to_thread(
        fetch_remote_file, target, payload.remote_path, payload.connect_timeout,
    )
    return FetchFileResponse(
        host=result.host,
        status=result.status,
        content=result.stdout,
        size=len(result.stdout.encode("utf-8")) if result.status == "ok" else 0,
        error=result.error,
    )
