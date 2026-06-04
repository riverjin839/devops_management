"""사용자 개인 인앱 알림(알림 종) 생성 헬퍼.

recipient 는 담당자 '이름' 또는 '사번/username' 둘 다 저장될 수 있고, 조회 시 현재 사용자의
username/display_name 집합과 매칭한다(work item 담당자 식별자 불일치 대응).
"""
from app.models.user_notification import UserNotification


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
