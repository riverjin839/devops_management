"""PEP/APP 서비스 상위 카테고리 카탈로그 관리 router.

lake_service_types.py 와 동일 baseline:
 - GET get_current_user / mutating require_operator
 - 페이지네이션 + 진짜 db.count()
 - audit_logger 호출
 - HTTPException detail dict + error code

builtin 보호:
 - builtin(domain='pep' 4개 — Runtime/Catalog/Workflow/JupyterLab) 은 영구 삭제 불가 (HTTP 409)
 - builtin 의 key/domain 변경 불가 — label/icon/enabled/sort_order 만 편집 가능
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import ServiceCategory, LakeServiceType, User
from app.auth.deps import require_operator, get_current_user
from app.services import audit_logger
from app.schemas.service_category import (
    ServiceCategoryCreate,
    ServiceCategoryUpdate,
    ServiceCategoryResponse,
    ServiceCategoryListResponse,
)

router = APIRouter(prefix="/service-categories", tags=["service-categories"])


def _not_found(category_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "SERVICE_CATEGORY_NOT_FOUND", "message": "Service category not found",
                "id": str(category_id)},
    )


def _key_conflict(domain: str, key: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error": "SERVICE_CATEGORY_KEY_CONFLICT",
                "message": f"'{domain}' 도메인에 key '{key}' 이미 존재", "domain": domain, "key": key},
    )


def _builtin_locked(op: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error": "SERVICE_CATEGORY_BUILTIN_LOCKED",
                "message": f"builtin 카테고리는 {op} 불가. label/icon/enabled/sort_order 만 편집 가능"},
    )


# ── list / detail ────────────────────────────────────────────────────────

@router.get("", response_model=ServiceCategoryListResponse)
def list_categories(
    domain: str | None = Query(default=None, description="pep|app 필터"),
    enabled: bool | None = Query(default=None, description="true=활성만, false=비활성만, 미지정=전체"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(ServiceCategory)
    if domain:
        q = q.filter(ServiceCategory.domain == domain)
    if enabled is not None:
        q = q.filter(ServiceCategory.enabled == enabled)
    total = q.count()
    items = (
        q.order_by(ServiceCategory.domain, ServiceCategory.sort_order, ServiceCategory.key)
        .offset(offset).limit(limit).all()
    )
    return ServiceCategoryListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


@router.get("/{category_id}", response_model=ServiceCategoryResponse)
def get_category(
    category_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = db.query(ServiceCategory).filter(ServiceCategory.id == category_id).first()
    if not row:
        raise _not_found(category_id)
    return row


# ── create / update / delete ─────────────────────────────────────────────

@router.post("", response_model=ServiceCategoryResponse, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: ServiceCategoryCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """운영자가 카테고리 생성. is_builtin 은 강제 false."""
    existing = (
        db.query(ServiceCategory)
        .filter(ServiceCategory.domain == payload.domain, ServiceCategory.key == payload.key)
        .first()
    )
    if existing:
        raise _key_conflict(payload.domain, payload.key)

    row = ServiceCategory(
        domain=payload.domain,
        key=payload.key,
        label=payload.label,
        icon=payload.icon,
        is_builtin=False,
        enabled=payload.enabled,
        sort_order=payload.sort_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="service_category.create", actor=actor,
        target_type="service_category", target_id=row.id,
        details={"domain": row.domain, "key": row.key, "label": row.label},
        request=request,
    )
    return row


@router.put("/{category_id}", response_model=ServiceCategoryResponse)
def update_category(
    category_id: UUID,
    payload: ServiceCategoryUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    row = db.query(ServiceCategory).filter(ServiceCategory.id == category_id).first()
    if not row:
        raise _not_found(category_id)

    update = payload.model_dump(exclude_unset=True)
    for k, v in update.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="service_category.update", actor=actor,
        target_type="service_category", target_id=row.id,
        details={"changed_fields": sorted(update.keys()), "is_builtin": row.is_builtin},
        request=request,
    )
    return row


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    row = db.query(ServiceCategory).filter(ServiceCategory.id == category_id).first()
    if not row:
        raise _not_found(category_id)
    if row.is_builtin:
        raise _builtin_locked("삭제")
    used = (
        db.query(LakeServiceType)
        .filter(LakeServiceType.category_id == row.id)
        .count()
    )
    if used > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "SERVICE_CATEGORY_IN_USE",
                    "message": f"이 카테고리에 등록된 서비스 타입 {used}개 — 먼저 다른 카테고리로 옮기거나 삭제하세요",
                    "in_use_count": used, "key": row.key},
        )

    snap = {"domain": row.domain, "key": row.key, "label": row.label}
    target_id = row.id
    db.delete(row)
    db.commit()
    audit_logger.record(
        db, action="service_category.delete", actor=actor,
        target_type="service_category", target_id=target_id,
        details=snap, request=request,
    )
    return None
