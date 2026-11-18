"""서비스 구성 라우터 — K8S 허브 ▸ 구성 ▸ 서비스 구성.

1단계: 서비스 목록, 서비스별 설정 화면 데이터(설정 항목 × 버전 값 × 노드별 현재 값), 현재 값으로 V1 만들기.
경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 read(GET)/operate(POST)를 판정한다.
현재 값은 기존 수집 스냅샷에서 읽는다 — 노드에 아무것도 실행하지 않는다(수집은 ``versions`` 라우터의 수집 엔드포인트).
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.service_config import view as V

router = APIRouter(prefix="/service-config", tags=["Service Config"])


def _cluster(db: Session, cluster_id: UUID) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return c


@router.get("/services")
def list_services(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": V.service_list(db)}


@router.get("/clusters/{cluster_id}/{service}")
def service_view(
    cluster_id: UUID,
    service: str,
    version: Optional[int] = Query(default=None, ge=1, description="보여줄 버전 번호(없으면 최신)"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return V.build_view(db, _cluster(db, cluster_id), service, version)
    except V.ServiceConfigError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.post("/clusters/{cluster_id}/{service}/import", status_code=201)
def import_current(
    cluster_id: UUID,
    service: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """현재 노드 값으로 V1 을 만든다(DB 저장만 — 노드에는 아무것도 하지 않는다)."""
    cluster = _cluster(db, cluster_id)
    try:
        out = V.import_v1(db, cluster, service, user.username)
    except V.ServiceConfigError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    audit_logger.record(db, action="service_config.import", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "imported": out["imported"], "mixed": len(out["mixed"])},
                        request=request)
    return out
