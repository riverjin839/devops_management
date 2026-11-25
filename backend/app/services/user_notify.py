"""사용자 개인 알림(알림 종) 생성·설정 헬퍼.

받는 사람 판정
--------------
담당자 칸에는 username · 사번 · 이름(display_name) 이 섞여 저장된다. 이름은 중복될 수 있어서
문자열을 그대로 `recipient` 로 저장하고 조회 때 이름으로 매칭하면 동명이인이 서로의 알림을 본다.
그래서 생성 시점에 `UserIndex.resolve` 로 사용자를 찾아 `recipient_user_id` 를 채우고, 조회는 그
ID 로 한다. 이름이 두 명 이상에게 해당하면 아무에게도 보내지 않는다(잘못 보내는 것보다 낫다).

설정
----
이벤트 종류(`EVENT_CATALOG`) × 채널(앱/메일/메신저) 을 사용자가 고른다(`UserNotificationPref`).
앱을 끈 이벤트는 읽음 상태로 저장돼 이력에만 남는다. 외부 채널은 `external_status=pending` 으로
두고 `services/user_notify_delivery.deliver_pending` (Celery Beat 매분) 이 보낸다.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Iterable

from app.models.user_notification import UserNotification, UserNotificationPref

# ── 이벤트 카탈로그 ──────────────────────────────────────────────────────────
# category: work(업무 탭) | ops(운영 탭). defaults: 사용자가 바꾸지 않았을 때의 채널.
_OFF_EXT = {"inapp": True, "email": False, "webhook": False}

EVENT_CATALOG: dict[str, dict[str, Any]] = {
    "work_item_assigned": {"label": "업무 배정", "category": "work", "help": "내가 담당자로 지정됐을 때", "defaults": _OFF_EXT},
    "work_item_mention": {"label": "멘션", "category": "work", "help": "댓글에서 @이름 으로 언급됐을 때", "defaults": _OFF_EXT},
    "work_item_comment": {"label": "댓글", "category": "work", "help": "담당·등록·구독 중인 업무에 댓글이 달렸을 때", "defaults": _OFF_EXT},
    "work_item_status": {"label": "상태 변경", "category": "work", "help": "담당·등록·구독 중인 업무의 상태가 바뀌었을 때", "defaults": _OFF_EXT},
    "work_item_due_soon": {"label": "내일 마감", "category": "work", "help": "마감일이 내일인 담당 업무(매일 아침 1회)", "defaults": _OFF_EXT},
    "work_item_due_today": {"label": "오늘 마감", "category": "work", "help": "마감일(없으면 시작일)이 오늘인 담당 업무(매일 아침 1회)", "defaults": _OFF_EXT},
    "work_item_overdue": {"label": "지연 전환", "category": "work", "help": "어제가 마감이었는데 완료되지 않은 담당 업무(지연된 첫날 1회)", "defaults": _OFF_EXT},
    "voc_reply": {"label": "VOC 답변", "category": "work", "help": "내가 쓴 VOC 에 답변이 달렸을 때", "defaults": _OFF_EXT},
    "alert": {"label": "알람", "category": "ops", "help": "알람 인박스 알림 규칙이 나에게 보낸 알람", "defaults": _OFF_EXT},
    "k8s_event": {"label": "K8S 이벤트", "category": "ops", "help": "critical K8S 이벤트", "defaults": _OFF_EXT},
}

WORK_TYPES: frozenset[str] = frozenset(k for k, v in EVENT_CATALOG.items() if v["category"] == "work")
EXTERNAL_CHANNELS = ("email", "webhook")
DIGEST_MODES = ("immediate", "daily")


def category_of(type_: str | None) -> str:
    t = type_ or ""
    if t in WORK_TYPES or t.startswith("work_"):
        return "work"
    return "ops"


def _defaults_for(type_: str) -> dict[str, bool]:
    spec = EVENT_CATALOG.get(type_)
    return dict(spec["defaults"] if spec else _OFF_EXT)


# ── 사용자 찾기 ──────────────────────────────────────────────────────────────
class UserIndex:
    """활성 사용자 목록을 한 번 읽어 username · 사번 · 유일한 이름으로 찾는다."""

    def __init__(self, users: Iterable[Any]):
        self.by_username: dict[str, Any] = {}
        self.by_employee: dict[str, Any] = {}
        self.by_display: dict[str, list[Any]] = {}
        for u in users:
            if getattr(u, "username", None):
                self.by_username[u.username.strip()] = u
            if getattr(u, "employee_id", None):
                self.by_employee[str(u.employee_id).strip()] = u
            dn = (getattr(u, "display_name", None) or "").strip()
            if dn:
                self.by_display.setdefault(dn, []).append(u)

    @classmethod
    def load(cls, db) -> "UserIndex":
        from app.models.user import User

        return cls(db.query(User).filter(User.is_active.is_(True)).all())

    def resolve(self, name: str | None):
        n = (name or "").strip()
        if not n:
            return None
        if n in self.by_username:
            return self.by_username[n]
        if n in self.by_employee:
            return self.by_employee[n]
        hits = self.by_display.get(n) or []
        return hits[0] if len(hits) == 1 else None


# ── 설정 ─────────────────────────────────────────────────────────────────────
def effective_prefs(row: UserNotificationPref | None) -> dict[str, Any]:
    stored = (row.prefs if row is not None and isinstance(row.prefs, dict) else None) or {}
    events: dict[str, dict[str, bool]] = {}
    for key in EVENT_CATALOG:
        cur = _defaults_for(key)
        got = stored.get(key)
        if isinstance(got, dict):
            for ch in ("inapp", *EXTERNAL_CHANNELS):
                if ch in got:
                    cur[ch] = bool(got[ch])
        events[key] = cur
    return {
        "events": events,
        "digest_mode": (row.digest_mode if row is not None and row.digest_mode in DIGEST_MODES else "immediate"),
        "digest_hour": (row.digest_hour if row is not None and row.digest_hour else "09:00"),
        "quiet_start": row.quiet_start if row is not None else None,
        "quiet_end": row.quiet_end if row is not None else None,
    }


class PrefCache:
    """한 번의 팬아웃에서 사용자 설정을 사용자당 한 번만 읽는다."""

    def __init__(self, db):
        self.db = db
        self._cache: dict[Any, dict[str, Any]] = {}

    def get(self, user_id) -> dict[str, Any]:
        if user_id not in self._cache:
            row = None
            if user_id is not None:
                try:
                    row = self.db.query(UserNotificationPref).filter(
                        UserNotificationPref.user_id == user_id).first()
                except Exception:  # noqa: BLE001 — 설정을 못 읽어도 기본값으로 알림은 간다
                    row = None
            self._cache[user_id] = effective_prefs(row)
        return self._cache[user_id]


# ── 생성 ─────────────────────────────────────────────────────────────────────
def create_notification(
    db, *, type: str, title: str, body: str = "", link: str | None = None,
    user=None, recipient: str | None = None, work_item_id=None,
    dedupe_key: str | None = None, prefs: PrefCache | None = None,
) -> UserNotification | None:
    """알림 한 건을 만든다(커밋은 호출자가). 설정상 아무 채널도 없으면 None.

    `user` 를 찾았으면 `recipient_user_id` 로 판정되고, 못 찾았으면 `recipient` 문자열만 남는다
    (조회는 username·사번·유일한 이름일 때만 매칭 — `routers/notifications._mine_filter`).
    """
    user_id = getattr(user, "id", None)
    if dedupe_key and user_id is not None:
        exists = db.query(UserNotification.id).filter(
            UserNotification.recipient_user_id == user_id,
            UserNotification.dedupe_key == dedupe_key,
        ).first()
        if exists:
            return None
    cfg = (prefs or PrefCache(db)).get(user_id)["events"].get(type) or _defaults_for(type)
    external = [c for c in EXTERNAL_CHANNELS if cfg.get(c)] if user_id is not None else []
    inapp = bool(cfg.get("inapp", True))
    if not inapp and not external:
        return None
    name = (recipient or getattr(user, "username", None) or getattr(user, "display_name", None) or "").strip()
    if not name:
        return None
    now = datetime.utcnow()
    notif = UserNotification(
        recipient=name[:128],
        recipient_user_id=user_id,
        type=type,
        title=(title or "")[:200],
        body=body,
        link=link,
        work_item_id=work_item_id,
        dedupe_key=dedupe_key,
        is_read=not inapp,
        read_at=None if inapp else now,
        external_status="pending" if external else None,
        external_channels=external or None,
    )
    db.add(notif)
    return notif


def notify_names(
    db, names: Iterable[str], *, exclude_user_ids: Iterable[Any] = (), index: UserIndex | None = None,
    prefs: PrefCache | None = None, **kwargs,
) -> list[UserNotification]:
    """이름 목록(담당자 칸 등)을 사용자로 풀어 사용자당 한 건씩 만든다. 못 찾은 이름은 건너뛴다."""
    idx = index or UserIndex.load(db)
    pc = prefs or PrefCache(db)
    skip = {str(x) for x in exclude_user_ids if x is not None}
    seen: set[str] = set()
    out: list[UserNotification] = []
    for nm in names:
        user = idx.resolve(nm)
        if user is None or str(user.id) in skip or str(user.id) in seen:
            continue
        seen.add(str(user.id))
        n = create_notification(db, user=user, prefs=pc, **kwargs)
        if n is not None:
            out.append(n)
    return out


def restrict_to_cluster_viewers(db, query, cluster_id):
    """User 쿼리를 이 클러스터를 **볼 수 있는** 사용자로 좁힌다(테넌트 격리 — D-101/D-103).

    `cluster_access.hidden_cluster_ids` 와 같은 판정:
    - 사용자 직접 지정(`cluster_user_grants`)이 우선 — `none` 이면 제외, `read`/`operate` 면 포함.
    - 제한된 클러스터(바인딩 또는 read/operate 직접 지정이 있음)면 admin · 바인딩 테넌트 멤버 · 지정자만.
    - 제한이 없으면 `none` 지정자만 뺀다.
    """
    if cluster_id is None:
        return query
    from sqlalchemy import and_, or_, select

    from app.models.tenant import ClusterBinding, ClusterUserGrant, TenantMember
    from app.models.user import User

    hidden_users = select(ClusterUserGrant.user_id).where(
        ClusterUserGrant.cluster_id == cluster_id, ClusterUserGrant.access == "none")
    granted_users = select(ClusterUserGrant.user_id).where(
        ClusterUserGrant.cluster_id == cluster_id, ClusterUserGrant.access.in_(("read", "operate")))
    bound = [tid for (tid,) in db.query(ClusterBinding.tenant_id)
             .filter(ClusterBinding.cluster_id == cluster_id).all()]
    has_grants = db.query(ClusterUserGrant.id).filter(
        ClusterUserGrant.cluster_id == cluster_id,
        ClusterUserGrant.access.in_(("read", "operate"))).first() is not None
    not_hidden = or_(User.role == "admin", User.id.notin_(hidden_users))
    if not bound and not has_grants:
        return query.filter(not_hidden)
    allowed = [User.role == "admin", User.id.in_(granted_users)]
    if bound:
        allowed.append(User.id.in_(select(TenantMember.user_id).where(TenantMember.tenant_id.in_(bound))))
    return query.filter(and_(or_(*allowed), not_hidden))


def notify_broadcast(db, *, type: str, title: str, body: str = "", link: str | None = None,
                     roles: tuple[str, ...] | None = None, cluster_id=None) -> list[UserNotification]:
    """전체(또는 특정 role) 사용자에게 개인 알림을 **사용자별 행으로 팬아웃**한다.

    공유 `recipient="all"` 행은 조회에서 매칭되지 않았고 읽음 처리도 개인별로 안 됐다 — 생성
    시점에 나눈다. `roles` 를 주면 해당 role 사용자에게만, `cluster_id` 를 주면 그 클러스터를 볼 수
    있는 사용자에게만(테넌트 바인딩) 보낸다.
    """
    from app.models.user import User

    query = db.query(User).filter(User.is_active.is_(True))
    if roles:
        query = query.filter(User.role.in_(roles))
    query = restrict_to_cluster_viewers(db, query, cluster_id)

    pc = PrefCache(db)
    created: list[UserNotification] = []
    for user in query.all():
        n = create_notification(db, user=user, type=type, title=title, body=body, link=link, prefs=pc)
        if n is not None:
            created.append(n)
    return created


# ── 업무 이벤트 ──────────────────────────────────────────────────────────────
STATUS_LABELS = {
    "backlog": "백로그", "todo": "할 일", "in_progress": "진행 중",
    "review_test": "검토·테스트", "done": "완료",
}

_TAG_RE = re.compile(r"<[^>]+>")
# 이메일 주소(a@b.c)는 멘션이 아니다 — 앞 글자가 단어 문자가 아닐 때만 @ 로 본다.
_MENTION_RE = re.compile(r"(?<![\w@])@([0-9A-Za-z가-힣._\-]{1,64})")


def parse_mentions(text: str | None) -> list[str]:
    plain = _TAG_RE.sub(" ", text or "")
    out: list[str] = []
    for m in _MENTION_RE.findall(plain):
        tok = m.rstrip(".-_")
        if tok and tok not in out:
            out.append(tok)
    return out


def assignee_names(item) -> list[str]:
    raw = ",".join(x for x in [item.primary_assignee, item.secondary_assignee, item.assignee] if x)
    out: list[str] = []
    for n in (s.strip() for s in raw.split(",")):
        if n and n not in out:
            out.append(n)
    return out


def item_stakeholders(item) -> list[str]:
    """담당자(정/부) + 등록자 + 구독자."""
    names = assignee_names(item)
    for n in [item.created_by, *((getattr(item, "watchers", None) or []))]:
        n = (str(n) if n else "").strip()
        if n and n not in names:
            names.append(n)
    return names


def _who(actor) -> str:
    return (getattr(actor, "display_name", None) or getattr(actor, "username", None) or "누군가").strip()


def _label(item) -> str:
    return (item.title or item.category or "업무").strip()


def _item_link(item) -> str:
    return f"/tasks-mgmt/{item.id}"


def notify_work_item_comment(db, item, actor, comment) -> None:
    """댓글 → @멘션된 사람은 '멘션', 담당자·등록자·구독자는 '댓글' 알림(작성자 본인 제외, 중복 없음)."""
    idx = UserIndex.load(db)
    pc = PrefCache(db)
    who = _who(actor)
    label = _label(item)
    snippet = _TAG_RE.sub(" ", comment.body or "").strip()[:80]
    mentioned = notify_names(
        db, parse_mentions(comment.body), exclude_user_ids=[actor.id], index=idx, prefs=pc,
        type="work_item_mention", title=f"{who}님이 회원님을 언급했습니다",
        body=f"[{label}] {snippet}", link=_item_link(item), work_item_id=item.id,
    )
    already = [actor.id, *(n.recipient_user_id for n in mentioned)]
    # 멘션 설정을 꺼서 알림이 안 만들어진 사람도 댓글 알림으로 두 번 받지 않게 한다.
    for tok in parse_mentions(comment.body):
        u = idx.resolve(tok)
        if u is not None:
            already.append(u.id)
    notify_names(
        db, item_stakeholders(item), exclude_user_ids=already, index=idx, prefs=pc,
        type="work_item_comment", title=f"{who}님이 댓글을 남겼습니다",
        body=f"[{label}] {snippet}", link=_item_link(item), work_item_id=item.id,
    )


def notify_work_item_assigned(db, item, actor, names: Iterable[str]) -> None:
    """새로 담당자가 된 사람에게(본인이 본인을 지정한 경우 제외)."""
    names = [n for n in names if n]
    if not names:
        return
    notify_names(
        db, names, exclude_user_ids=[actor.id],
        type="work_item_assigned", title=f"{_who(actor)}님이 업무를 배정했습니다",
        body=f"[{_label(item)}] {(item.category or '').strip()}", link=_item_link(item), work_item_id=item.id,
    )


def notify_work_item_status(db, item, actor, prev: str | None, new: str | None) -> None:
    if not new or prev == new:
        return
    notify_names(
        db, item_stakeholders(item), exclude_user_ids=[actor.id],
        type="work_item_status", title=f"{_who(actor)}님이 상태를 바꿨습니다",
        body=f"[{_label(item)}] {STATUS_LABELS.get(prev or '', prev or '-')} → {STATUS_LABELS.get(new, new)}",
        link=_item_link(item), work_item_id=item.id,
    )


def notify_voc_reply(db, post, actor, reply_text) -> None:
    """VOC 관리자 답변 시 작성자(created_by)에게(본인 제외). VOC 는 사이드바 패널이라 link 없음."""
    author = (post.created_by or "").strip()
    if not author:
        return
    notify_names(
        db, [author], exclude_user_ids=[actor.id],
        type="voc_reply", title=f"{_who(actor)}님이 VOC에 답변했습니다",
        body=f"[{(post.title or 'VOC').strip()}] {(reply_text or '')[:80]}", link=None,
    )
