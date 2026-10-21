"""공개 화면 공유 링크 관리 — 만료 기한이 있는 접근 토큰 발급·조회·폐기(require_admin + 감사).

공개 방식이 `link`(화면별 설정 `access_mode`)인 일일 리포트·외부 서비스는 이 링크로만 열린다.
토큰 원문은 발급 응답에서 한 번만 돌려주고 저장하지 않는다(services/public_pages.py).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.database import get_db
from app.models.public_share import PublicShareLink
from app.models.user import User
from app.services import audit_logger
from app.services import public_pages as _pp

router = APIRouter(prefix="/public-share-links", tags=["public-share-links"])


class ShareLinkBody(BaseModel):
    label: str = Field(..., min_length=1, max_length=200)
    page: str = Field("all", pattern="^(all|daily_report|external_services)$")
    expires_days: int = Field(7, ge=1, le=365)
    cluster_ids: Optional[list[str]] = None


@router.get("")
def list_links(include_inactive: bool = False, db: Session = Depends(get_db), _a: User = Depends(require_admin)):
    q = db.query(PublicShareLink)
    if not include_inactive:
        q = q.filter(PublicShareLink.revoked_at.is_(None), PublicShareLink.expires_at > datetime.utcnow())
    return {"links": [_pp.link_dict(x) for x in q.order_by(PublicShareLink.created_at.desc()).limit(500).all()]}


@router.post("")
def create_link(payload: ShareLinkBody, request: Request, db: Session = Depends(get_db),
                actor: User = Depends(require_admin)):
    token = _pp.new_token()
    link = PublicShareLink(
        label=payload.label.strip(), page=payload.page,
        cluster_ids=[str(c) for c in (payload.cluster_ids or []) if str(c).strip()] or None,
        token_hash=_pp.hash_token(token), token_prefix=token[:8],
        expires_at=datetime.utcnow() + timedelta(days=payload.expires_days), created_by=actor.username,
    )
    db.add(link)
    db.commit()
    audit_logger.record(db, action="public_share_link.create", actor=actor, status="success",
                        target_type="public_share_link", target_id=str(link.id),
                        details={"label": link.label, "page": link.page, "expires_days": payload.expires_days,
                                 "clusters": len(link.cluster_ids or [])}, request=request)
    return _pp.link_dict(link, token=token)


@router.delete("/{link_id}")
def revoke_link(link_id: UUID, request: Request, db: Session = Depends(get_db), actor: User = Depends(require_admin)):
    link = db.query(PublicShareLink).filter(PublicShareLink.id == link_id).first()
    if link is None:
        raise HTTPException(status_code=404, detail="공유 링크가 없습니다")
    if link.revoked_at is None:
        link.revoked_at = datetime.utcnow()
        db.commit()
    audit_logger.record(db, action="public_share_link.revoke", actor=actor, status="success",
                        target_type="public_share_link", target_id=str(link.id), details={"label": link.label},
                        request=request)
    return _pp.link_dict(link)
