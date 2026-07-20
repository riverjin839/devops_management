"""Isilon NFS 모니터링 — 서버 인벤토리 / 커스텀 명령 등록 / 라이브 수집.

- 서버 CRUD (+연결 테스트): SSH 접속 대상. 자격증명은 ``secret_box`` 로 암호화 저장하고
  응답에는 평문을 절대 내보내지 않는다(``has_password``/``has_private_key`` 플래그만).
- 명령 CRUD: 수집에 쓰는 ``isi`` 명령 등록/수정/삭제. 저장 전 ``validate_isi_command`` 로
  읽기전용·무부하 정책 검증(위반 시 422). builtin 명령은 편집/비활성만 가능(삭제 불가).
- 라이브 조회(``/overview``): 부하 보호를 위해 기본 캐시(force=false). 전용 페이지가 사용.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models.isilon_server import IsilonCommand, IsilonServer
from app.models.user import User
from app.services import isilon_service
from app.services.isilon_service import IsiCommandRejected, validate_isi_command
from app.services.secret_box import encrypt as encrypt_secret
from app.services.ssh_runner import test_connection as ssh_test_connection

router = APIRouter(prefix="/isilon-nfs", tags=["isilon-nfs"])


# ── Schemas ───────────────────────────────────────────────────────────────────
class IsilonServerCreate(BaseModel):
    name: str
    host: str
    port: int = 22
    username: str = "root"
    description: Optional[str] = None
    is_default: bool = False
    saved_password: Optional[str] = None
    saved_private_key: Optional[str] = None


class IsilonServerUpdate(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    description: Optional[str] = None
    is_default: Optional[bool] = None
    saved_password: Optional[str] = None
    saved_private_key: Optional[str] = None
    clear_saved_password: bool = False
    clear_saved_private_key: bool = False


class IsilonServerResponse(BaseModel):
    id: UUID
    name: str
    host: str
    port: int
    username: Optional[str]
    description: Optional[str]
    status: Optional[str]
    is_default: bool
    has_password: bool
    has_private_key: bool
    last_checked: Optional[datetime]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


class IsilonCommandCreate(BaseModel):
    server_id: Optional[UUID] = None
    key: str
    label: str
    section: str = "custom"
    command: str
    parse_mode: str = "text"
    timeout_seconds: int = 15
    enabled: bool = True
    show_on_overview: bool = True
    sort_order: int = 100


class IsilonCommandUpdate(BaseModel):
    label: Optional[str] = None
    section: Optional[str] = None
    command: Optional[str] = None
    parse_mode: Optional[str] = None
    timeout_seconds: Optional[int] = None
    enabled: Optional[bool] = None
    show_on_overview: Optional[bool] = None
    sort_order: Optional[int] = None


class IsilonCommandResponse(BaseModel):
    id: UUID
    server_id: Optional[UUID]
    key: str
    label: str
    section: str
    command: str
    parse_mode: str
    timeout_seconds: int
    enabled: bool
    show_on_overview: bool
    sort_order: int
    is_builtin: bool


def _server_to_response(s: IsilonServer) -> IsilonServerResponse:
    return IsilonServerResponse(
        id=s.id, name=s.name, host=s.host, port=s.port or 22, username=s.username,
        description=s.description, status=s.status, is_default=bool(s.is_default),
        has_password=bool(s.encrypted_password), has_private_key=bool(s.encrypted_private_key),
        last_checked=s.last_checked, created_at=s.created_at, updated_at=s.updated_at,
    )


def _clear_other_defaults(db: Session, keep_id: Optional[UUID]) -> None:
    for other in db.query(IsilonServer).filter(IsilonServer.is_default == True).all():  # noqa: E712
        if keep_id is None or other.id != keep_id:
            other.is_default = False


# ── 서버 CRUD ─────────────────────────────────────────────────────────────────
@router.get("/servers", response_model=list[IsilonServerResponse])
def list_servers(db: Session = Depends(get_db)):
    servers = db.query(IsilonServer).order_by(IsilonServer.name).all()
    return [_server_to_response(s) for s in servers]


@router.post("/servers", response_model=IsilonServerResponse, status_code=status.HTTP_201_CREATED)
def create_server(
    payload: IsilonServerCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    if db.query(IsilonServer).filter(IsilonServer.name == payload.name).first():
        raise HTTPException(status_code=400, detail="같은 이름의 Isilon 서버가 이미 존재합니다.")
    data = payload.model_dump()
    saved_password = data.pop("saved_password", None)
    saved_private_key = data.pop("saved_private_key", None)
    server = IsilonServer(**data)
    if saved_password:
        server.encrypted_password = encrypt_secret(saved_password)
    if saved_private_key:
        server.encrypted_private_key = encrypt_secret(saved_private_key)
    if server.is_default:
        _clear_other_defaults(db, None)
    db.add(server)
    db.commit()
    db.refresh(server)
    return _server_to_response(server)


@router.get("/servers/{server_id}", response_model=IsilonServerResponse)
def get_server(server_id: UUID, db: Session = Depends(get_db)):
    server = db.query(IsilonServer).filter(IsilonServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Isilon 서버를 찾을 수 없습니다.")
    return _server_to_response(server)


@router.put("/servers/{server_id}", response_model=IsilonServerResponse)
def update_server(
    server_id: UUID,
    payload: IsilonServerUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    server = db.query(IsilonServer).filter(IsilonServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Isilon 서버를 찾을 수 없습니다.")
    update = payload.model_dump(exclude_unset=True)
    saved_password = update.pop("saved_password", None)
    saved_private_key = update.pop("saved_private_key", None)
    clear_password = update.pop("clear_saved_password", False)
    clear_private_key = update.pop("clear_saved_private_key", False)
    for field, value in update.items():
        setattr(server, field, value)
    if clear_password:
        server.encrypted_password = None
    elif saved_password is not None:
        server.encrypted_password = encrypt_secret(saved_password) if saved_password else None
    if clear_private_key:
        server.encrypted_private_key = None
    elif saved_private_key is not None:
        server.encrypted_private_key = encrypt_secret(saved_private_key) if saved_private_key else None
    if server.is_default:
        _clear_other_defaults(db, server.id)
    db.commit()
    db.refresh(server)
    # 설정 변경 시 캐시 무효화(자격증명/호스트가 바뀌었을 수 있음).
    isilon_service.clear_cache(str(server.id))
    return _server_to_response(server)


@router.delete("/servers/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_server(
    server_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    server = db.query(IsilonServer).filter(IsilonServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Isilon 서버를 찾을 수 없습니다.")
    db.delete(server)
    db.commit()
    isilon_service.clear_cache(str(server_id))
    return None


@router.post("/servers/{server_id}/test")
def test_server(
    server_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """저장된 자격증명으로 SSH 연결만 검증(명령 미실행 — 무부하)."""
    server = db.query(IsilonServer).filter(IsilonServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Isilon 서버를 찾을 수 없습니다.")
    target = isilon_service.resolve_target(server)
    if not target.password and not target.private_key:
        raise HTTPException(status_code=422, detail="저장된 자격증명이 없습니다. 먼저 비밀번호/키를 등록하세요.")
    result = ssh_test_connection(target)
    server.status = "online" if result.status == "ok" else "offline"
    server.last_checked = datetime.utcnow()
    db.commit()
    return {
        "ok": result.status == "ok",
        "status": result.status,
        "detail": result.error or f"{server.host} 연결 성공",
        "duration_ms": result.duration_ms,
    }


# ── 명령 CRUD (커스텀 등록) ───────────────────────────────────────────────────
@router.get("/commands", response_model=list[IsilonCommandResponse])
def list_commands(
    server_id: Optional[UUID] = Query(None),
    db: Session = Depends(get_db),
):
    """글로벌 기본 명령 + (server_id 주면) 해당 서버 전용 명령."""
    q = db.query(IsilonCommand)
    if server_id is not None:
        q = q.filter(
            (IsilonCommand.server_id == None) | (IsilonCommand.server_id == server_id)  # noqa: E711
        )
    else:
        q = q.filter(IsilonCommand.server_id == None)  # noqa: E711
    rows = q.order_by(IsilonCommand.sort_order, IsilonCommand.key).all()
    return rows


@router.post("/commands", response_model=IsilonCommandResponse, status_code=status.HTTP_201_CREATED)
def create_command(
    payload: IsilonCommandCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    try:
        normalized = validate_isi_command(payload.command)
    except IsiCommandRejected as e:
        raise HTTPException(status_code=422, detail=str(e))
    if payload.server_id is not None:
        if not db.query(IsilonServer).filter(IsilonServer.id == payload.server_id).first():
            raise HTTPException(status_code=404, detail="Isilon 서버를 찾을 수 없습니다.")
    data = payload.model_dump()
    data["command"] = normalized
    cmd = IsilonCommand(**data)
    db.add(cmd)
    db.commit()
    db.refresh(cmd)
    isilon_service.clear_cache(str(payload.server_id) if payload.server_id else None)
    return cmd


@router.put("/commands/{command_id}", response_model=IsilonCommandResponse)
def update_command(
    command_id: UUID,
    payload: IsilonCommandUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    cmd = db.query(IsilonCommand).filter(IsilonCommand.id == command_id).first()
    if not cmd:
        raise HTTPException(status_code=404, detail="명령을 찾을 수 없습니다.")
    update = payload.model_dump(exclude_unset=True)
    if "command" in update and update["command"] is not None:
        try:
            update["command"] = validate_isi_command(update["command"])
        except IsiCommandRejected as e:
            raise HTTPException(status_code=422, detail=str(e))
    for field, value in update.items():
        setattr(cmd, field, value)
    db.commit()
    db.refresh(cmd)
    isilon_service.clear_cache(str(cmd.server_id) if cmd.server_id else None)
    return cmd


@router.delete("/commands/{command_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_command(
    command_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    cmd = db.query(IsilonCommand).filter(IsilonCommand.id == command_id).first()
    if not cmd:
        raise HTTPException(status_code=404, detail="명령을 찾을 수 없습니다.")
    if cmd.is_builtin:
        raise HTTPException(
            status_code=422,
            detail="기본(builtin) 명령은 삭제할 수 없습니다. 대신 비활성화(enabled=false)하세요.",
        )
    sid = str(cmd.server_id) if cmd.server_id else None
    db.delete(cmd)
    db.commit()
    isilon_service.clear_cache(sid)
    return None


# ── 라이브 조회 ───────────────────────────────────────────────────────────────
@router.get("/overview")
def overview(
    server_id: Optional[UUID] = Query(None),
    force: bool = Query(False, description="캐시 무시하고 재수집(NAS 부하 주의)"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Isilon NFS 스냅샷 + K8s NFS PV 목록. 기본 캐시(force=false)."""
    server = isilon_service.get_server(db, str(server_id) if server_id else None)
    if server is None:
        if server_id is not None:
            raise HTTPException(status_code=404, detail="Isilon 서버를 찾을 수 없습니다.")
        return {"configured": False, "message": "등록된 Isilon 서버가 없습니다. 서버를 먼저 등록하세요."}
    try:
        snapshot = isilon_service.collect_nfs_snapshot(db, server, force=force)
    except Exception as e:  # noqa: BLE001 — 빈 500 금지, 구체적 사유 노출.
        raise HTTPException(status_code=500, detail=f"Isilon 수집 실패: {str(e)[:300]}")
    snapshot["configured"] = True
    snapshot["k8s_nfs_pvs"] = _list_k8s_nfs_pvs(server)
    return snapshot


def _list_k8s_nfs_pvs(server: IsilonServer) -> list[dict[str, Any]]:
    """관리 클러스터 K8s 에서 NFS 백엔드 PV 목록(무해, 실패 시 빈 목록)."""
    try:
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except Exception:
            config.load_kube_config()
        v1 = client.CoreV1Api()
        pvs = v1.list_persistent_volume(timeout_seconds=15)
        out: list[dict[str, Any]] = []
        for pv in pvs.items:
            nfs = getattr(pv.spec, "nfs", None) if pv.spec else None
            if not nfs or not getattr(nfs, "path", None):
                continue
            claim = pv.spec.claim_ref if pv.spec else None
            out.append({
                "pv": pv.metadata.name,
                "server": getattr(nfs, "server", None),
                "path": nfs.path,
                "pvc": f"{claim.namespace}/{claim.name}" if claim else None,
                "phase": pv.status.phase if pv.status else None,
            })
        return out
    except Exception:  # noqa: BLE001
        return []
