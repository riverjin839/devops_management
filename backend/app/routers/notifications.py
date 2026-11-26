"""개인 알림(알림 종·알림 화면) + 알림 채널 CRUD·테스트 발송·발송 이력.

개인 알림 — 로그인한 사용자 본인 것만(`_mine_filter`). 채널 — 조회는 operator(비밀 값 가림),
생성·수정·삭제·테스트 발송·발송 이력은 admin.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from datetime import datetime
from typing import Any, Literal, Optional
from urllib.parse import urlparse
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, desc, func, or_
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import SessionLocal, get_db
from app.models import (
    NotificationChannel,
    NotificationChannelType,
    NotificationLog,
)
from app.models.user import User
from app.models.user_notification import UserNotification, UserNotificationPref
from app.services import audit_logger
from app.services.notifier import send_via_channel
from app.services.user_notify import (
    DIGEST_MODES, EVENT_CATALOG, WORK_TYPES, category_of, effective_prefs,
)

router = APIRouter(prefix="/notifications", tags=["Notifications"])


# ── 개인 인앱 알림 ────────────────────────────────────────────────────────────
def _legacy_names(db: Session, user: User) -> list[str]:
    """`recipient_user_id` 가 비어 있는 예전 행을 내 것으로 볼 문자열.

    username·사번은 유일하므로 그대로, 이름(display_name)은 같은 이름의 사용자가 나 하나일 때만 —
    동명이인이면 이름으로 저장된 예전 알림은 누구에게도 보이지 않는다(잘못 보이는 것보다 낫다).
    """
    out = [x.strip() for x in [user.username, user.employee_id] if x and str(x).strip()]
    dn = (user.display_name or "").strip()
    if dn and dn not in out:
        same = db.query(func.count(User.id)).filter(User.display_name == dn).scalar() or 0
        if same == 1:
            out.append(dn)
    return out


def _mine_filter(db: Session, user: User):
    legacy = _legacy_names(db, user)
    conds = [UserNotification.recipient_user_id == user.id]
    if legacy:
        conds.append(and_(UserNotification.recipient_user_id.is_(None), UserNotification.recipient.in_(legacy)))
    return or_(*conds)


def _work_cond():
    return or_(UserNotification.type.in_(WORK_TYPES), UserNotification.type.like("work\\_%"))


def _category_filter(q, category: str | None):
    if category == "work":
        return q.filter(_work_cond())
    if category == "ops":
        return q.filter(~_work_cond())
    return q


def _notif_dict(n: UserNotification) -> dict:
    return {
        "id": str(n.id),
        "type": n.type,
        "type_label": (EVENT_CATALOG.get(n.type) or {}).get("label", n.type),
        "category": category_of(n.type),
        "title": n.title,
        "body": n.body,
        "link": n.link,
        "work_item_id": str(n.work_item_id) if n.work_item_id else None,
        "is_read": n.is_read,
        "read_at": n.read_at.isoformat() if n.read_at else None,
        "external_status": n.external_status,
        "external_channels": n.external_channels or [],
        "external_error": n.external_error,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


def _unread_counts(db: Session, user: User) -> dict[str, int]:
    base = db.query(UserNotification).filter(_mine_filter(db, user), UserNotification.is_read.is_(False))
    total = base.count()
    work = base.filter(_work_cond()).count()
    return {"unread": total, "unread_work": work, "unread_ops": total - work}


@router.get("/my")
def my_notifications(limit: int = 30, category: Optional[Literal["work", "ops"]] = None,
                     db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """종 패널용 — 안 읽은 알림만(읽으면 빠진다). 전체 이력은 `/my/history`."""
    q = db.query(UserNotification).filter(_mine_filter(db, user), UserNotification.is_read.is_(False))
    q = _category_filter(q, category)
    rows = q.order_by(desc(UserNotification.created_at)).limit(min(max(limit, 1), 100)).all()
    return {"data": [_notif_dict(n) for n in rows], **_unread_counts(db, user)}


@router.get("/my/history")
def my_notification_history(
    offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=1000),
    category: Optional[Literal["work", "ops"]] = None, type: Optional[str] = None,
    unread_only: bool = False, q: Optional[str] = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    """알림 화면 — 읽은 알림 포함 전체 이력(보존 90일)."""
    query = db.query(UserNotification).filter(_mine_filter(db, user))
    query = _category_filter(query, category)
    if type:
        query = query.filter(UserNotification.type == type)
    if unread_only:
        query = query.filter(UserNotification.is_read.is_(False))
    if q and q.strip():
        pat = f"%{q.strip()}%"
        query = query.filter(or_(UserNotification.title.ilike(pat), UserNotification.body.ilike(pat)))
    total = query.count()
    rows = query.order_by(desc(UserNotification.created_at)).offset(offset).limit(limit).all()
    return {"data": [_notif_dict(n) for n in rows], "total": total, "offset": offset, "limit": limit,
            "has_more": offset + len(rows) < total, **_unread_counts(db, user)}


def _my_row_or_404(db: Session, user: User, nid: UUID) -> UserNotification:
    n = db.query(UserNotification).filter(UserNotification.id == nid, _mine_filter(db, user)).first()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")
    return n


@router.post("/my/{nid}/read")
def mark_notification_read(nid: UUID, db: Session = Depends(get_db),
                           user: User = Depends(get_current_user)):
    n = _my_row_or_404(db, user, nid)
    if not n.is_read:
        n.is_read = True
        n.read_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.post("/my/{nid}/unread")
def mark_notification_unread(nid: UUID, db: Session = Depends(get_db),
                             user: User = Depends(get_current_user)):
    n = _my_row_or_404(db, user, nid)
    n.is_read = False
    n.read_at = None
    db.commit()
    return {"ok": True}


@router.delete("/my/{nid}")
def delete_my_notification(nid: UUID, db: Session = Depends(get_db),
                           user: User = Depends(get_current_user)):
    n = _my_row_or_404(db, user, nid)
    db.delete(n)
    db.commit()
    return {"ok": True}


@router.post("/my/read-all")
def mark_all_notifications_read(category: Optional[Literal["work", "ops"]] = None,
                                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(UserNotification).filter(_mine_filter(db, user), UserNotification.is_read.is_(False))
    q = _category_filter(q, category)
    updated = q.update({UserNotification.is_read: True, UserNotification.read_at: datetime.utcnow()},
                       synchronize_session=False)
    db.commit()
    return {"ok": True, "updated": updated}


# ── 실시간 스트림 (SSE) ──────────────────────────────────────────────────────
STREAM_POLL_SEC = 5
STREAM_HEARTBEAT_SEC = 25
# 연결 하나가 워커를 오래 붙잡지 않게 일정 시간 뒤 끊는다 — 클라이언트가 곧바로 다시 연결한다.
STREAM_MAX_SEC = 600


def _stream_snapshot(user_id) -> dict[str, Any]:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if user is None:
            return {}
        counts = _unread_counts(db, user)
        latest = (db.query(UserNotification)
                  .filter(_mine_filter(db, user), UserNotification.is_read.is_(False))
                  .order_by(desc(UserNotification.created_at)).first())
        return {**counts, "latest": _notif_dict(latest) if latest else None}
    finally:
        db.close()


@router.get("/my/stream")
async def my_notification_stream(request: Request, user: User = Depends(get_current_user)):
    """안 읽은 알림 수가 바뀌면 `{type:"unread", unread, unread_work, unread_ops, latest}` 를 보낸다.

    새 알림은 `latest.id` 가 바뀌는 것으로 알 수 있다(화면은 그때 토스트를 띄운다). DB 를 5초마다
    본다 — Redis 등 다른 의존 없이 동작하고, 알림 생성 경로를 건드리지 않는다.
    """
    user_id = user.id

    async def gen():
        from starlette.concurrency import run_in_threadpool

        last_sig = None
        started = asyncio.get_event_loop().time()
        last_beat = started
        while True:
            if await request.is_disconnected():
                break
            now = asyncio.get_event_loop().time()
            if now - started > STREAM_MAX_SEC:
                yield "data: " + json.dumps({"type": "reconnect"}) + "\n\n"
                break
            try:
                snap = await run_in_threadpool(_stream_snapshot, user_id)
            except Exception:  # noqa: BLE001 — DB 일시 오류는 다음 주기에 다시 본다
                snap = None
            if snap is not None:
                sig = (snap.get("unread"), (snap.get("latest") or {}).get("id"))
                if sig != last_sig:
                    last_sig = sig
                    yield "data: " + json.dumps({"type": "unread", **snap}, ensure_ascii=False) + "\n\n"
                    last_beat = now
            if now - last_beat >= STREAM_HEARTBEAT_SEC:
                yield ": ping\n\n"
                last_beat = now
            await asyncio.sleep(STREAM_POLL_SEC)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             # identity — GZipMiddleware 가 SSE 를 압축하면 zlib 버퍼링으로 이벤트가 안 나간다(main.py 주석).
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                                      "Content-Encoding": "identity"})


# ── 개인 알림 설정 ────────────────────────────────────────────────────────────
_HM_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class EventChannels(BaseModel):
    type: str
    inapp: bool = True
    email: bool = False
    webhook: bool = False


class PrefsIn(BaseModel):
    # 목록으로 주고받는다 — 화면의 axios 인터셉터가 객체 *키* 를 camelCase 로 바꿔서
    # {"work_item_assigned": …} 맵은 화면에서 "workItemAssigned" 가 돼 카탈로그와 어긋난다.
    events: list[EventChannels] = Field(default_factory=list)
    digest_mode: Literal["immediate", "daily"] = "immediate"
    digest_hour: str = Field("09:00", pattern=_HM_PATTERN)
    quiet_start: Optional[str] = Field(None, pattern=_HM_PATTERN)
    quiet_end: Optional[str] = Field(None, pattern=_HM_PATTERN)


def _catalog_list() -> list[dict[str, Any]]:
    return [{"type": k, "label": v["label"], "category": v["category"], "help": v["help"],
             "defaults": v["defaults"]} for k, v in EVENT_CATALOG.items()]


def _prefs_response(db: Session, user: User, row: UserNotificationPref | None) -> dict[str, Any]:
    from app.services.user_notify_delivery import get_delivery_settings

    cfg = get_delivery_settings(db)
    eff = effective_prefs(row)
    return {
        **eff,
        "events": [{"type": k, **v} for k, v in eff["events"].items()],
        "catalog": _catalog_list(),
        "digest_modes": list(DIGEST_MODES),
        # 화면 안내용 — 관리자가 채널을 지정하지 않았거나 내 메일이 없으면 그 채널은 보내지지 않는다.
        "available": {
            "email": bool(cfg.get("enabled") and cfg.get("email_channel_id")),
            "webhook": bool(cfg.get("enabled") and cfg.get("webhook_channel_id")),
        },
        "my_email": user.email,
    }


@router.get("/my/prefs")
def get_my_prefs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.query(UserNotificationPref).filter(UserNotificationPref.user_id == user.id).first()
    return _prefs_response(db, user, row)


@router.put("/my/prefs")
def put_my_prefs(body: PrefsIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    unknown = [e.type for e in body.events if e.type not in EVENT_CATALOG]
    if unknown:
        raise HTTPException(status_code=422, detail=f"알 수 없는 알림 종류: {', '.join(unknown)}")
    if bool(body.quiet_start) != bool(body.quiet_end):
        raise HTTPException(status_code=422, detail="방해 금지 시간은 시작·끝을 함께 지정하세요.")
    row = db.query(UserNotificationPref).filter(UserNotificationPref.user_id == user.id).first()
    if row is None:
        row = UserNotificationPref(user_id=user.id, prefs={})
        db.add(row)
    row.prefs = {e.type: e.model_dump(exclude={"type"}) for e in body.events}
    row.digest_mode = body.digest_mode
    row.digest_hour = body.digest_hour
    row.quiet_start = body.quiet_start
    row.quiet_end = body.quiet_end
    db.commit()
    db.refresh(row)
    return _prefs_response(db, user, row)


# ── 외부 발송 채널 지정 (관리자) ──────────────────────────────────────────────
class DeliveryIn(BaseModel):
    enabled: bool = True
    email_channel_id: Optional[UUID] = None
    webhook_channel_id: Optional[UUID] = None
    app_base_url: str = ""


@router.get("/delivery-settings")
def get_delivery(db: Session = Depends(get_db), _: User = Depends(require_operator)):
    from app.services.user_notify_delivery import get_delivery_settings

    return get_delivery_settings(db)


@router.put("/delivery-settings")
def put_delivery(body: DeliveryIn, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_admin)):
    from app.services.user_notify_delivery import set_delivery_settings

    for kind, cid, want in (("메일", body.email_channel_id, NotificationChannelType.email),
                            ("메신저", body.webhook_channel_id, NotificationChannelType.webhook)):
        if cid is None:
            continue
        ch = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
        if ch is None:
            raise HTTPException(status_code=422, detail=f"{kind} 채널을 찾을 수 없습니다.")
        if ch.channel_type != want:
            raise HTTPException(status_code=422, detail=f"{kind} 채널은 {want.value} 형이어야 합니다.")
    if body.app_base_url and urlparse(body.app_base_url).scheme not in ("http", "https"):
        raise HTTPException(status_code=422, detail="PEP 주소는 http(s):// 로 시작해야 합니다.")
    out = set_delivery_settings(db, body.model_dump(mode="json"))
    audit_logger.record(db, action="notifications.delivery.update", actor=actor,
                        target_type="app_setting", details=out, request=request)
    return out


# ── 알림 채널 ─────────────────────────────────────────────────────────────────
MASK = "********"
# 채널 설정에서 응답에 그대로 내보내지 않는 값. admin 이 아니면 URL 도 가린다(Slack 웹훅 URL 은 그 자체가 토큰).
_SECRET_KEYS = ("smtp_password",)
_URL_KEYS = ("webhook_url", "url")


def _mask_config(cfg: dict[str, Any] | None, *, is_admin: bool) -> dict[str, Any] | None:
    if cfg is None:
        return None
    out = dict(cfg)
    for k in _SECRET_KEYS:
        if out.get(k):
            out[k] = MASK
    if isinstance(out.get("headers"), dict):
        out["headers"] = {k: MASK for k in out["headers"]}
    if not is_admin:
        for k in _URL_KEYS:
            if out.get(k):
                out[k] = MASK
    return out


def _merge_masked(new: dict[str, Any] | None, old: dict[str, Any] | None) -> dict[str, Any] | None:
    """화면이 가린 값(`********`)을 그대로 돌려보내면 저장된 원래 값을 유지한다."""
    if new is None:
        return None
    old = old or {}
    out = dict(new)
    for k, v in list(out.items()):
        if v == MASK:
            out[k] = old.get(k)
    if isinstance(out.get("headers"), dict):
        old_h = old.get("headers") if isinstance(old.get("headers"), dict) else {}
        out["headers"] = {k: (old_h.get(k) if v == MASK else v) for k, v in out["headers"].items()}
    return out


_BLOCKED_HOSTS = {"metadata.google.internal", "metadata", "instance-data"}


def _validate_target_url(url: str | None, field: str) -> None:
    """웹훅 대상 검증 — http(s) 만, 루프백·링크 로컬(클라우드 메타데이터 169.254.x)은 거부.

    사내 메신저 게이트웨이가 사설 IP 에 있는 경우가 흔해 사설 대역은 막지 않는다(폐쇄망).
    """
    if not url:
        return
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HTTPException(status_code=422, detail=f"{field}: http(s):// 주소여야 합니다.")
    host = p.hostname.lower()
    if host in _BLOCKED_HOSTS or host == "localhost" or host.endswith(".localhost"):
        raise HTTPException(status_code=422, detail=f"{field}: 이 서버 자신·메타데이터 주소로는 보낼 수 없습니다.")
    addrs: list[str] = []
    try:
        ipaddress.ip_address(host)
        addrs = [host]
    except ValueError:
        try:
            addrs = list({ai[4][0] for ai in socket.getaddrinfo(host, None)})
        except OSError:
            addrs = []  # 이름을 못 풀면(폐쇄망 DNS 등) 형식 검사만 한다 — 발송 때 실패로 기록된다
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            raise HTTPException(status_code=422, detail=f"{field}: 루프백·링크 로컬 주소({a})로는 보낼 수 없습니다.")


def _validate_channel_config(channel_type: NotificationChannelType, cfg: dict[str, Any] | None) -> None:
    cfg = cfg or {}
    if channel_type == NotificationChannelType.slack:
        _validate_target_url(cfg.get("webhook_url"), "webhook_url")
    elif channel_type == NotificationChannelType.webhook:
        _validate_target_url(cfg.get("url"), "url")


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


def _channel_out(row: NotificationChannel, *, is_admin: bool) -> ChannelOut:
    out = ChannelOut.model_validate(row)
    out.config = _mask_config(row.config, is_admin=is_admin)
    return out


@router.get("/channels", response_model=list[ChannelOut])
def list_channels(db: Session = Depends(get_db), user: User = Depends(require_operator)):
    """알림 규칙 편집기(operator)가 채널을 고를 수 있게 조회는 operator 까지 — 비밀 값은 가린다."""
    rows = db.query(NotificationChannel).order_by(NotificationChannel.created_at.desc()).all()
    return [_channel_out(r, is_admin=user.role == "admin") for r in rows]


@router.post("/channels", response_model=ChannelOut)
def create_channel(body: ChannelIn, request: Request, db: Session = Depends(get_db),
                   actor: User = Depends(require_admin)):
    data = body.model_dump()
    if data.get("config"):
        data["config"] = {k: v for k, v in data["config"].items() if v != MASK}
    _validate_channel_config(body.channel_type, data.get("config"))
    row = NotificationChannel(**data)
    db.add(row)
    db.commit()
    db.refresh(row)
    audit_logger.record(db, action="notifications.channel.create", actor=actor, target_type="notification_channel",
                        target_id=row.id, details={"name": row.name, "type": row.channel_type.value},
                        request=request)
    return _channel_out(row, is_admin=True)


@router.put("/channels/{cid}", response_model=ChannelOut)
def update_channel(cid: UUID, body: ChannelIn, request: Request, db: Session = Depends(get_db),
                   actor: User = Depends(require_admin)):
    row = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    data = body.model_dump()
    data["config"] = _merge_masked(data.get("config"), row.config)
    _validate_channel_config(body.channel_type, data.get("config"))
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    audit_logger.record(db, action="notifications.channel.update", actor=actor, target_type="notification_channel",
                        target_id=row.id, details={"name": row.name, "type": row.channel_type.value},
                        request=request)
    return _channel_out(row, is_admin=True)


@router.delete("/channels/{cid}")
def delete_channel(cid: UUID, request: Request, db: Session = Depends(get_db),
                   actor: User = Depends(require_admin)):
    row = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    name = row.name
    db.delete(row)
    db.commit()
    audit_logger.record(db, action="notifications.channel.delete", actor=actor, target_type="notification_channel",
                        target_id=cid, details={"name": name}, request=request)
    return {"status": "ok"}


@router.post("/test/{cid}", response_model=NotificationLogOut)
def test_channel(cid: UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    row = db.query(NotificationChannel).filter(NotificationChannel.id == cid).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    _validate_channel_config(row.channel_type, row.config)
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
def list_log(limit: int = 50, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return (
        db.query(NotificationLog)
        .order_by(desc(NotificationLog.sent_at))
        .limit(min(max(limit, 1), 500))
        .all()
    )

