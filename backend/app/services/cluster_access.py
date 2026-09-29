"""클러스터 단위 접근 판정 — 테넌트 바인딩 기반 (멀티테넌시 1단계).

규칙은 ``models/tenant.py`` docstring 참고. 요약:
- admin → 항상 허용.
- 바인딩 없는 클러스터 → 허용(opt-in 격리, 기존 설치 호환).
- 바인딩 있는 클러스터 → 사용자가 속한 테넌트의 바인딩 중 가장 높은 access 가 요구 수준 이상일 때만.

전역 role 게이트(``require_operator``)는 각 라우터가 그대로 건다 — 여기선 클러스터 범위만 본다.
"""
from __future__ import annotations

import json
from typing import Iterable
from uuid import UUID

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.tenant import ClusterBinding, TenantMember
from app.models.user import User

_RANK = {"read": 1, "operate": 2}

# 이 HTTP 메서드는 조회로 본다. 나머지(POST/PUT/PATCH/DELETE)는 실행·변경 = operate.
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _is_admin(user: User) -> bool:
    return user.role == "admin"


def cluster_access_level(db: Session, user: User, cluster_id: UUID) -> str | None:
    """사용자가 이 클러스터에 가진 access. 'operate' | 'read' | None(접근 불가).

    바인딩이 없는 클러스터는 'operate'(= 제한 없음, 전역 role 게이트에 맡김).
    """
    if _is_admin(user):
        return "operate"
    bindings = db.query(ClusterBinding).filter(ClusterBinding.cluster_id == cluster_id).all()
    if not bindings:
        return "operate"
    tenant_ids = {
        row.tenant_id
        for row in db.query(TenantMember.tenant_id).filter(TenantMember.user_id == user.id).all()
    }
    best: str | None = None
    for b in bindings:
        if b.tenant_id in tenant_ids and _RANK.get(b.access, 0) > _RANK.get(best or "", 0):
            best = b.access
    return best


def has_cluster_access(db: Session, user: User, cluster_id: UUID, level: str = "operate") -> bool:
    got = cluster_access_level(db, user, cluster_id)
    return got is not None and _RANK.get(got, 0) >= _RANK[level]


def _deny(cluster_id: UUID, level: str) -> HTTPException:
    what = "실행·변경" if level == "operate" else "조회"
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(f"이 클러스터({cluster_id})에 대한 {what} 권한이 없습니다. "
                "테넌트 바인딩을 확인하세요 (Settings → 테넌트)."),
    )


def require_cluster_access(db: Session, user: User, cluster_id: UUID | None, level: str = "operate") -> None:
    """핸들러 안에서 직접 호출하는 형태 — 본문/쿼리로 클러스터를 받는 엔드포인트용."""
    if cluster_id is None:
        return
    if not has_cluster_access(db, user, cluster_id, level):
        raise _deny(cluster_id, level)


def require_clusters_access(db: Session, user: User, cluster_ids: Iterable[UUID | None], level: str = "operate") -> None:
    for cid in {c for c in cluster_ids if c is not None}:
        require_cluster_access(db, user, cid, level)


def cluster_ids_for_hosts(db: Session, hosts: Iterable[str]) -> set[UUID]:
    """호스트(IP/호스트명)들이 속한 클러스터 — 노드 SSH·일괄 실행처럼 host 로 접속하는 경로의 범위 판정용.

    ``clusters.node_ips``(수집된 InternalIP JSON 배열)와 ``infra_nodes``(ip_address/hostname)를 본다.
    어느 클러스터에도 매칭되지 않는 호스트(관리 서버 등)는 클러스터 범위 밖이라 결과에 없다.
    바인딩이 하나도 없으면(격리 미사용) 조회 없이 빈 집합 — 판정 결과가 같으므로 비용만 아낀다.
    """
    wanted = {h.strip() for h in hosts if h and h.strip()}
    if not wanted or db.query(ClusterBinding.id).first() is None:
        return set()
    out: set[UUID] = set()
    for cid, raw in db.query(Cluster.id, Cluster.node_ips).filter(Cluster.node_ips.isnot(None)).all():
        try:
            ips = json.loads(raw) if raw else []
        except (TypeError, ValueError):
            continue
        if isinstance(ips, list) and wanted & {str(ip).strip() for ip in ips}:
            out.add(cid)
    rows = (
        db.query(InfraNode.cluster_id)
        .filter(InfraNode.ip_address.in_(wanted) | InfraNode.hostname.in_(wanted))
        .all()
    )
    out.update(r.cluster_id for r in rows)
    return out


def cluster_ids_for_host(db: Session, host: str) -> set[UUID]:
    return cluster_ids_for_hosts(db, [host])


def enforce_path_cluster_access(request: Request, db: Session, user: User) -> None:
    """경로 파라미터 ``cluster_id`` 기준 강제 — 실행 계열 라우터 공통 의존성에서 호출.

    조회 메서드(GET 등)는 통과시킨다: 1단계 범위는 실행·변경 차단이고, 조회 범위 격리는
    2단계(클러스터 목록·대시보드 필터링)에서 함께 다룬다.
    """
    if request.method in _READ_METHODS:
        return
    raw = request.path_params.get("cluster_id")
    if raw is None:
        return
    try:
        cid = raw if isinstance(raw, UUID) else UUID(str(raw))
    except ValueError:
        return  # 형식 오류는 라우트 검증(422)에 맡긴다
    require_cluster_access(db, user, cid, "operate")
