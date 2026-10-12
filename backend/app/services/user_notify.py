"""사용자 개인 인앱 알림(알림 종) 생성 헬퍼.

recipient 는 담당자 '이름' 또는 '사번/username' 둘 다 저장될 수 있고, 조회 시 현재 사용자의
username/display_name 집합과 매칭한다(work item 담당자 식별자 불일치 대응).
"""
from app.models.user_notification import UserNotification


def restrict_to_cluster_viewers(db, query, cluster_id):
    """User 쿼리를 이 클러스터를 **볼 수 있는** 사용자로 좁힌다(테넌트 격리 — D-101/D-103).

    바인딩이 없는 클러스터(또는 cluster_id 없음)는 그대로 둔다. 바인딩이 있으면 admin 과
    바인딩된 테넌트의 멤버만 남긴다 — `cluster_access.hidden_cluster_ids` 와 같은 판정.
    """
    if cluster_id is None:
        return query
    from sqlalchemy import or_, select

    from app.models.tenant import ClusterBinding, TenantMember
    from app.models.user import User

    bound = [tid for (tid,) in db.query(ClusterBinding.tenant_id)
             .filter(ClusterBinding.cluster_id == cluster_id).all()]
    if not bound:
        return query
    members = select(TenantMember.user_id).where(TenantMember.tenant_id.in_(bound))
    return query.filter(or_(User.role == "admin", User.id.in_(members)))


def notify_broadcast(db, *, type: str, title: str, body: str = "", link: str | None = None,
                     roles: tuple[str, ...] | None = None, cluster_id=None) -> list[UserNotification]:
    """전체(또는 특정 role) 사용자에게 개인 알림을 **사용자별 행으로 팬아웃**한다.

    과거에는 `recipient="all"` 공유 행 하나를 넣었는데, 조회 쪽(`_me_ids`)이 그 센티널을
    매칭하지 않아 전체 공지가 아무에게도 보이지 않았다. 공유 행은 읽음 처리도 개인별로
    안 되므로(한 명이 읽으면 전원 읽음) 생성 시점에 나누는 쪽이 맞다.

    `roles` 를 주면 해당 role 사용자에게만 보낸다 (예: ("admin", "operator")).
    `cluster_id` 를 주면 그 클러스터를 볼 수 있는 사용자에게만 보낸다(테넌트 바인딩).
    """
    from app.models.user import User

    query = db.query(User).filter(User.is_active.is_(True))
    if roles:
        query = query.filter(User.role.in_(roles))
    query = restrict_to_cluster_viewers(db, query, cluster_id)

    created: list[UserNotification] = []
    for user in query.all():
        recipient = (user.username or user.display_name or "").strip()
        if not recipient:
            continue
        notif = UserNotification(
            recipient=recipient, type=type, title=title[:200], body=body, link=link)
        db.add(notif)
        created.append(notif)
    return created


def notify_work_item_comment(db, item, actor, comment) -> None:
    """댓글 작성 시 담당자(정/부) + 등록자에게 개인 알림 생성(작성자 본인 제외)."""
    actor_ids = {x.strip() for x in [actor.username, actor.display_name] if x}
    recipients: set[str] = set()
    for nm in [item.primary_assignee, item.assignee]:
        if nm and nm.strip():
            recipients.add(nm.strip())
    if item.secondary_assignee:
        for nm in item.secondary_assignee.split(","):
            if nm.strip():
                recipients.add(nm.strip())
    if item.created_by and item.created_by.strip():
        recipients.add(item.created_by.strip())
    recipients -= actor_ids
    if not recipients:
        return
    who = (actor.display_name or actor.username or "누군가").strip()
    label = (item.title or item.category or "업무").strip()
    snippet = (comment.body or "")[:80]
    for r in recipients:
        db.add(UserNotification(
            recipient=r,
            type="work_item_comment",
            title=f"{who}님이 댓글을 남겼습니다",
            body=f"[{label}] {snippet}",
            link=f"/tasks-mgmt/{item.id}",
            work_item_id=item.id,
        ))


def notify_voc_reply(db, post, actor, reply_text) -> None:
    """VOC 관리자 답변 시 작성자(created_by)에게 개인 알림 생성(작성자 본인 제외).

    VOC 게시판은 라우트가 아닌 사이드바 패널이므로 link 는 두지 않는다.
    """
    actor_ids = {x.strip() for x in [actor.username, actor.display_name] if x}
    author = (post.created_by or "").strip()
    if not author or author in actor_ids:
        return
    who = (actor.display_name or actor.username or "관리자").strip()
    label = (post.title or "VOC").strip()
    snippet = (reply_text or "")[:80]
    db.add(UserNotification(
        recipient=author,
        type="voc_reply",
        title=f"{who}님이 VOC에 답변했습니다",
        body=f"[{label}] {snippet}",
        link=None,
    ))
