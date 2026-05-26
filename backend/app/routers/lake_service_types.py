"""LAKE service type 카탈로그 관리 router.

직전 사이클 baseline:
 - GET get_current_user / mutating require_operator
 - 페이지네이션 + 진짜 db.count()
 - audit_logger 호출
 - HTTPException detail dict + error code

builtin 보호:
 - builtin 은 영구 삭제 불가 (HTTP 409)
 - builtin 의 service_type slug 변경 불가 (router 가 거부)
 - builtin 의 label/category/default_path 도 readonly — UI 가 알리는 정책
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import LakeServiceType, LakeService, User
from app.auth.deps import require_operator, get_current_user
from app.services import audit_logger
from app.schemas.lake_service_type import (
    LakeServiceTypeCreate,
    LakeServiceTypeUpdate,
    LakeServiceTypeToggle,
    LakeServiceTypeResponse,
    LakeServiceTypeListResponse,
)

router = APIRouter(prefix="/lake-service-types", tags=["lake-service-types"])


def _not_found(type_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "LAKE_SERVICE_TYPE_NOT_FOUND",
                "message": "Lake service type not found", "id": str(type_id)},
    )


def _slug_conflict(slug: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error": "LAKE_SERVICE_TYPE_SLUG_CONFLICT",
                "message": f"service_type slug '{slug}' 이미 존재", "service_type": slug},
    )


def _builtin_locked(op: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error": "LAKE_SERVICE_TYPE_BUILTIN_LOCKED",
                "message": f"builtin type 은 {op} 불가. enabled 토글/sort_order 만 가능"},
    )


# ── list / detail ────────────────────────────────────────────────────────

@router.get("", response_model=LakeServiceTypeListResponse)
def list_types(
    enabled: bool | None = Query(default=None, description="true=활성만, false=비활성만, 미지정=전체"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(LakeServiceType)
    if enabled is not None:
        q = q.filter(LakeServiceType.enabled == enabled)
    total = q.count()
    items = (
        q.order_by(LakeServiceType.sort_order, LakeServiceType.service_type)
        .offset(offset).limit(limit).all()
    )
    return LakeServiceTypeListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


@router.get("/{type_id}", response_model=LakeServiceTypeResponse)
def get_type(
    type_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = db.query(LakeServiceType).filter(LakeServiceType.id == type_id).first()
    if not row:
        raise _not_found(type_id)
    return row


# ── create / update / delete ─────────────────────────────────────────────

@router.post("", response_model=LakeServiceTypeResponse, status_code=status.HTTP_201_CREATED)
def create_type(
    payload: LakeServiceTypeCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """Custom type 생성. is_builtin 은 강제 false."""
    existing = (
        db.query(LakeServiceType)
        .filter(LakeServiceType.service_type == payload.service_type)
        .first()
    )
    if existing:
        raise _slug_conflict(payload.service_type)

    row = LakeServiceType(
        service_type=payload.service_type,
        label=payload.label,
        category=payload.category,
        default_path=payload.default_path,
        description=payload.description,
        icon=payload.icon,
        is_builtin=False,             # 운영자는 builtin 만들 수 없음
        enabled=payload.enabled,
        sort_order=payload.sort_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="lake_type.create", actor=actor,
        target_type="lake_service_type", target_id=row.id,
        details={"service_type": row.service_type, "label": row.label,
                 "category": row.category, "default_path": row.default_path},
        request=request,
    )
    return row


@router.put("/{type_id}", response_model=LakeServiceTypeResponse)
def update_type(
    type_id: UUID,
    payload: LakeServiceTypeUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    row = db.query(LakeServiceType).filter(LakeServiceType.id == type_id).first()
    if not row:
        raise _not_found(type_id)

    update = payload.model_dump(exclude_unset=True)

    # builtin 보호: label/category/default_path 변경 거부
    if row.is_builtin:
        locked_fields = {"label", "category", "default_path"} & set(update.keys())
        if locked_fields:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": "LAKE_SERVICE_TYPE_BUILTIN_FIELD_LOCKED",
                        "message": f"builtin type 의 다음 필드는 수정 불가: {sorted(locked_fields)}",
                        "locked_fields": sorted(locked_fields)},
            )

    for k, v in update.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="lake_type.update", actor=actor,
        target_type="lake_service_type", target_id=row.id,
        details={"changed_fields": sorted(update.keys()), "is_builtin": row.is_builtin},
        request=request,
    )
    return row


@router.patch("/{type_id}/enabled", response_model=LakeServiceTypeResponse)
def toggle_enabled(
    type_id: UUID,
    payload: LakeServiceTypeToggle,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """편의 endpoint — UI 의 toggle switch 용 (builtin/custom 모두 가능)."""
    row = db.query(LakeServiceType).filter(LakeServiceType.id == type_id).first()
    if not row:
        raise _not_found(type_id)
    prev = row.enabled
    row.enabled = payload.enabled
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="lake_type.toggle", actor=actor,
        target_type="lake_service_type", target_id=row.id,
        details={"service_type": row.service_type, "from": prev, "to": row.enabled,
                 "is_builtin": row.is_builtin},
        request=request,
    )
    return row


@router.delete("/{type_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_type(
    type_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    row = db.query(LakeServiceType).filter(LakeServiceType.id == type_id).first()
    if not row:
        raise _not_found(type_id)
    if row.is_builtin:
        raise _builtin_locked("삭제")
    # 사용 중인 LakeService 인스턴스 있는지 체크
    used = (
        db.query(LakeService)
        .filter(LakeService.service_type == row.service_type)
        .count()
    )
    if used > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "LAKE_SERVICE_TYPE_IN_USE",
                    "message": f"이 type 으로 등록된 LakeService 인스턴스 {used}개 — 먼저 삭제하세요",
                    "in_use_count": used, "service_type": row.service_type},
        )

    snap = {"service_type": row.service_type, "label": row.label, "category": row.category}
    target_id = row.id
    db.delete(row)
    db.commit()
    audit_logger.record(
        db, action="lake_type.delete", actor=actor,
        target_type="lake_service_type", target_id=target_id,
        details=snap, request=request,
    )
    return None
