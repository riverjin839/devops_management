"""스크립트 라이브러리 — DB 저장·버전관리되는 실행 스크립트(Python/Ansible/Shell) CRUD +
테스트 실행. 설계 배경: ``docs/02-design/features/batch-jobs-execution-redesign.design.md``.

권한(§4.5, §8.0 결정): 기본은 ``require_operator`` 로 열고, ``AppSetting`` 토글
(``script_library_admin_only``)이 켜지면 재배포 없이 admin 전용으로 좁힌다 — 임의
코드 실행 기능이라는 특성상 운영 중 정책을 바꿀 수 있어야 한다.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.deps import require_admin, require_operator
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.executable_script import ExecutableScript, ExecutableScriptVersion, SCRIPT_KINDS
from app.models.user import User
from app.schemas.executable_script import (
    ExecutableScriptCreate,
    ExecutableScriptCurrentVersionUpdate,
    ExecutableScriptResponse,
    ExecutableScriptUpdate,
    ExecutableScriptVersionCreate,
    ExecutableScriptVersionResponse,
    ScriptTestRunRequest,
    ScriptTestRunResponse,
)
from app.services import audit_logger
from app.services.script_test_run import ScriptTestRunError, run_ansible_test, run_shell_test

router = APIRouter(prefix="/scripts", tags=["scripts"])

_ACCESS_SETTING_KEY = "script_library_admin_only"


def _access_admin_only(db: Session) -> bool:
    row = db.query(AppSetting).filter(AppSetting.key == _ACCESS_SETTING_KEY).first()
    if row is None or not isinstance(row.value, dict):
        return False
    return bool(row.value.get("admin_only"))


def require_script_access(
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> User:
    """기본 operator 허용 + AppSetting 토글이 켜지면 admin 전용으로 승격."""
    if _access_admin_only(db) and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="스크립트 라이브러리가 관리자 전용으로 설정되어 있습니다.",
        )
    return user


def _get_script(db: Session, script_id: UUID) -> ExecutableScript:
    script = db.query(ExecutableScript).filter(ExecutableScript.id == script_id).first()
    if script is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="스크립트를 찾을 수 없습니다.")
    return script


def _script_response(script: ExecutableScript) -> ExecutableScriptResponse:
    current_version = None
    if script.current_version is not None:
        current_version = ExecutableScriptVersionResponse.model_validate(script.current_version)
    return ExecutableScriptResponse(
        id=script.id, name=script.name, description=script.description, kind=script.kind,
        tags=script.tags, is_system=script.is_system, current_version_id=script.current_version_id,
        created_by=script.created_by, created_at=script.created_at, updated_at=script.updated_at,
        current_version=current_version,
        # Phase 2(BatchJob/CheckMatrixItem 연결) 전까지는 실제 참조가 없다.
        used_by_count=0,
    )


@router.get("/access-settings")
def get_access_settings(
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    return {"admin_only": _access_admin_only(db)}


@router.put("/access-settings")
def update_access_settings(
    payload: dict,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    admin_only = bool(payload.get("admin_only", False))
    row = db.query(AppSetting).filter(AppSetting.key == _ACCESS_SETTING_KEY).first()
    if row is None:
        row = AppSetting(key=_ACCESS_SETTING_KEY, value={"admin_only": admin_only})
        db.add(row)
    else:
        row.value = {"admin_only": admin_only}
    db.commit()
    audit_logger.record(
        db, action="script.access_settings_update", actor=actor,
        target_type="app_setting", target_id=_ACCESS_SETTING_KEY,
        details={"admin_only": admin_only}, request=request,
    )
    return {"admin_only": admin_only}


@router.get("", response_model=list[ExecutableScriptResponse])
def list_scripts(
    kind: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(require_script_access),
):
    query = db.query(ExecutableScript)
    if kind:
        query = query.filter(ExecutableScript.kind == kind)
    if q:
        query = query.filter(ExecutableScript.name.ilike(f"%{q}%"))
    scripts = query.order_by(ExecutableScript.updated_at.desc()).all()
    if tag:
        scripts = [s for s in scripts if s.tags and tag in s.tags]
    return [_script_response(s) for s in scripts]


@router.post("", response_model=ExecutableScriptResponse, status_code=status.HTTP_201_CREATED)
def create_script(
    payload: ExecutableScriptCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_script_access),
):
    if payload.kind not in SCRIPT_KINDS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"알 수 없는 kind '{payload.kind}'.")

    script = ExecutableScript(
        name=payload.name, description=payload.description, kind=payload.kind,
        tags=payload.tags, created_by=actor.username,
    )
    db.add(script)
    db.flush()  # script.id 확보 (아직 commit 안 함)

    version = ExecutableScriptVersion(
        script_id=script.id, version=1, content=payload.content,
        inventory_content=payload.inventory_content, param_schema=payload.param_schema,
        changelog=payload.changelog or "최초 생성", created_by=actor.username,
    )
    db.add(version)
    db.flush()

    script.current_version_id = version.id
    db.commit()
    db.refresh(script)

    audit_logger.record(
        db, action="script.create", actor=actor, target_type="executable_script", target_id=script.id,
        details={"name": script.name, "kind": script.kind}, request=request,
    )
    return _script_response(script)


@router.get("/{script_id}", response_model=ExecutableScriptResponse)
def get_script(
    script_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_script_access),
):
    return _script_response(_get_script(db, script_id))


@router.put("/{script_id}", response_model=ExecutableScriptResponse)
def update_script(
    script_id: UUID,
    payload: ExecutableScriptUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_script_access),
):
    script = _get_script(db, script_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(script, key, value)
    db.commit()
    db.refresh(script)
    audit_logger.record(
        db, action="script.update", actor=actor, target_type="executable_script", target_id=script.id,
        details={"name": script.name}, request=request,
    )
    return _script_response(script)


@router.delete("/{script_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_script(
    script_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_script_access),
):
    script = _get_script(db, script_id)
    if script.is_system:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="시스템 제공 스크립트는 삭제할 수 없습니다.")
    # Phase 2(BatchJob/CheckMatrixItem 이 script_id 를 참조하기 시작하면) 부터는
    # 여기서 참조 여부를 확인해 409 로 막아야 한다 — 지금은 참조하는 곳이 없다.
    audit_logger.record(
        db, action="script.delete", actor=actor, target_type="executable_script", target_id=script.id,
        details={"name": script.name}, request=request,
    )
    db.delete(script)
    db.commit()
    return None


@router.get("/{script_id}/versions", response_model=list[ExecutableScriptVersionResponse])
def list_versions(
    script_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_script_access),
):
    _get_script(db, script_id)
    versions = (
        db.query(ExecutableScriptVersion)
        .filter(ExecutableScriptVersion.script_id == script_id)
        .order_by(ExecutableScriptVersion.version.desc())
        .all()
    )
    return versions


@router.get("/{script_id}/versions/{version_number}", response_model=ExecutableScriptVersionResponse)
def get_version(
    script_id: UUID,
    version_number: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_script_access),
):
    _get_script(db, script_id)
    version = (
        db.query(ExecutableScriptVersion)
        .filter(ExecutableScriptVersion.script_id == script_id, ExecutableScriptVersion.version == version_number)
        .first()
    )
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="해당 버전을 찾을 수 없습니다.")
    return version


@router.post("/{script_id}/versions", response_model=ExecutableScriptVersionResponse, status_code=status.HTTP_201_CREATED)
def create_version(
    script_id: UUID,
    payload: ExecutableScriptVersionCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_script_access),
):
    """"저장" 버튼의 실제 동작 — 새 버전을 만들고 바로 현재 버전으로 지정한다.

    이전 버전은 불변으로 남는다(``BatchJobRun.params_snapshot`` 과 동일 철학) — 특정
    버전에 고정된 Job/Item 은 영향받지 않고, "항상 최신"(script_version_id=null)인
    참조만 다음 실행부터 이 버전을 쓴다.
    """
    script = _get_script(db, script_id)
    next_version = (
        db.query(func.coalesce(func.max(ExecutableScriptVersion.version), 0))
        .filter(ExecutableScriptVersion.script_id == script_id)
        .scalar()
    ) + 1

    version = ExecutableScriptVersion(
        script_id=script.id, version=next_version, content=payload.content,
        inventory_content=payload.inventory_content, param_schema=payload.param_schema,
        changelog=payload.changelog, created_by=actor.username,
    )
    db.add(version)
    db.flush()
    script.current_version_id = version.id
    db.commit()
    db.refresh(version)

    audit_logger.record(
        db, action="script.version_create", actor=actor, target_type="executable_script", target_id=script.id,
        details={"name": script.name, "version": next_version}, request=request,
    )
    return version


@router.put("/{script_id}/current-version", response_model=ExecutableScriptResponse)
def set_current_version(
    script_id: UUID,
    payload: ExecutableScriptCurrentVersionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_script_access),
):
    """"이 버전으로 롤백" — 새 버전을 만들지 않고 포인터만 옮긴다."""
    script = _get_script(db, script_id)
    version = (
        db.query(ExecutableScriptVersion)
        .filter(ExecutableScriptVersion.id == payload.version_id, ExecutableScriptVersion.script_id == script_id)
        .first()
    )
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="해당 버전을 찾을 수 없습니다.")
    script.current_version_id = version.id
    db.commit()
    db.refresh(script)
    audit_logger.record(
        db, action="script.rollback", actor=actor, target_type="executable_script", target_id=script.id,
        details={"name": script.name, "version": version.version}, request=request,
    )
    return _script_response(script)


@router.post("/{script_id}/test-run", response_model=ScriptTestRunResponse)
async def test_run_script(
    script_id: UUID,
    payload: ScriptTestRunRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_script_access),
):
    """저장 전 초안도 즉시 테스트 — 결과는 어디에도 영속화하지 않는다(§4.3)."""
    script = _get_script(db, script_id)

    if script.kind == "python":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "Python 스크립트 테스트 실행은 아직 지원하지 않습니다 — 대상 클러스터의 "
                "일회용 K8s Job 실행기가 Phase 2 에 구현될 예정입니다 "
                "(설계 문서 §4.4, §8.0)."
            ),
        )

    try:
        if script.kind == "shell":
            result = await run_shell_test(payload.content, payload.target)
        elif script.kind == "ansible_playbook":
            result = await run_ansible_test(
                payload.content, payload.inventory_content, payload.params, payload.target,
            )
        else:  # pragma: no cover - kind 는 생성 시점에 검증됨
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"알 수 없는 kind '{script.kind}'.")
    except ScriptTestRunError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    audit_logger.record(
        db, action="script.test_run", actor=actor, target_type="executable_script", target_id=script.id,
        details={"name": script.name, "kind": script.kind, "status": result["status"]}, request=request,
    )
    return ScriptTestRunResponse(**result)
