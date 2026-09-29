"""감사 로그 기록 헬퍼.

내부 try/except 로 감싸 호출부를 깨뜨리지 않는다 — 감사 로그 기록 실패가
실제 비즈니스 동작 (로그인, 클러스터 삭제 등) 을 막아선 안 된다.

멀티테넌시 5단계 — 각 행에 귀속 테넌트(``tenant_id``/``tenant_name``)를 남긴다.
호출부가 ``tenant_id`` 를 넘기지 않으면 ``_resolve_tenant`` 가 추정한다:

1. ``target_type == "tenant"`` → 그 테넌트.
2. ``target_type == "cluster"`` → 클러스터에 바인딩된 테넌트 중 행위자가 속한 테넌트
   (operate 우선), 행위자가 멤버가 아니면(admin·자동화) 클러스터의 소유 테넌트.
3. 그 외 → 행위자가 **딱 하나의** 테넌트에만 속하면 그 테넌트. 여러 개면 추정하지 않는다(NULL).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog
from app.models.user import User

_log = logging.getLogger("k8s_monitor.audit")


def _extract_client(request: Request | None) -> tuple[str | None, str | None]:
    if request is None:
        return None, None
    ip: str | None = None
    try:
        # X-Forwarded-For (proxy/ingress 뒤일 때) 우선, 없으면 client.host
        xff = request.headers.get("x-forwarded-for")
        if xff:
            ip = xff.split(",")[0].strip()[:64] or None
        elif request.client:
            ip = request.client.host[:64]
    except Exception:  # noqa: BLE001
        ip = None
    ua: str | None = None
    try:
        raw_ua = request.headers.get("user-agent")
        ua = raw_ua[:255] if raw_ua else None
    except Exception:  # noqa: BLE001
        ua = None
    return ip, ua


def _resolve_tenant(
    db: Session,
    actor: User | None,
    target_type: str | None,
    target_id: str | Any | None,
) -> tuple[str | None, str | None]:
    """(tenant_id, tenant_name) 추정 — 규칙은 모듈 docstring. 조회 실패는 (None, None)."""
    from uuid import UUID

    from app.models.tenant import ClusterBinding, Tenant, TenantMember

    def _uuid(v) -> UUID | None:
        try:
            return v if isinstance(v, UUID) else UUID(str(v))
        except (TypeError, ValueError):
            return None

    if target_type == "tenant" and target_id is not None:
        tid = _uuid(target_id)
        t = db.query(Tenant).filter(Tenant.id == tid).first() if tid else None
        return (str(tid) if tid else None), (t.name if t else None)

    if target_type == "cluster" and target_id is not None:
        cid = _uuid(target_id)
        if cid is not None:
            rows = (
                db.query(Tenant, ClusterBinding.access)
                .join(ClusterBinding, ClusterBinding.tenant_id == Tenant.id)
                .filter(ClusterBinding.cluster_id == cid)
                .order_by(Tenant.name)
                .all()
            )
            if rows:
                mine: set = set()
                if actor is not None:
                    mine = {
                        t for (t,) in db.query(TenantMember.tenant_id)
                        .filter(TenantMember.user_id == actor.id).all()
                    }
                ranked = sorted(rows, key=lambda r: (r[0].id not in mine, r[1] != "operate"))
                t = ranked[0][0]
                return str(t.id), t.name

    if actor is not None and getattr(actor, "id", None):
        rows = (
            db.query(Tenant)
            .join(TenantMember, TenantMember.tenant_id == Tenant.id)
            .filter(TenantMember.user_id == actor.id)
            .limit(2)
            .all()
        )
        if len(rows) == 1:
            return str(rows[0].id), rows[0].name
    return None, None


def record(
    db: Session,
    *,
    action: str,
    actor: User | None = None,
    actor_username: str | None = None,
    status: str = "success",
    target_type: str | None = None,
    target_id: str | Any | None = None,
    details: dict[str, Any] | None = None,
    request: Request | None = None,
    tenant_id: str | Any | None = None,
    tenant_name: str | None = None,
) -> None:
    """감사 로그 한 행 기록. 실패해도 호출부를 막지 않는다.

    ``tenant_id`` 를 넘기면 그대로 쓰고(이름은 ``tenant_name`` 또는 조회), 없으면 추정한다.
    """
    try:
        ip, ua = _extract_client(request)
        try:
            if tenant_id is None:
                t_id, t_name = _resolve_tenant(db, actor, target_type, target_id)
            else:
                t_id, t_name = _resolve_tenant(db, None, "tenant", tenant_id)
            if tenant_name:
                t_name = tenant_name
        except Exception as e:  # noqa: BLE001 — 귀속 추정 실패가 기록 자체를 막으면 안 된다
            db.rollback()
            _log.debug("audit: tenant resolve failed action=%s — %s", action, e)
            t_id, t_name = (None if tenant_id is None else str(tenant_id)), tenant_name
        username = actor.username if actor is not None else (actor_username or "-")
        entry = AuditLog(
            actor_user_id=actor.id if actor is not None else None,
            actor_username=(username or "-")[:64],
            action=action[:64],
            target_type=target_type[:32] if target_type else None,
            target_id=None if target_id is None else str(target_id)[:64],
            status=(status or "success")[:16],
            ip=ip,
            user_agent=ua,
            details=details,
            tenant_id=t_id,
            tenant_name=(t_name or None) and t_name[:100],
        )
        db.add(entry)
        db.commit()
    except Exception as e:  # noqa: BLE001
        _log.warning("audit: failed to record action=%s status=%s — %s", action, status, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
