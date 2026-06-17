import json
import subprocess
import time
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Header
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.topology_audit_log import TopologyAuditLog
from app.schemas.infra_node import (
    InfraNodeCreate,
    InfraNodeUpdate,
    InfraNodeResponse,
    InfraNodeListResponse,
    NodeVerifyResult,
    SyncResult,
)
from app.services.deep_check_service import DeepCheckService

router = APIRouter(prefix="/infra-nodes", tags=["infra-nodes"])

# sync 직후 자동검증할 신규 노드 최대 수 (지연 상한).
_SYNC_VERIFY_MAX = 25

_KUBECTL_TIMEOUT = 30
_SYNC_RETRY_MAX = 2
SCOPE_READ = "infra_topology.read"
SCOPE_EDIT = "infra_topology.edit"
SCOPE_SYNC = "infra_topology.sync"
SCOPE_FORCE_FIX = "infra_topology.force_fix"


def _serialize_node(node: InfraNode | None) -> dict | None:
    if node is None:
        return None
    return {
        "id": str(node.id),
        "cluster_id": str(node.cluster_id),
        "hostname": node.hostname,
        "rack_name": node.rack_name,
        "ip_address": node.ip_address,
        "role": node.role,
        "cpu_cores": node.cpu_cores,
        "ram_gb": node.ram_gb,
        "disk_gb": node.disk_gb,
        "os_info": node.os_info,
        "switch_name": node.switch_name,
        "notes": node.notes,
        "auto_synced": node.auto_synced,
        "version": node.version,
        "updated_at": node.updated_at.isoformat() if node.updated_at else None,
    }


def _require_scope(required_scope: str):
    def _checker(x_api_scopes: str | None = Header(default=None)):
        raw_scopes = x_api_scopes or ""
        scopes = {s.strip() for s in raw_scopes.split(",") if s.strip()}
        if required_scope not in scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required scope: {required_scope}",
            )
    return _checker


def _audit(
    db: Session,
    cluster_id: UUID,
    *,
    entity_type: str,
    entity_id: str | None,
    action: str,
    scope: str,
    status_text: str,
    reason: str | None = None,
    before_data: dict | None = None,
    after_data: dict | None = None,
):
    db.add(
        TopologyAuditLog(
            cluster_id=cluster_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            scope=scope,
            status=status_text,
            reason=reason,
            before_data=before_data,
            after_data=after_data,
        )
    )


@router.get("", response_model=InfraNodeListResponse)
def list_infra_nodes(
    cluster_id: UUID | None = None,
    rack_name: str | None = None,
    _=Depends(_require_scope(SCOPE_READ)),
    db: Session = Depends(get_db),
):
    q = db.query(InfraNode)
    if cluster_id:
        q = q.filter(InfraNode.cluster_id == cluster_id)
    if rack_name:
        q = q.filter(InfraNode.rack_name == rack_name)
    nodes = q.order_by(InfraNode.rack_name, InfraNode.hostname).all()
    return InfraNodeListResponse(data=nodes, total=len(nodes))


@router.get("/{node_id}", response_model=InfraNodeResponse)
def get_infra_node(node_id: UUID, _=Depends(_require_scope(SCOPE_READ)), db: Session = Depends(get_db)):
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    return node


@router.post("", response_model=InfraNodeResponse, status_code=status.HTTP_201_CREATED)
def create_infra_node(payload: InfraNodeCreate, _=Depends(_require_scope(SCOPE_EDIT)), db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    payload_data = payload.model_dump()
    if not payload_data.get("hostname") and cluster.hostname:
        payload_data["hostname"] = cluster.hostname
    if not payload_data.get("ip_address") and cluster.first_host:
        payload_data["ip_address"] = cluster.first_host
    if not payload_data.get("notes") and cluster.description:
        payload_data["notes"] = f"[cluster:{cluster.name}] {cluster.description}"
    node = InfraNode(**payload_data)
    db.add(node)
    _audit(
        db,
        payload.cluster_id,
        entity_type="node",
        entity_id=None,
        action="create",
        scope=SCOPE_EDIT,
        status_text="success",
        after_data=payload.model_dump(mode="json"),
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="hostname already exists in this cluster",
        )
    db.refresh(node)
    return node


@router.put("/{node_id}", response_model=InfraNodeResponse)
def update_infra_node(node_id: UUID, payload: InfraNodeUpdate, _=Depends(_require_scope(SCOPE_EDIT)), db: Session = Depends(get_db)):
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    if node.version != payload.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Optimistic lock conflict",
                "expected_version": node.version,
                "current_updated_at": node.updated_at.isoformat() if node.updated_at else None,
            },
        )
    before_data = _serialize_node(node)
    patch_data = payload.model_dump(exclude_unset=True, exclude={"version"})
    for k, v in patch_data.items():
        setattr(node, k, v)
    node.version += 1
    _audit(
        db,
        node.cluster_id,
        entity_type="node",
        entity_id=str(node.id),
        action="update",
        scope=SCOPE_EDIT,
        status_text="success",
        before_data=before_data,
        after_data=_serialize_node(node),
    )
    db.commit()
    db.refresh(node)
    return node


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_infra_node(node_id: UUID, _=Depends(_require_scope(SCOPE_FORCE_FIX)), db: Session = Depends(get_db)):
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    before_data = _serialize_node(node)
    _audit(
        db,
        node.cluster_id,
        entity_type="node",
        entity_id=str(node.id),
        action="delete",
        scope=SCOPE_FORCE_FIX,
        status_text="success",
        before_data=before_data,
    )
    db.delete(node)
    db.commit()
    return None


