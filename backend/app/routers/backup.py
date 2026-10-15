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
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
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
    export_filename,
    iter_export_json,
    open_backup_file,
)
from app.services import audit_logger

_log = logging.getLogger("k8s_monitor.backup")

router = APIRouter(prefix="/backup", tags=["backup"])


# 백업은 kubeconfig·자격증명·전 사용자 데이터를 통째로 담으므로 meta/export 도 import 와 같이
# admin 전용이다. (이전엔 export 가 인증만 요구해 viewer 가 include_sensitive=true 로
# 복호화된 민감정보를 받아갈 수 있었다.)
@router.get("/meta", response_model=BackupMetaResponse)
def get_meta(db: Session = Depends(get_db), _: User = Depends(require_admin)):
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
    request: Request,
    include_logs: bool = Query(default=False, description="로그성 테이블 포함 여부"),
    include_sensitive: bool = Query(default=False, description="kubeconfig 등 민감 필드 포함 여부"),
    actor: User = Depends(require_admin),
):
    """전체 DB 를 JSON 으로 **스트리밍** 내려준다 — 운영 DB 를 한 워커 메모리에 통째로 올리던 예전
    방식은 backend 파드를 OOMKilled 시켰다(`backup_service.iter_export_json`).

    응답 시작 후에는 상태 코드를 바꿀 수 없으므로, 테이블 단위 실패는 파일 끝의 ``errors`` /
    ``skipped_tables`` 에 남고 감사 로그에도 기록된다. FastAPI 는 스트리밍 전에 의존성 세션을 닫으므로
    생성기가 자기 세션을 연다.
    """
    client_ip = request.client.host if request.client else None
    actor_id, actor_name = actor.id, actor.username

    def _stream():
        db = SessionLocal()
        summary: dict = {}
        status = "success"
        err: str | None = None
        try:
            yield from iter_export_json(
                db, include_logs=include_logs, include_sensitive=include_sensitive, summary=summary,
            )
        except GeneratorExit:
            status, err = "failure", "client disconnected"
            raise
        except Exception as e:  # noqa: BLE001 — 응답이 이미 시작돼 HTTP 오류로 바꿀 수 없다
            status, err = "failure", f"{type(e).__name__}: {str(e)[:200]}"
            _log.exception("backup/export stream failed")
        finally:
            # 민감정보 포함 여부와 무관하게 전체 데이터 반출이므로 항상 감사 로그에 남긴다.
            try:
                audit_logger.record(
                    db,
                    action="backup.export",
                    actor=db.get(User, actor_id),
                    actor_username=actor_name,
                    status=status,
                    details={
                        "include_logs": include_logs, "include_sensitive": include_sensitive,
                        "bytes": summary.get("bytes"), "skipped_tables": summary.get("skipped_tables"),
                        "error": err, "client_ip": client_ip,
                    },
                )
            finally:
                db.close()

    return StreamingResponse(
        _stream(),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{export_filename()}"'},
    )


# 가져오기는 업로드를 통째로 읽지 않는다 — Starlette 가 이미 디스크 임시 파일(``file.file``)로 받아 둔 것을
# ``open_backup_file`` 이 한 번 훑어 검증·색인하고, 미리보기/적용이 테이블별로 다시 흘려 읽는다(OOM 방지).
# 파일 I/O·DB 작업이 길어 이벤트 루프를 막지 않도록 sync 핸들러(스레드풀)로 둔다.
@router.post("/import/preview", response_model=BackupImportPreviewResponse)
def import_preview(
    file: UploadFile = File(..., description="JSON 백업 파일"),
    mode: str = Form(default="merge"),
    include_logs: bool = Form(default=False),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=422, detail="mode 는 'merge' 또는 'replace' 이어야 합니다.")
    try:
        source = open_backup_file(file.file)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        result = apply_import(db, source, mode=mode, include_logs=include_logs, dry_run=True)
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
def import_apply(
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
        source = open_backup_file(file.file)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        result = apply_import(db, source, mode=mode, include_logs=include_logs, dry_run=False)
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
