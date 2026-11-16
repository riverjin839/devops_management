"""``dc_change_logs`` 기록 — 데이터 변경과 같은 트랜잭션에서만 쓴다(커밋하지 않는다)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.models.dc_inventory import DcChangeLog
from app.models.user import User

_SKIP = {"created_at", "updated_at", "version"}


@dataclass
class Ctx:
    """쓰기 1회의 맥락 — 누가, 어떤 경로로, 어느 일괄 작업으로."""

    actor: User | None = None
    source: str = "ui"            # ui | import | bulk | link | sync
    batch_id: str | None = None
    warnings: list[str] = field(default_factory=list)
    # device_registry 미러가 다시 registry 를 부르는 순환을 끊는다.
    mirror: bool = True


def _jsonable(v: Any) -> Any:
    if isinstance(v, UUID):
        return str(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def snapshot(obj: Any) -> dict[str, Any]:
    """ORM 행 → JSON 으로 저장할 수 있는 컬럼 dict (시각·버전 제외)."""
    return {
        c.key: _jsonable(getattr(obj, c.key))
        for c in sa_inspect(obj).mapper.column_attrs
        if c.key not in _SKIP
    }


def record(db: Session, *, object_type: str, obj: Any, repr_: str, action: str,
           before: dict[str, Any] | None, ctx: Ctx) -> DcChangeLog | None:
    """변경 1건 기록. ``update`` 인데 바뀐 필드가 없으면 기록하지 않는다."""
    after = None if action == "delete" else snapshot(obj)
    changed: list[str] | None = None
    if action == "update":
        changed = sorted(k for k in (after or {}) if (before or {}).get(k) != after.get(k))
        if not changed:
            return None
    from app.services.request_context import get_request_id

    entry = DcChangeLog(
        object_type=object_type,
        object_id=obj.id,
        object_repr=(repr_ or "")[:255],
        action=action,
        before=before if action != "create" else None,
        after=after,
        changed_fields=changed,
        actor_user_id=ctx.actor.id if ctx.actor is not None else None,
        actor_username=((ctx.actor.username if ctx.actor is not None else None) or "-")[:64],
        request_id=get_request_id(),
        batch_id=ctx.batch_id,
        source=ctx.source,
    )
    db.add(entry)
    return entry
