"""로그인 없는 공개 화면(일일 리포트·외부 서비스) 공용 — 노출 대상 클러스터 판정 + 공유 링크 접근 제어.

- 노출 클러스터: 설정 allowlist 가 있으면 그것만, 없으면 테넌트 바인딩이 없는(=전체 공유) 클러스터만 —
  테넌트로 격리한 클러스터가 비인증 화면으로 새지 않게.
- 공개 방식(화면별 설정 `access_mode`): `open` 이면 누구나, `link` 이면 유효한 공유 링크 토큰(`?t=`)이
  있어야 한다. 링크는 만료일·폐기·화면 범위(all|daily_report|external_services)·클러스터 제한을 가진다.
  토큰 원문은 저장하지 않고 SHA-256 해시로만 찾는다.
- 거절은 401 이 아니라 403 — 프론트 axios 인터셉터가 401 을 "로그인 만료"로 보고 로그인 세션을 지우므로,
  관리자가 잘못된 링크를 열어도 포털 세션이 끊기지 않게.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

PAGES = ("daily_report", "external_services")
ACCESS_MODES = ("open", "link")


def public_clusters(db: Session, allowlist: list[str] | None) -> list:
    from app.models import Cluster
    from app.models.tenant import ClusterBinding
    clusters = db.query(Cluster).all()
    if allowlist:
        allowed = set(allowlist)
        return sorted([c for c in clusters if str(c.id) in allowed], key=lambda c: c.name)
    bound = {cid for (cid,) in db.query(ClusterBinding.cluster_id).distinct().all()}
    return sorted([c for c in clusters if c.id not in bound], key=lambda c: c.name)


# ── 공유 링크 ──────────────────────────────────────────────────────────────────
def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(24)


def _deny(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=403, detail={"code": code, "message": message})


def authorize(db: Session, page: str, access_mode: str, token: Optional[str]):
    """공개 방식이 link 면 토큰을 검증해 링크를 돌려준다. open 이면 None(토큰은 무시)."""
    from app.models.public_share import PublicShareLink
    if access_mode != "link":
        return None
    if not token:
        raise _deny("share_link_required", "이 화면은 공유 링크로만 열 수 있습니다. 관리자에게 링크를 요청하세요.")
    link = db.query(PublicShareLink).filter(PublicShareLink.token_hash == hash_token(token)).first()
    if link is None or link.revoked_at is not None:
        raise _deny("share_link_invalid", "유효하지 않거나 폐기된 공유 링크입니다.")
    now = datetime.utcnow()
    if link.expires_at <= now:
        raise _deny("share_link_expired", f"만료된 공유 링크입니다(만료 {link.expires_at:%Y-%m-%d %H:%M} UTC).")
    if link.page not in ("all", page):
        raise _deny("share_link_scope", "이 공유 링크로는 열 수 없는 화면입니다.")
    # 사용 기록 — 같은 화면을 열면 API 가 여러 번 불리므로 1분에 한 번만 갱신한다.
    if link.last_used_at is None or now - link.last_used_at > timedelta(minutes=1):
        link.last_used_at = now
        link.use_count = (link.use_count or 0) + 1
        db.commit()
    return link


def filter_by_link(clusters: list, link) -> list:
    if link is None or not link.cluster_ids:
        return clusters
    allowed = {str(c) for c in link.cluster_ids}
    return [c for c in clusters if str(c.id) in allowed]


def link_dict(link, token: Optional[str] = None) -> dict[str, Any]:
    now = datetime.utcnow()
    state = ("revoked" if link.revoked_at else "expired" if link.expires_at <= now else "active")
    out = {
        "id": str(link.id), "label": link.label, "page": link.page, "cluster_ids": link.cluster_ids or [],
        "token_prefix": link.token_prefix, "expires_at": link.expires_at.isoformat(),
        "created_by": link.created_by, "created_at": link.created_at.isoformat(),
        "revoked_at": link.revoked_at.isoformat() if link.revoked_at else None,
        "last_used_at": link.last_used_at.isoformat() if link.last_used_at else None,
        "use_count": link.use_count or 0, "state": state,
    }
    if token:
        out["token"] = token
    return out
