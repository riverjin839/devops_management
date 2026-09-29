"""테넌트 · 멤버 · 클러스터 바인딩 관리 — 멀티테넌시 1단계 (Settings ▸ 테넌트 탭).

- GET    /tenants                         → 전체 목록(멤버·바인딩 포함) — admin
- POST   /tenants                         → 생성 — admin
- PUT    /tenants/{tenant_id}             → 이름/설명 수정 — admin
- DELETE /tenants/{tenant_id}             → 삭제(멤버·바인딩 CASCADE) — admin
- PUT    /tenants/{tenant_id}/members     → 멤버 집합 교체 — admin
- PUT    /tenants/{tenant_id}/bindings    → 클러스터 바인딩 집합 교체 — admin
- GET    /tenants/my-cluster-access       → 로그인 사용자의 클러스터별 access (바인딩 있는 클러스터만)

판정 규칙은 ``models/tenant.py`` / ``services/cluster_access.py`` 참고.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin
from app.database import get_db
from app.models.cluster import Cluster
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.user import User
from app.services import audit_logger
from app.services.cluster_access import cluster_access_level

router = APIRouter(prefix="/tenants", tags=["tenants"])


# ── Schemas ──────────────────────────────────────────────────────────────────

class TenantMemberOut(BaseModel):
    user_id: str
    username: Optional[str] = None
    display_name: Optional[str] = None
    role: Optional[str] = None


class ClusterBindingIn(BaseModel):
    cluster_id: UUID
    access: Literal["read", "operate"] = "operate"


class ClusterBindingOut(ClusterBindingIn):
    cluster_name: Optional[str] = None


class TenantOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = None
    members: list[TenantMemberOut] = []
    bindings: list[ClusterBindingOut] = []
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class TenantCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None


class TenantUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = None


class TenantMembersPut(BaseModel):
    user_ids: list[str] = []


class TenantBindingsPut(BaseModel):
    bindings: list[ClusterBindingIn] = []


class TenantBrief(BaseModel):
    id: UUID
    name: str


class MyClusterAccessOut(BaseModel):
    # 바인딩이 있는(=제한된) 클러스터만 담는다. 값이 None 이면 접근 불가.
    # 여기 없는 클러스터는 제한 없음(전역 role 만 적용).
    clusters: dict[str, Optional[Literal["read", "operate"]]] = {}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_tenant_or_404(db: Session, tenant_id: UUID) -> Tenant:
    t = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if t is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="테넌트를 찾을 수 없습니다.")
    return t


def _tenant_out(db: Session, t: Tenant) -> TenantOut:
    members = (
        db.query(User)
        .join(TenantMember, TenantMember.user_id == User.id)
        .filter(TenantMember.tenant_id == t.id)
        .order_by(User.display_name, User.username)
        .all()
    )
    bindings = (
        db.query(ClusterBinding, Cluster.name)
        .join(Cluster, Cluster.id == ClusterBinding.cluster_id)
        .filter(ClusterBinding.tenant_id == t.id)
        .order_by(Cluster.name)
        .all()
    )
    return TenantOut(
        id=t.id,
        name=t.name,
        description=t.description,
        members=[
            TenantMemberOut(user_id=u.id, username=u.username, display_name=u.display_name, role=u.role)
            for u in members
        ],
        bindings=[
            ClusterBindingOut(cluster_id=b.cluster_id, access=b.access, cluster_name=name)
            for b, name in bindings
        ],
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


def _tenant_data_counts(db: Session, tenant_id: UUID) -> dict[str, int]:
    from sqlalchemy import text

    from app.services.tenant_scope import TENANT_SCOPED_TABLES

    out: dict[str, int] = {}
    for table in TENANT_SCOPED_TABLES:
        n = db.execute(text(f"SELECT COUNT(*) FROM {table} WHERE tenant_id = :tid"), {"tid": tenant_id}).scalar()
        if n:
            out[table] = int(n)
    return out


def _ensure_unique_name(db: Session, name: str, exclude_id: UUID | None = None) -> None:
    q = db.query(Tenant).filter(Tenant.name == name)
    if exclude_id is not None:
        q = q.filter(Tenant.id != exclude_id)
    if q.first() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"같은 이름의 테넌트가 있습니다: {name}")


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/my-cluster-access", response_model=MyClusterAccessOut)
def my_cluster_access(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """화면이 실행 버튼을 미리 비활성화할 수 있도록 제한된 클러스터별 access 를 알려준다."""
    restricted = {cid for (cid,) in db.query(ClusterBinding.cluster_id).distinct().all()}
    return MyClusterAccessOut(
        clusters={str(cid): cluster_access_level(db, user, cid) for cid in restricted},
    )


@router.get("/mine", response_model=list[TenantBrief])
def my_tenants(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """업무·지식 데이터 작성 폼의 "공유 범위" 선택지 — admin 은 전체, 그 외는 내가 속한 테넌트."""
    q = db.query(Tenant)
    if user.role != "admin":
        q = q.join(TenantMember, TenantMember.tenant_id == Tenant.id).filter(TenantMember.user_id == user.id)
    return [TenantBrief(id=t.id, name=t.name) for t in q.order_by(Tenant.name).all()]


@router.get("", response_model=list[TenantOut])
def list_tenants(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return [_tenant_out(db, t) for t in db.query(Tenant).order_by(Tenant.name).all()]


@router.post("", response_model=TenantOut, status_code=status.HTTP_201_CREATED)
def create_tenant(body: TenantCreate, request: Request, db: Session = Depends(get_db),
                  actor: User = Depends(require_admin)):
    name = body.name.strip()
    _ensure_unique_name(db, name)
    t = Tenant(name=name, description=body.description)
    db.add(t)
    db.commit()
    db.refresh(t)
    audit_logger.record(db, action="tenant.create", actor=actor, target_type="tenant", target_id=t.id,
                        details={"name": t.name}, request=request)
    return _tenant_out(db, t)


@router.put("/{tenant_id}", response_model=TenantOut)
def update_tenant(tenant_id: UUID, body: TenantUpdate, request: Request, db: Session = Depends(get_db),
                  actor: User = Depends(require_admin)):
    t = _get_tenant_or_404(db, tenant_id)
    before = {"name": t.name, "description": t.description}
    if body.name is not None:
        name = body.name.strip()
        _ensure_unique_name(db, name, exclude_id=t.id)
        t.name = name
    if "description" in body.model_fields_set:
        t.description = body.description
    db.commit()
    db.refresh(t)
    audit_logger.record(db, action="tenant.update", actor=actor, target_type="tenant", target_id=t.id,
                        details={"before": before, "after": {"name": t.name, "description": t.description}},
                        request=request)
    return _tenant_out(db, t)


@router.delete("/{tenant_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tenant(tenant_id: UUID, request: Request, db: Session = Depends(get_db),
                  actor: User = Depends(require_admin)):
    t = _get_tenant_or_404(db, tenant_id)
    name = t.name
    # 이 테넌트로 제한된 업무·지식 데이터가 남아 있으면 막는다 — 지우면 그 데이터의 범위가 사라져
    # (FK RESTRICT) 삭제가 실패하거나, 풀어 버리면 전체 공개로 바뀌기 때문이다. 먼저 옮기게 한다.
    in_use = _tenant_data_counts(db, t.id)
    if in_use:
        summary = ", ".join(f"{k} {v}건" for k, v in in_use.items())
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"이 테넌트로 제한된 데이터가 남아 있어 삭제할 수 없습니다 ({summary}). "
                   "공유 범위를 다른 테넌트나 '전체 공유'로 바꾼 뒤 삭제하세요.",
        )
    # FK 는 ondelete=CASCADE 지만 ORM 세션 일관성을 위해 자식 행을 명시적으로 지운다.
    db.query(TenantMember).filter(TenantMember.tenant_id == t.id).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.tenant_id == t.id).delete(synchronize_session=False)
    db.delete(t)
    db.commit()
    audit_logger.record(db, action="tenant.delete", actor=actor, target_type="tenant", target_id=tenant_id,
                        details={"name": name}, request=request)


@router.put("/{tenant_id}/members", response_model=TenantOut)
def put_members(tenant_id: UUID, body: TenantMembersPut, request: Request, db: Session = Depends(get_db),
                actor: User = Depends(require_admin)):
    t = _get_tenant_or_404(db, tenant_id)
    wanted = {u for u in body.user_ids if u}
    if wanted:
        found = {u.id for u in db.query(User.id).filter(User.id.in_(wanted)).all()}
        missing = wanted - found
        if missing:
            raise HTTPException(status_code=422, detail=f"존재하지 않는 사용자: {', '.join(sorted(missing))}")
    current = {m.user_id for m in db.query(TenantMember).filter(TenantMember.tenant_id == t.id).all()}
    removed = current - wanted
    added = wanted - current
    if removed:
        db.query(TenantMember).filter(
            TenantMember.tenant_id == t.id, TenantMember.user_id.in_(removed),
        ).delete(synchronize_session=False)
    for uid in added:
        db.add(TenantMember(tenant_id=t.id, user_id=uid))
    db.commit()
    audit_logger.record(db, action="tenant.members.update", actor=actor, target_type="tenant", target_id=t.id,
                        details={"name": t.name, "added": sorted(added), "removed": sorted(removed)},
                        request=request)
    return _tenant_out(db, t)


@router.put("/{tenant_id}/bindings", response_model=TenantOut)
def put_bindings(tenant_id: UUID, body: TenantBindingsPut, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_admin)):
    t = _get_tenant_or_404(db, tenant_id)
    wanted: dict[UUID, str] = {}
    for b in body.bindings:
        wanted[b.cluster_id] = b.access  # 같은 클러스터가 중복되면 마지막 값
    if wanted:
        found = {c.id for c in db.query(Cluster.id).filter(Cluster.id.in_(list(wanted))).all()}
        missing = set(wanted) - found
        if missing:
            raise HTTPException(status_code=422,
                                detail=f"존재하지 않는 클러스터: {', '.join(sorted(map(str, missing)))}")
    rows = {b.cluster_id: b for b in db.query(ClusterBinding).filter(ClusterBinding.tenant_id == t.id).all()}
    changes: list[dict] = []
    for cid, row in rows.items():
        if cid not in wanted:
            db.delete(row)
            changes.append({"cluster_id": str(cid), "before": row.access, "after": None})
        elif row.access != wanted[cid]:
            changes.append({"cluster_id": str(cid), "before": row.access, "after": wanted[cid]})
            row.access = wanted[cid]
    for cid, access in wanted.items():
        if cid not in rows:
            db.add(ClusterBinding(tenant_id=t.id, cluster_id=cid, access=access))
            changes.append({"cluster_id": str(cid), "before": None, "after": access})
    db.commit()
    audit_logger.record(db, action="tenant.bindings.update", actor=actor, target_type="tenant", target_id=t.id,
                        details={"name": t.name, "changes": changes}, request=request)
    return _tenant_out(db, t)
