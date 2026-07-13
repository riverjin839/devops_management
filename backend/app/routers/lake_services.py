"""LAKE 서비스 monitoring router.

직전 사이클 (work-mgmt-enterprise-audit) baseline 그대로 반영:
 - GET 도 get_current_user, mutating 은 require_operator
 - 페이지네이션 + 진짜 db.count() + offset/limit/has_more
 - audit_logger 호출 (create/update/delete/check_run)
 - HTTPException detail dict + error code
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster, LakeService, LakeServiceCheck, LakeServiceType, User
from app.auth.deps import require_operator, get_current_user
from app.services import audit_logger
from app.services.lake_checkers import (
    LAKE_CHECKER_REGISTRY,
    SERVICE_TYPE_CATALOG,
    get_checker_class,
    get_category_for,
    build_checker,
)
from app.schemas.lake_service import (
    LakeServiceCreate,
    LakeServiceUpdate,
    LakeServiceResponse,
    LakeServiceListResponse,
    LakeServiceCheckResponse,
    LakeServiceCheckListResponse,
    LakeServiceTypeInfo,
)


router = APIRouter(prefix="/lake-services", tags=["lake-services"])


# ─── helpers ──────────────────────────────────────────────────────────────

def _not_found(service_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "LAKE_SERVICE_NOT_FOUND", "message": "Lake service not found",
                "id": str(service_id)},
    )


def _cluster_not_found(cluster_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "CLUSTER_NOT_FOUND", "message": "Cluster not found",
                "id": str(cluster_id)},
    )


def _unknown_service_type(service_type: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error": "UNKNOWN_SERVICE_TYPE",
            "message": f"미지원 service_type: {service_type}",
            "supported": sorted(LAKE_CHECKER_REGISTRY.keys()),
        },
    )


def _run_check(svc: LakeService, db: Session, *, actor: Optional[User], trigger: str) -> LakeServiceCheck:
    """단일 LakeService 헬스체크 + LakeServiceCheck 1 row 저장 + svc.status 갱신.
    실패해도 raise 안 함 (safe_run) — LakeServiceCheck.status 로 표현.

    builtin REGISTRY hit → 기존 클래스 / miss (custom) → GenericHealthzChecker
    (LakeServiceType DB row 의 default_path 사용).
    """
    # Custom type 의 default_path 를 DB 에서 lookup (builtin 은 사실 코드 catalog 와
    # 일치하지만 통합 lookup 으로 단순화)
    type_row = (
        db.query(LakeServiceType)
        .filter(LakeServiceType.service_type == svc.service_type)
        .first()
    )
    if type_row is None:
        # service_type 이 등록되지 않은 경우 — 운영자가 type 삭제했거나 stale 인스턴스
        raise _unknown_service_type(svc.service_type)

    checker = build_checker(svc, type_default_path=type_row.default_path)
    outcome = checker.safe_run()

    row = LakeServiceCheck(
        service_id=svc.id,
        status=outcome.status,
        response_time_ms=outcome.response_time_ms,
        message=outcome.message,
        details=outcome.details or {},
        triggered_by=trigger,
        triggered_by_user=(actor.username if actor else None),
        checked_at=datetime.utcnow(),
    )
    db.add(row)
    # service summary 갱신
    svc.status = outcome.status
    svc.last_checked_at = row.checked_at
    svc.last_message = outcome.message
    db.commit()
    db.refresh(row)
    db.refresh(svc)
    return row


# ─── service types catalog ────────────────────────────────────────────────

@router.get("/types", response_model=list[LakeServiceTypeInfo])
def list_service_types(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """등록 가능한 service_type 메타 — DB-driven (enabled=true 만).

    이전엔 코드 catalog (SERVICE_TYPE_CATALOG) 였으나 lake-service-type-management
    PDCA 로 DB-driven 으로 변경. AddLakeServiceModal 이 자동으로 enabled type
    만 select 표시.
    """
    rows = (
        db.query(LakeServiceType)
        .filter(LakeServiceType.enabled == True)  # noqa: E712
        .order_by(LakeServiceType.sort_order, LakeServiceType.service_type)
        .all()
    )
    return [
        LakeServiceTypeInfo(
            service_type=r.service_type,
            label=r.label,
            category=r.category,
            default_path=r.default_path,
            description=r.description,
        )
        for r in rows
    ]


# ─── list / detail ────────────────────────────────────────────────────────

@router.get("", response_model=LakeServiceListResponse)
def list_lake_services(
    cluster_id: UUID | None = Query(default=None, description="클러스터 UUID 필터"),
    service_type: str | None = Query(default=None, description="service_type 필터 (airflow/spark/...)"),
    category: str | None = Query(default=None, description="catalog/runtime/analytics 필터"),
    enabled: bool | None = Query(default=None, description="enabled 토글 필터"),
    domain: str | None = Query(default=None, description="pep|app 필터"),
    category_id: Optional[UUID] = Query(default=None, description="상위 카테고리(ServiceCategory) 필터 — type 조인"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """LAKE 서비스 인스턴스 목록 (페이지네이션 + 필터)."""
    q = db.query(LakeService)
    if cluster_id is not None:
        q = q.filter(LakeService.cluster_id == cluster_id)
    if service_type:
        q = q.filter(LakeService.service_type == service_type)
    if category:
        q = q.filter(LakeService.category == category)
    if enabled is not None:
        q = q.filter(LakeService.enabled == enabled)
    if domain:
        q = q.filter(LakeService.domain == domain)
    if category_id is not None:
        q = q.join(LakeServiceType, LakeServiceType.service_type == LakeService.service_type).filter(
            LakeServiceType.category_id == category_id
        )

    total = q.count()
    items = (
        q.order_by(LakeService.cluster_id, LakeService.service_type, LakeService.name)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return LakeServiceListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


@router.get("/{service_id}", response_model=LakeServiceResponse)
def get_lake_service(
    service_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    svc = db.query(LakeService).filter(LakeService.id == service_id).first()
    if not svc:
        raise _not_found(service_id)
    return svc


@router.get("/{service_id}/checks", response_model=LakeServiceCheckListResponse)
def list_lake_service_checks(
    service_id: UUID,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """단일 LakeService 의 헬스체크 history (시간 역순)."""
    svc = db.query(LakeService).filter(LakeService.id == service_id).first()
    if not svc:
        raise _not_found(service_id)
    q = db.query(LakeServiceCheck).filter(LakeServiceCheck.service_id == service_id)
    total = q.count()
    items = (
        q.order_by(LakeServiceCheck.checked_at.desc())
        .offset(offset).limit(limit).all()
    )
    return LakeServiceCheckListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


# ─── create / update / delete ─────────────────────────────────────────────

@router.post("", response_model=LakeServiceResponse, status_code=status.HTTP_201_CREATED)
def create_lake_service(
    payload: LakeServiceCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    # DB-driven type 검증 — builtin REGISTRY + custom 모두 허용 (단 enabled=true 만)
    type_row = (
        db.query(LakeServiceType)
        .filter(LakeServiceType.service_type == payload.service_type)
        .first()
    )
    if type_row is None:
        raise _unknown_service_type(payload.service_type)
    if not type_row.enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "LAKE_SERVICE_TYPE_DISABLED",
                    "message": f"service_type '{payload.service_type}' 은 비활성화 상태 — Settings 에서 활성화 후 다시 시도",
                    "service_type": payload.service_type},
        )
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise _cluster_not_found(payload.cluster_id)

    # category/domain: DB row(LakeServiceType) 가 항상 우선 — client 입력값 무시
    category = type_row.category or get_category_for(payload.service_type)
    data = payload.model_dump(exclude={"meta"})
    svc = LakeService(
        cluster_id=data["cluster_id"],
        service_type=data["service_type"],
        name=data["name"],
        category=category,
        domain=type_row.domain,
        endpoint_url=data["endpoint_url"],
        namespace=data.get("namespace"),
        enabled=data.get("enabled", True),
        tls_verify=data.get("tls_verify", False),
        meta=payload.meta,
    )
    db.add(svc)
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "LAKE_SERVICE_CONFLICT",
                    "message": f"동일 cluster + service_type + name 이미 존재: {str(e)[:200]}"},
        )
    db.refresh(svc)

    audit_logger.record(
        db, action="lake_service.create", actor=actor,
        target_type="lake_service", target_id=svc.id,
        details={"service_type": svc.service_type, "name": svc.name,
                 "cluster_id": str(svc.cluster_id), "endpoint_url": svc.endpoint_url},
        request=request,
    )
    return svc


@router.put("/{service_id}", response_model=LakeServiceResponse)
def update_lake_service(
    service_id: UUID,
    payload: LakeServiceUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    svc = db.query(LakeService).filter(LakeService.id == service_id).first()
    if not svc:
        raise _not_found(service_id)

    update_data = payload.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        setattr(svc, k, v)
    db.commit()
    db.refresh(svc)

    audit_logger.record(
        db, action="lake_service.update", actor=actor,
        target_type="lake_service", target_id=svc.id,
        details={"changed_fields": sorted(update_data.keys())},
        request=request,
    )
    return svc


@router.delete("/{service_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lake_service(
    service_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    svc = db.query(LakeService).filter(LakeService.id == service_id).first()
    if not svc:
        raise _not_found(service_id)
    snapshot = {"service_type": svc.service_type, "name": svc.name,
                "cluster_id": str(svc.cluster_id)}
    target_id = svc.id
    db.delete(svc)
    db.commit()
    audit_logger.record(
        db, action="lake_service.delete", actor=actor,
        target_type="lake_service", target_id=target_id,
        details=snapshot, request=request,
    )
    return None


# ─── run check (manual trigger) ───────────────────────────────────────────

@router.post("/{service_id}/check", response_model=LakeServiceCheckResponse)
def run_lake_service_check(
    service_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """단일 LAKE 서비스 헬스체크 즉시 실행. 결과 LakeServiceCheck 로 저장 + svc.status 갱신."""
    svc = db.query(LakeService).filter(LakeService.id == service_id).first()
    if not svc:
        raise _not_found(service_id)
    if not svc.enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "LAKE_SERVICE_DISABLED",
                    "message": "비활성화된 서비스는 점검 불가. 먼저 enabled=true 로 변경하세요.",
                    "id": str(service_id)},
        )

    row = _run_check(svc, db, actor=actor, trigger="manual")
    audit_logger.record(
        db, action="lake_service.check_run", actor=actor,
        target_type="lake_service", target_id=svc.id,
        details={"status": row.status.value if hasattr(row.status, "value") else str(row.status),
                 "response_time_ms": row.response_time_ms,
                 "message": (row.message or "")[:200]},
        request=request,
    )
    return row