def _verify_node_health(
    db: Session, cluster: Cluster, hostname: str, node_id: UUID | None = None
) -> NodeVerifyResult:
    """node_health deep check 를 단일 노드에 대해 실행하고 NodeVerifyResult 로 매핑.

    fail-safe: 어떤 오류도 500 으로 새지 않고 status='error' 결과로 반환한다.
    """
    try:
        res = DeepCheckService(db).run_node_health_once(cluster, node_name=hostname)
        nodes = (res.get("details") or {}).get("nodes") or []
        ok = bool(nodes[0]["ok"]) if nodes else False
        return NodeVerifyResult(
            hostname=hostname,
            status=res.get("status", "pending"),
            message=res.get("message", ""),
            ok=ok,
            node_id=node_id,
            details=res.get("details") or {},
            steps=res.get("steps") or [],
            step_plan=res.get("step_plan") or [],
            duration_ms=int(res.get("duration_ms") or 0),
        )
    except Exception as e:  # noqa: BLE001
        return NodeVerifyResult(
            hostname=hostname, status="error", ok=False, node_id=node_id,
            message=f"검증 실패: {str(e)[:200]}",
        )


@router.post("/{node_id}/verify", response_model=NodeVerifyResult)
def verify_infra_node(node_id: UUID, _=Depends(_require_scope(SCOPE_SYNC)), db: Session = Depends(get_db)):
    """노드 추가 검증 — 해당 노드의 Ready/Pressure/Taint/Allocatable/CNI·kube-proxy 를 점검."""
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    cluster = db.query(Cluster).filter(Cluster.id == node.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    result = _verify_node_health(db, cluster, node.hostname, node_id=node.id)
    _audit(
        db,
        node.cluster_id,
        entity_type="node",
        entity_id=str(node.id),
        action="verify",
        scope=SCOPE_SYNC,
        status_text=result.status,
        after_data={"status": result.status, "ok": result.ok, "message": result.message},
    )
    db.commit()
    return result


@router.post("/sync/{cluster_id}", response_model=SyncResult)
def sync_infra_nodes_from_k8s(cluster_id: UUID, _=Depends(_require_scope(SCOPE_SYNC)), db: Session = Depends(get_db)):
    """kubectl get nodes 를 통해 클러스터 노드 정보를 자동 수집하고 upsert"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    # Build kubectl command
    cmd = ["kubectl", "get", "nodes", "-o", "json"]
    if cluster.kubeconfig_path:
        cmd = ["kubectl", "--kubeconfig", cluster.kubeconfig_path] + cmd[1:]

    result = None
    retries = 0
    for attempt in range(_SYNC_RETRY_MAX + 1):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=_KUBECTL_TIMEOUT,
            )
            if result.returncode == 0:
                break
        except subprocess.TimeoutExpired:
            result = None
        except FileNotFoundError:
            _audit(
                db,
                cluster_id,
                entity_type="node",
                entity_id=None,
                action="sync",
                scope=SCOPE_SYNC,
                status_text="failed",
                reason="kubectl not found",
            )
            db.commit()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="kubectl not found")
        retries = attempt + 1
        if attempt < _SYNC_RETRY_MAX:
            time.sleep(1.0 * (attempt + 1))

    if result is None or result.returncode != 0:
        reason = "kubectl timed out" if result is None else f"kubectl error: {result.stderr[:200]}"
        _audit(
            db,
            cluster_id,
            entity_type="node",
            entity_id=None,
            action="sync",
            scope=SCOPE_SYNC,
            status_text="failed",
            reason=reason,
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY if result else status.HTTP_504_GATEWAY_TIMEOUT,
            detail=reason,
        )

    try:
        k8s_data = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid kubectl output")

    created_count = 0
    updated_count = 0
    errors: list[str] = []
    created_hostnames: list[str] = []

    for item in k8s_data.get("items", []):
        try:
            # Extract hostname
            hostname = item.get("metadata", {}).get("name", "")
            if not hostname:
                errors.append("missing hostname in kubectl item")
                continue

            # Determine role from labels
            labels = item.get("metadata", {}).get("labels", {})
            if "node-role.kubernetes.io/master" in labels or "node-role.kubernetes.io/control-plane" in labels:
                role = "master"
            else:
                role = "worker"

            # Extract capacity (CPU, Memory)
            capacity = item.get("status", {}).get("capacity", {})
            cpu_str = capacity.get("cpu", "")
            mem_str = capacity.get("memory", "")  # e.g. "16Gi" or "16384Ki"

            cpu_cores = None
            if cpu_str:
                try:
                    cpu_cores = int(cpu_str)
                except ValueError:
                    pass

            ram_gb = None
            if mem_str:
                try:
                    if mem_str.endswith("Ki"):
                        ram_gb = round(int(mem_str[:-2]) / (1024 * 1024))
                    elif mem_str.endswith("Mi"):
                        ram_gb = round(int(mem_str[:-2]) / 1024)
                    elif mem_str.endswith("Gi"):
                        ram_gb = int(mem_str[:-2])
                    else:
                        ram_gb = round(int(mem_str) / (1024 * 1024 * 1024))
                except ValueError:
                    pass

            # Extract internal IP
            ip_address = None
            for addr in item.get("status", {}).get("addresses", []):
                if addr.get("type") == "InternalIP":
                    ip_address = addr.get("address")
                    break

            # OS info
            node_info = item.get("status", {}).get("nodeInfo", {})
            os_info = node_info.get("osImage", None)

            # Upsert by hostname
            existing = db.query(InfraNode).filter(
                InfraNode.cluster_id == cluster_id,
                InfraNode.hostname == hostname,
            ).first()

            if existing:
                existing.role = role
                if cpu_cores is not None:
                    existing.cpu_cores = cpu_cores
                if ram_gb is not None:
                    existing.ram_gb = ram_gb
                if ip_address:
                    existing.ip_address = ip_address
                if os_info:
                    existing.os_info = os_info
                existing.auto_synced = True
                existing.version += 1
                updated_count += 1
            else:
                new_node = InfraNode(
                    cluster_id=cluster_id,
                    hostname=hostname,
                    role=role,
                    cpu_cores=cpu_cores,
                    ram_gb=ram_gb,
                    ip_address=ip_address,
                    os_info=os_info,
                    auto_synced=True,
                )
                db.add(new_node)
                created_count += 1
                created_hostnames.append(hostname)
        except Exception as e:
            errors.append(f"{item.get('metadata', {}).get('name', 'unknown')}: {str(e)[:120]}")

    failed_count = len(errors)
    partial_failure = failed_count > 0
    _audit(
        db,
        cluster_id,
        entity_type="node",
        entity_id=None,
        action="sync",
        scope=SCOPE_SYNC,
        status_text="partial" if partial_failure else "success",
        reason="; ".join(errors[:5]) if errors else None,
        after_data={
            "created": created_count,
            "updated": updated_count,
            "failed": failed_count,
            "retry_count": retries,
        },
    )
    db.commit()

    # 신규 노드 자동 검증 (best-effort — 실패해도 sync 결과/semantics 불변)
    verifications: list[NodeVerifyResult] = []
    verified_truncated = False
    try:
        targets = created_hostnames[:_SYNC_VERIFY_MAX]
        verified_truncated = len(created_hostnames) > _SYNC_VERIFY_MAX
        for h in targets:
            verifications.append(_verify_node_health(db, cluster, h))
    except Exception:  # noqa: BLE001
        verifications = []
        verified_truncated = False

    return SyncResult(
        success=not partial_failure,
        created=created_count,
        updated=updated_count,
        failed=failed_count,
        retry_count=retries,
        partial_failure=partial_failure,
        errors=errors[:20],
        total=created_count + updated_count + failed_count,
        verifications=verifications,
        verified_truncated=verified_truncated,
    )
