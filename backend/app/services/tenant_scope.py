"""업무·지식 데이터 테넌트 가시 범위 — 멀티테넌시 3단계.

대상 테이블(``TENANT_SCOPED_TABLES``)은 nullable ``tenant_id`` 를 가진다.

- ``tenant_id IS NULL`` → 전체 공유(기존 데이터 전부가 여기 해당 — 동작 변화 없음).
- ``tenant_id = T`` → 테넌트 T 의 멤버와 admin 만 보고 수정할 수 있다.
- 업무 항목은 추가로 소속 프로젝트의 테넌트도 따른다 — 비공개 프로젝트 안의 항목은 항목 자체가
  공유여도 프로젝트 멤버에게만 보인다(= 프로젝트 멤버십).

클러스터 바인딩(``services/cluster_access.py``)과 같은 테넌트·멤버 모델을 쓴다.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.tenant import TenantMember
from app.models.user import User

# tenant_id 컬럼을 가진 테이블 — main.py 마이그레이션·테넌트 삭제 가드가 같은 목록을 쓴다.
TENANT_SCOPED_TABLES = ("projects", "work_items", "work_guides", "ops_notes", "mindmaps")


def user_tenant_ids(db: Session, user: User) -> frozenset[UUID]:
    return frozenset(
        tid for (tid,) in db.query(TenantMember.tenant_id).filter(TenantMember.user_id == user.id).all()
    )


class TenantScope:
    """사용자별 데이터 가시 범위. ``auth.deps.get_tenant_scope`` 로 주입한다."""

    def __init__(self, *, is_admin: bool, tenant_ids: frozenset[UUID]):
        self.is_admin = is_admin
        self.tenant_ids = tenant_ids

    def visible(self, tenant_id: Optional[UUID]) -> bool:
        return self.is_admin or tenant_id is None or tenant_id in self.tenant_ids

    def apply(self, query, column):
        """``column``(tenant_id) 기준 목록 필터 — 공유(NULL) + 내 테넌트."""
        if self.is_admin:
            return query
        cond = column.is_(None)
        if self.tenant_ids:
            cond = cond | column.in_(list(self.tenant_ids))
        return query.filter(cond)

    def ensure_visible(self, tenant_id: Optional[UUID], what: str = "항목") -> None:
        """단건 조회·수정용 — 안 보이는 행은 존재 자체를 숨기도록 404."""
        if not self.visible(tenant_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what}을(를) 찾을 수 없습니다.")

    def ensure_assignable(self, tenant_id: Optional[UUID]) -> None:
        """생성·수정 시 지정하는 tenant_id — 공유(None) 이거나 내가 속한 테넌트여야 한다."""
        if tenant_id is None or self.is_admin or tenant_id in self.tenant_ids:
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="속하지 않은 테넌트로는 지정할 수 없습니다.",
        )


def work_item_visibility(scope: TenantScope, query, db: Session):
    """업무 항목 목록 필터 — 항목 자체 tenant_id + 소속 프로젝트 tenant_id 를 모두 따른다."""
    if scope.is_admin:
        return query
    from app.models.project import Project
    from app.models.work_item import WorkItem

    query = scope.apply(query, WorkItem.tenant_id)
    visible_projects = scope.apply(db.query(Project.id), Project.tenant_id).subquery()
    return query.filter(WorkItem.project_id.is_(None) | WorkItem.project_id.in_(visible_projects.select()))


def work_item_visible(scope: TenantScope, db: Session, item) -> bool:
    if scope.is_admin:
        return True
    if not scope.visible(item.tenant_id):
        return False
    if item.project_id is None:
        return True
    from app.models.project import Project

    proj = db.query(Project.tenant_id).filter(Project.id == item.project_id).first()
    return proj is None or scope.visible(proj.tenant_id)
