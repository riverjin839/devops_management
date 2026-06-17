"""
Coroot APM router — fail-safe proxy + per-cluster deep-link.

coroot 은 별도 배포되는 외부 APM 엔진이다. 이 라우터는:
- 전역 헬스 프로브 (/coroot/health)
- 클러스터별 application 요약 (/coroot/{cluster_id}/summary)
- 클러스터별 coroot UI 딥링크 (/coroot/{cluster_id}/deeplink)
를 제공한다. coroot 미설정/미배포 시 500 대신 status="offline" 을 돌려준다
(PrometheusService 패턴과 동일).

per-cluster 매핑: clusters.coroot_project (필수), clusters.coroot_enabled (토글),
clusters.coroot_url (선택 — 전역 settings.coroot_url 오버라이드).
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cluster import Cluster
from app.services.coroot_service import CorootService, coroot_service

router = APIRouter(prefix="/coroot", tags=["coroot"])


def _service_for(cluster: Cluster) -> CorootService:
    """클러스터별 URL 오버라이드가 있으면 그것을 쓰는 CorootService 반환."""
    override = (cluster.coroot_url or "").strip()
    if override:
        return CorootService(base_url=override)
    return coroot_service


def _get_cluster(cluster_id: UUID, db: Session) -> Cluster:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return cluster


@router.get("/health")
async def coroot_health():
    """전역 coroot 가용성 프로브 (offline 이어도 200 으로 상태만 반환)."""
    return await coroot_service.health_check()


@router.get("/{cluster_id}/summary")
async def coroot_summary(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터에 매핑된 coroot project 의 application 요약."""
    cluster = _get_cluster(cluster_id, db)
    if not bool(cluster.coroot_enabled):
        return {
            "status": "offline",
            "service_count": None,
            "healthy": None,
            "alerting": None,
            "error": "이 클러스터에서 coroot 연동이 비활성화되어 있습니다.",
            "raw": None,
        }
    svc = _service_for(cluster)
    return await svc.get_overview(cluster.coroot_project or "")


@router.get("/{cluster_id}/deeplink")
def coroot_deeplink(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터별 coroot UI 딥링크 (브라우저에서 새 탭으로 열기 용)."""
    cluster = _get_cluster(cluster_id, db)
    if not bool(cluster.coroot_enabled):
        return {"url": None, "status": "offline",
                "detail": "이 클러스터에서 coroot 연동이 비활성화되어 있습니다."}
    svc = _service_for(cluster)
    url = svc.deeplink(cluster.coroot_project or "")
    if not url:
        return {"url": None, "status": "offline",
                "detail": "coroot URL 또는 project 매핑이 설정되지 않았습니다."}
    return {"url": url, "status": "ok"}


@router.get("/{cluster_id}/applications")
async def coroot_applications(cluster_id: UUID, db: Session = Depends(get_db)):
    """드릴다운용 — 클러스터 project 의 서비스(application) 목록."""
    cluster = _get_cluster(cluster_id, db)
    if not bool(cluster.coroot_enabled):
        return {"status": "offline", "applications": [],
                "error": "이 클러스터에서 coroot 연동이 비활성화되어 있습니다."}
    svc = _service_for(cluster)
    return await svc.get_applications(cluster.coroot_project or "")


@router.get("/{cluster_id}/application/deeplink")
def coroot_application_deeplink(
    cluster_id: UUID,
    app_id: str,
    view: str = "Tracing",
    db: Session = Depends(get_db),
):
    """특정 서비스의 coroot 리포트(기본 Tracing) 딥링크. app_id 는 query 로 받는다(콜론 포함)."""
    cluster = _get_cluster(cluster_id, db)
    if not bool(cluster.coroot_enabled):
        return {"url": None, "status": "offline",
                "detail": "이 클러스터에서 coroot 연동이 비활성화되어 있습니다."}
    svc = _service_for(cluster)
    url = svc.app_deeplink(cluster.coroot_project or "", app_id, view=view)
    if not url:
        return {"url": None, "status": "offline",
                "detail": "coroot URL/project 매핑 또는 app_id 가 없습니다."}
    return {"url": url, "status": "ok"}
