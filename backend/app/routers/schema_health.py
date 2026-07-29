"""스키마 점검 — 모델과 실제 DB 의 드리프트를 화면에서 확인·복구.

Alembic 없이 `create_all` + 경량 마이그레이션으로 운영하다 보면 오래된 DB 가 모델과
어긋나고, 그 어긋남은 해당 컬럼을 쓰는 요청에서만 500 으로 드러난다. 서버 로그를 뒤져
컬럼 이름을 알아내는 대신 운영자가 화면에서 바로 보고 고치게 한다
(프로젝트 UI-First 원칙 — `CLAUDE.md`).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.auth.deps import require_admin
from app.models.user import User
from app.services import schema_health

router = APIRouter(prefix="/schema-health", tags=["Schema Health"])


@router.get("")
def get_schema_health(_: User = Depends(require_admin)):
    """모델 vs DB 드리프트 목록 (읽기 전용)."""
    try:
        return schema_health.inspect_drift()
    except Exception as e:  # noqa: BLE001 — 빈 500 금지, 사유를 그대로 노출
        raise HTTPException(status_code=500, detail=f"스키마 점검 실패: {str(e)[:300]}")


@router.post("/repair")
def repair_schema(dry_run: bool = False, _: User = Depends(require_admin)):
    """안전한 드리프트만 복구 — 컬럼 추가(nullable) / 레거시 NOT NULL 해제.

    컬럼 삭제·타입 변경은 하지 않는다. `dry_run=true` 면 실행할 SQL 만 돌려준다.
    """
    try:
        return schema_health.repair_drift(dry_run=dry_run)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"스키마 복구 실패: {str(e)[:300]}")
