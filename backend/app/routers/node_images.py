from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cluster import Cluster
from app.services.k8s_node_image_service import NodeImageService
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.snapshot_jobs import SnapshotManager

router = APIRouter(prefix="/clusters/{cluster_id}/node-images", tags=["node-images"])

# 노드 이미지 수집(거대 응답)을 백그라운드로 수행 → 요청 비블로킹(ingress 60s 타임아웃과 분리).
_mgr = SnapshotManager(ttl=60.0)


@router.get("")
def get_node_images(cluster_id: UUID, db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    # 백그라운드 스레드의 detached 인스턴스 접근을 피하려 요청 스레드에서 kubeconfig 구체화.
    try:
        ensure_kubeconfig_file(cluster)
    except Exception:  # noqa: BLE001
        pass

    view = _mgr.get(
        f"{cluster_id}:node-images",
        lambda prog: NodeImageService(cluster).list_node_images(prog),
    )
    data = view["data"]
    if data is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"노드 이미지 수집 실패: {view['error']}")
        data = []
    return {
        "data": data,
        "status": view["status"],         # computing | ready | error
        "progress": view["progress"],     # 0..1 또는 null
        "processed": view["processed"],
        "total": view["total"],
        "stale": view["stale"],
    }
