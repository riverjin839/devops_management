"""시스템 진단 — admin only. 파드·버전·부팅 마이그레이션·Celery·DB lock·점검 수행·서버 오류를 한 번에."""
from __future__ import annotations

import anyio
from fastapi import APIRouter, Depends, Request

from app.auth.deps import require_admin
from app.models.user import User
from app.services import system_diagnostics

router = APIRouter(prefix="/system-diagnostics", tags=["system-diagnostics"])


@router.get("")
async def get_system_diagnostics(request: Request, _: User = Depends(require_admin)):
    """섹션별 상태(ok/warning/critical/offline)와 근거. 수집 실패는 섹션의 ``offline`` 으로만 나타난다.

    Celery inspect·DB 조회가 블로킹이라 스레드에서 돈다(이벤트 루프를 막지 않는다).
    """
    return await anyio.to_thread.run_sync(lambda: system_diagnostics.collect(request.app.version))
