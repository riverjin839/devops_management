"""데이터 백업 / 복구 엔드포인트 — Settings 페이지 연동.

- GET  /backup/meta           → 현재 DB 요약 (테이블/row 수)
- GET  /backup/export         → JSON 파일 다운로드
- POST /backup/import/preview → 업로드된 백업 파일의 diff 미리보기 (dry-run)
- POST /backup/import         → 실제 적용 (merge | replace)

모든 endpoint 는 per-table fault tolerance 를 가진 backup_service 헬퍼를 호출.
한 테이블 실패가 전체 500 으로 번지지 않으며, 응답의 ``errors`` 필드에 사유 노출.
"""
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.auth.deps import require_admin
from app.schemas.backup import (
    BackupImportPreviewResponse,
    BackupImportResponse,
    BackupMetaResponse,
)
from app.services.backup_service import (
    apply_import,
    current_meta,
    export_to_bytes,
    parse_backup,
)
from app.services import audit_logger

_log = logging.getLogger("k8s_monitor.backup")

router = APIRouter(prefix="/backup", tags=["backup"])


@router.get("/meta", response_model=BackupMetaResponse)
def get_meta(db: Session = Depends(get_db)):
    try:
        return BackupMetaResponse.model_validate(current_meta(db))
    except Exception as e:  # noqa: BLE001
        _log.exception("backup/meta failed")
        raise HTTPException(
            status_code=500,
            detail=f"메타 조회 실패 ({type(e).__name__}): {str(e)[:200]}",
        ) from e


@router.get("/export")
def export_backup(
    include_logs: bool = Query(default=False, description="로그성 테이블 포함 여부"),
    include_sensitive: bool = Query(default=False, description="kubeconfig 등 민감 필드 포함 여부"),
    db: Session = Depends(get_db),
):
    try:
        raw, filename = export_to_bytes(
            db,
            include_logs=include_logs,
            include_sensitive=include_sensitive,
        )
    except Exception as e:  # noqa: BLE001
        # backup_service 가 per-table 격리를 하지만 예상치 못한 envelope/JSON 단계 실패도
        # 여기서 잡아 사용자에게 명시적 메시지를 돌려준다 (500 빈 응답 방지).
        _log.exception("backup/export failed")
        raise HTTPException(
            status_code=500,
            detail=f"백업 export 실패 ({type(e).__name__}): {str(e)[:200]}",
        ) from e
    return Response(
        content=raw,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Backup-Bytes": str(len(raw)),
        },
    )


@router.post("/import/preview", response_model=BackupImportPreviewResponse)
async def import_preview(
    file: UploadFile = File(..., description="JSON 백업 파일"),
    mode: str = Form(default="merge"),
    include_logs: bool = Form(default=False),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=422, detail="mode 는 'merge' 또는 'replace' 이어야 합니다.")
    try:
        raw = await file.read()
        envelope = parse_backup(raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        result = apply_import(db, envelope, mode=mode, include_logs=include_logs, dry_run=True)
    except Exception as e:  # noqa: BLE001
        _log.exception("backup/import/preview failed")
        raise HTTPException(
            status_code=500,
            detail=f"미리보기 실패 ({type(e).__name__}): {str(e)[:200]}",
        ) from e
    # dry_run=True 경로는 "diff" 필드만 채워진 dict 반환
    result.setdefault("inserted", 0)
    result.setdefault("updated", 0)
    result.setdefault("deleted", 0)
    result.setdefault("errors", [])
    return BackupImportPreviewResponse.model_validate(result)


@router.post("/import", response_model=BackupImportResponse)
async def import_apply(
    request: Request,
    file: UploadFile = File(..., description="JSON 백업 파일"),
    mode: str = Form(default="merge"),
    include_logs: bool = Form(default=False),
    confirm: bool = Form(default=False, description="replace 모드는 반드시 True 이어야 실행"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=422, detail="mode 는 'merge' 또는 'replace' 이어야 합니다.")
    if mode == "replace" and not confirm:
        raise HTTPException(
            status_code=422,
            detail="'replace' 모드는 기존 데이터를 모두 덮어씁니다. confirm=true 를 명시하세요.",
        )
    try:
        raw = await file.read()
        envelope = parse_backup(raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        result = apply_import(db, envelope, mode=mode, include_logs=include_logs, dry_run=False)
    except Exception as e:
        audit_logger.record(
            db,
            action="backup.import",
            actor=actor,
            status="failure",
            details={"mode": mode, "include_logs": include_logs, "error": str(e)[:200]},
            request=request,
        )
        raise HTTPException(status_code=500, detail=f"복구 실패 ({type(e).__name__}): {str(e)[:200]}") from e
    audit_logger.record(
        db,
        action="backup.import",
        actor=actor,
        status="success",
        details={
            "mode": mode,
            "include_logs": include_logs,
            "inserted": result.get("inserted"),
            "updated": result.get("updated"),
            "deleted": result.get("deleted"),
        },
        request=request,
    )
    return BackupImportResponse.model_validate(result)
