"""로그인 없는 공개 화면(일일 리포트·외부 서비스) 공용 — 노출 대상 클러스터 판정.

설정 allowlist 가 있으면 그것만, 없으면 테넌트 바인딩이 없는(=전체 공유) 클러스터만 공개한다 —
테넌트로 격리한 클러스터가 비인증 화면으로 새지 않게.
"""
from __future__ import annotations

from sqlalchemy.orm import Session


def public_clusters(db: Session, allowlist: list[str] | None) -> list:
    from app.models import Cluster
    from app.models.tenant import ClusterBinding
    clusters = db.query(Cluster).all()
    if allowlist:
        allowed = set(allowlist)
        return sorted([c for c in clusters if str(c.id) in allowed], key=lambda c: c.name)
    bound = {cid for (cid,) in db.query(ClusterBinding.cluster_id).distinct().all()}
    return sorted([c for c in clusters if c.id not in bound], key=lambda c: c.name)
