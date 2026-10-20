from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from kubernetes.client.rest import ApiException
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.schemas.node_label import NodeListResponse, NodeLabelPatchRequest, NodeLabelPatchResponse
from app.services import audit_logger
from app.services.k8s_node_label_service import NodeLabelService, map_k8s_error

router = APIRouter(prefix="/clusters/{cluster_id}/nodes", tags=["node-labels"])


@router.get("", response_model=NodeListResponse)
def get_nodes(cluster_id: UUID, db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    try:
        service = NodeLabelService(cluster)
        nodes = service.list_nodes()
        return NodeListResponse(data=nodes)
    except ApiException as e:
        status_code, detail = map_k8s_error(e)
        raise HTTPException(status_code=status_code, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{node_name}/labels", response_model=NodeLabelPatchResponse)
def patch_node_labels(
    cluster_id: UUID,
    node_name: str,
    payload: NodeLabelPatchRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """노드 라벨 추가·삭제 (D-155).

    라벨은 nodeSelector·affinity·DaemonSet 배치 키라 변경 하나가 워크로드 재배치로 이어진다 —
    operator 이상만 허용하고(테넌트 바인딩 operate 는 마운트의 ``enforce_cluster_access`` 가 판정),
    성공·실패 모두 감사 로그(``node.labels.patch``)에 노드·추가·삭제 키를 남긴다.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    def _audit(status: str, error: str | None = None) -> None:
        details = {
            "cluster": cluster.name,
            "node": node_name,
            "add": dict(payload.add),
            "remove": list(payload.remove),
        }
        if error:
            details["error"] = error[:500]
        audit_logger.record(
            db,
            action="node.labels.patch",
            actor=actor,
            status=status,
            target_type="cluster",
            target_id=str(cluster_id),
            details=details,
            request=request,
        )

    try:
        service = NodeLabelService(cluster)
        updated = service.patch_labels(node_name=node_name, add=payload.add, remove=payload.remove)
    except ValueError as e:
        _audit("failure", str(e))
        raise HTTPException(status_code=422, detail=str(e))
    except ApiException as e:
        status_code, detail = map_k8s_error(e)
        _audit("failure", detail)
        raise HTTPException(status_code=status_code, detail=detail)
    except Exception as e:
        _audit("failure", str(e))
        raise HTTPException(status_code=500, detail=str(e))

    _audit("success")
    return NodeLabelPatchResponse(message="Node labels updated", data=updated)
