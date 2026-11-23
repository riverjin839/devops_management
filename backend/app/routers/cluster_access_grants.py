"""사용자별 클러스터 권한 직접 지정 — Settings ▸ 클러스터 권한 탭 (admin 전용).

- GET /cluster-access/summary            → 사용자별 직접 지정 개수
- GET /cluster-access/users/{user_id}    → 클러스터별 직접 지정 · 실제 적용 · 근거
- PUT /cluster-access/grants/bulk        → 직접 지정 일괄 저장 (access=null 은 지정 해제)

판정 규칙은 ``models/tenant.py`` ``ClusterUserGrant`` / ``services/cluster_access.py`` 참고.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.database import get_db
from app.models.cluster import Cluster
from app.models.tenant import ClusterUserGrant
from app.models.user import User
from app.schemas.cluster_access_grant import (
    ClusterAccessRow,
    GrantBulkIn,
    GrantBulkOut,
    GrantSummaryItem,
    UserClusterAccessOut,
)
from app.services import audit_logger
from app.services.cluster_access import cluster_access_with_source

router = APIRouter(prefix="/cluster-access", tags=["cluster-access"])


@router.get("/summary", response_model=list[GrantSummaryItem])
def grant_summary(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    rows = (
        db.query(ClusterUserGrant.user_id, func.count(ClusterUserGrant.id))
        .group_by(ClusterUserGrant.user_id)
        .all()
    )
    return [GrantSummaryItem(user_id=uid, grants=int(n)) for uid, n in rows]


@router.get("/users/{user_id}", response_model=UserClusterAccessOut)
def user_cluster_access(user_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    target = db.query(User).filter(User.id == user_id).first()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="사용자를 찾을 수 없습니다.")
    grants = dict(
        db.query(ClusterUserGrant.cluster_id, ClusterUserGrant.access)
        .filter(ClusterUserGrant.user_id == user_id).all()
    )
    rows: list[ClusterAccessRow] = []
    for c in db.query(Cluster).order_by(Cluster.name).all():
        effective, source = cluster_access_with_source(db, target, c.id)
        rows.append(ClusterAccessRow(
            cluster_id=c.id,
            cluster_name=c.name,
            grant=grants.get(c.id),
            effective=effective,
            source=source,
            role_limited=effective == "operate" and target.role == "viewer",
        ))
    return UserClusterAccessOut(
        user_id=target.id, username=target.username, display_name=target.display_name,
        role=target.role, clusters=rows,
    )


@router.put("/grants/bulk", response_model=GrantBulkOut)
def save_grants(
    payload: GrantBulkIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    user_ids = {ch.user_id for ch in payload.changes}
    cluster_ids = {ch.cluster_id for ch in payload.changes}
    known_users = {uid for (uid,) in db.query(User.id).filter(User.id.in_(user_ids)).all()} if user_ids else set()
    known_clusters = (
        {cid for (cid,) in db.query(Cluster.id).filter(Cluster.id.in_(cluster_ids)).all()} if cluster_ids else set()
    )
    missing_u = user_ids - known_users
    missing_c = cluster_ids - known_clusters
    if missing_u or missing_c:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"존재하지 않는 사용자 {sorted(missing_u)} / 클러스터 {sorted(map(str, missing_c))}",
        )

    created = updated = removed = 0
    applied: list[dict] = []
    for ch in payload.changes:
        row = (
            db.query(ClusterUserGrant)
            .filter(ClusterUserGrant.user_id == ch.user_id, ClusterUserGrant.cluster_id == ch.cluster_id)
            .first()
        )
        before = row.access if row else None
        if ch.access is None:
            if row is not None:
                db.delete(row)
                removed += 1
        elif row is None:
            db.add(ClusterUserGrant(
                user_id=ch.user_id, cluster_id=ch.cluster_id, access=ch.access, granted_by=actor.username,
            ))
            created += 1
        elif row.access != ch.access:
            row.access = ch.access
            row.granted_by = actor.username
            updated += 1
        else:
            continue
        applied.append({"user_id": ch.user_id, "cluster_id": str(ch.cluster_id), "before": before, "after": ch.access})
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail=f"클러스터 권한 저장 실패: {e}") from e

    for item in applied:
        audit_logger.record(
            db,
            action="cluster_access.grant",
            actor=actor,
            status="success",
            target_type="cluster",
            target_id=item["cluster_id"],
            details=item,
            request=request,
        )
    return GrantBulkOut(created=created, updated=updated, removed=removed)
