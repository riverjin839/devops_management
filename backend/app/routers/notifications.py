"""Notification 채널 CRUD + 테스트 발송 + 발송 이력."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    NotificationChannel,
    NotificationChannelType,
    NotificationLog,
)
from app.models.user_notification import UserNotification
from app.models.user import User
from app.auth.deps import get_current_user
from app.services.notifier import send_via_channel

router = APIRouter(prefix="/notifications", tags=["Notifications"])


# ── 개인 인앱 알림 (알림 종) ──────────────────────────────────────────────────
def _me_ids(user: User) -> list[str]:
    """현재 사용자로 인정할 recipient 값들.

    담당자 식별자가 username / display_name 어느 쪽으로 저장됐는지 확정할 수 없어 둘 다 본다.
    **전체 공지는 여기서 매칭하지 않는다** — `services/user_notify.notify_broadcast()` 가
    생성 시점에 사용자별 행으로 팬아웃하므로, 읽음 처리가 개인별로 정확히 동작한다.
    (과거에는 `recipient="all"` 공유 행을 썼는데 이 함수가 그 값을 매칭하지 않아 전체 공지가
    아무에게도 보이지 않았다.)
    """
    return [x.strip() for x in [user.username, user.display_name] if x and x.strip()]


def _notif_dict(n: UserNotification) -> dict:
    return {
        "id": str(n.id),
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "link": n.link,
        "work_item_id": str(n.work_item_id) if n.work_item_id else None,
        "is_read": n.is_read,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@router.get("/my")
def my_notifications(limit: int = 30, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """읽은 알림은 반환하지 않는다 — 벨은 안읽은 알림만 보여주고, 읽음 처리(개별 클릭
    또는 지우기 버튼)되는 즉시 다음 조회에서 자동으로 빠진다(아이폰 알림센터 방식)."""
    ids = _me_ids(user)
    if not ids:
        return {"data": [], "unread": 0}
    unread_q = db.query(UserNotification).filter(
        UserNotification.recipient.in_(ids),
        UserNotification.is_read.is_(False),
    )
    rows = unread_q.order_by(desc(UserNotification.created_at)).limit(min(max(limit, 1), 100)).all()
    unread = unread_q.count()
    return {"data": [_notif_dict(n) for n in rows], "unread": unread}


@router.post("/my/{nid}/read")
def mark_notification_read(nid: UUID, db: Session = Depends(get_db),
                           user: User = Depends(get_current_user)):
    ids = _me_ids(user)
    n = db.query(UserNotification).filter(
        UserNotification.id == nid, UserNotification.recipient.in_(ids),
    ).first()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")
    n.is_read = True
    db.commit()
    return {"ok": True}


@router.post("/my/read-all")
def mark_all_notifications_read(db: Session = Depends(get_db),
                               user: User = Depends(get_current_user)):
    ids = _me_ids(user)
    if ids:
        db.query(UserNotification).filter(
            UserNotification.recipient.in_(ids), UserNotification.is_read.is_(False),
        ).update({UserNotification.is_read: True}, synchronize_session=False)
        db.commit()
    return {"ok": True}


class ChannelIn(BaseModel):
    name: str
    channel_type: NotificationChannelType
    enabled: bool = True
    cluster_id: Optional[UUID] = None
    min_severity: str = "warning"
    config: Optional[dict[str, Any]] = None


class ChannelOut(BaseModel):
    id: UUID
    name: str
    channel_type: NotificationChannelType
    enabled: bool
    cluster_id: Optional[UUID] = None
    min_severity: str
    config: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class NotificationLogOut(BaseModel):
    id: UUID
    channel_id: Optional[UUID] = None
    daily_check_log_id: Optional[UUID] = None
    status: str
    subject: Optional[str] = None
    body: Optional[str] = None
    error: Optional[str] = None
    sent_at: datetime

    class Config:
        from_attributes = True


@router.get("/channels", response_model=list[ChannelOut])
def list_channels(db: Session = Depends(get_db)):
    return db.query(NotificationChannel).order_by(NotificationChannel.created_at.desc()).all()


@router.post("/channels", response_model=ChannelOut)
def create_channel(body: ChannelIn, db: Session = Depends(get_db)):
    row = NotificationChannel(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/channels/{cid}", response_model=ChannelOut)
def update_channel(cid: UUID, body: ChannelIn, db: Session = Depends(get_db)):
    row = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/channels/{cid}")
def delete_channel(cid: UUID, db: Session = Depends(get_db)):
    row = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    db.delete(row)
    db.commit()
    return {"status": "ok"}


@router.post("/test/{cid}", response_model=NotificationLogOut)
def test_channel(cid: UUID, db: Session = Depends(get_db)):
    row = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    log = send_via_channel(
        db,
        row,
        subject=f"[TEST] {row.name}",
        body=(
            "이것은 DEVOPS MANAGEMENT 일일 점검 알림 테스트입니다.\n"
            "수신 측에서 이 메시지를 확인했다면 채널 설정이 정상입니다."
        ),
    )
    return log


@router.get("/log", response_model=list[NotificationLogOut])
def list_log(limit: int = 50, db: Session = Depends(get_db)):
    return (
        db.query(NotificationLog)
        .order_by(desc(NotificationLog.sent_at))
        .limit(limit)
        .all()
    )
