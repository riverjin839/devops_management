"""공통 서비스 라우터 — `/common-services` 화면.

여러 클러스터가 함께 쓰는 서비스(LDAP AD·KEYCLOAK·JENKINS·ARGOCD·NEXUS) 인스턴스 등록(K8S 에서 가져오기 포함)·
설정값 수집(SSE 실시간 로그)·최신 설정·변경 이력·실행 이력·감시 설정.
쓰기·수집은 operator(+ 호스팅 클러스터 operate), 감시 설정 변경은 admin. 자격증명은 쓰기 전용(응답은 ``has_secret`` 만).
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.common_service import CommonServiceInstance, CommonServiceRun
from app.models.user import User
from app.services import audit_logger
from app.services.cluster_access import hidden_cluster_ids, require_cluster_access
from app.services.common_services import catalog as K
from app.services.common_services import service as S

router = APIRouter(prefix="/common-services", tags=["Common Services"])


def _raise(exc: S.CommonServiceError):
    raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


def _visible(db: Session, user: User, inst: CommonServiceInstance) -> CommonServiceInstance:
    if inst.cluster_id and inst.cluster_id in hidden_cluster_ids(db, user):
        raise HTTPException(status_code=404, detail="공통 서비스를 찾을 수 없습니다.")
    return inst


def _load(db: Session, user: User, instance_id: UUID) -> CommonServiceInstance:
    try:
        return _visible(db, user, S.get_instance(db, instance_id))
    except S.CommonServiceError as exc:
        _raise(exc)
        raise  # pragma: no cover


@router.get("/catalog")
def catalog(_: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"services": K.SERVICES, "host_kinds": list(K.HOST_KINDS)}


@router.get("/status")
def status(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"services": S.service_status(db, hidden_cluster_ids(db, user))}


@router.get("/watch-settings")
def get_watch_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return S.get_settings(db)


class WatchSettingsInput(BaseModel):
    enabled: Optional[bool] = None
    interval_min: Optional[int] = Field(default=None, ge=5, le=1440)
    change_alert: Optional[bool] = None
    change_severity: Optional[str] = None
    unreachable_alert: Optional[bool] = None
    unreachable_after: Optional[int] = Field(default=None, ge=1, le=100)
    unreachable_severity: Optional[str] = None


@router.put("/watch-settings")
def put_watch_settings(body: WatchSettingsInput, request: Request, db: Session = Depends(get_db),
                       user: User = Depends(require_admin)) -> dict[str, Any]:
    out = S.set_settings(db, body.model_dump())
    audit_logger.record(db, action="common_service.settings.update", actor=user, target_type="app_setting",
                        target_id=S.SETTINGS_KEY, details=out, request=request)
    return out


@router.get("/instances")
def list_instances(service_type: Optional[str] = Query(default=None), db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": S.list_instances(db, hidden_cluster_ids(db, user), service_type)}


class CredentialInput(BaseModel):
    purpose: str = Field(pattern="^(app_api|ssh|ldap_bind)$")
    auth_type: str = Field(default="password", pattern="^(password|token|private_key)$")
    username: Optional[str] = Field(default=None, max_length=255)
    secret: Optional[str] = Field(default=None, max_length=20000)   # 비우면 기존 값 유지
    clear: bool = False


class LinkInput(BaseModel):
    cluster_id: UUID
    relation: Optional[str] = Field(default=None, max_length=200)


class InstanceInput(BaseModel):
    service_type: str
    name: str = Field(min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=2000)
    endpoint_url: Optional[str] = Field(default=None, max_length=512)
    tls_verify: bool = True
    host_kind: str = Field(pattern="^(k8s|podman|external)$")
    cluster_id: Optional[UUID] = None
    namespace: Optional[str] = Field(default=None, max_length=253)
    workload_kind: Optional[str] = Field(default=None, pattern="^(Deployment|StatefulSet|DaemonSet)$")
    workload_name: Optional[str] = Field(default=None, max_length=253)
    ssh_host: Optional[str] = Field(default=None, max_length=255)
    ssh_port: Optional[int] = Field(default=22, ge=1, le=65535)
    container_name: Optional[str] = Field(default=None, max_length=253)
    params: list[dict[str, Any]] | dict[str, Any] = Field(default_factory=list)  # [{key, value}] 권장
    watch_enabled: bool = True
    credentials: list[CredentialInput] = Field(default_factory=list)
    links: list[LinkInput] = Field(default_factory=list)


def _payload(body: InstanceInput) -> dict[str, Any]:
    data = body.model_dump()
    data["credentials"] = [c.model_dump() for c in body.credentials]
    data["links"] = [{"cluster_id": str(lk.cluster_id), "relation": lk.relation} for lk in body.links]
    return data


def _audit_details(body: InstanceInput) -> dict[str, Any]:
    return {"service_type": body.service_type, "name": body.name, "host_kind": body.host_kind,
            "cluster_id": str(body.cluster_id) if body.cluster_id else None,
            "credentials": [{"purpose": c.purpose, "changed": bool(c.secret) or c.clear} for c in body.credentials]}


@router.post("/instances")
def create_instance(body: InstanceInput, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(require_operator)) -> dict[str, Any]:
    if body.cluster_id:
        require_cluster_access(db, user, body.cluster_id, "operate")
    try:
        inst = S.save_instance(db, _payload(body), user.username)
    except S.CommonServiceError as exc:
        db.rollback()
        _raise(exc)
    audit_logger.record(db, action="common_service.create", actor=user, target_type="common_service",
                        target_id=str(inst.id), details=_audit_details(body), request=request)
    return S.serialize(db, inst)


@router.get("/instances/{instance_id}")
def get_instance(instance_id: UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return S.serialize(db, _load(db, user, instance_id))


@router.put("/instances/{instance_id}")
def update_instance(instance_id: UUID, body: InstanceInput, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(require_operator)) -> dict[str, Any]:
    inst = _load(db, user, instance_id)
    for cid in {inst.cluster_id, body.cluster_id} - {None}:
        require_cluster_access(db, user, cid, "operate")
    try:
        inst = S.save_instance(db, _payload(body), user.username, instance_id)
    except S.CommonServiceError as exc:
        db.rollback()
        _raise(exc)
    audit_logger.record(db, action="common_service.update", actor=user, target_type="common_service",
                        target_id=str(instance_id), details=_audit_details(body), request=request)
    return S.serialize(db, inst)


@router.delete("/instances/{instance_id}")
def delete_instance(instance_id: UUID, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(require_operator)) -> dict[str, Any]:
    inst = _load(db, user, instance_id)
    if inst.cluster_id:
        require_cluster_access(db, user, inst.cluster_id, "operate")
    name, st = inst.name, inst.service_type
    S.delete_instance(db, instance_id)
    audit_logger.record(db, action="common_service.delete", actor=user, target_type="common_service",
                        target_id=str(instance_id), details={"name": name, "service_type": st}, request=request)
    return {"deleted": True}


class DiscoverInput(BaseModel):
    cluster_id: UUID
    namespace: Optional[str] = Field(default=None, max_length=253)
    service_type: Optional[str] = None


@router.post("/discover")
def discover(body: DiscoverInput, db: Session = Depends(get_db), user: User = Depends(require_operator)) -> dict[str, Any]:
    """'K8S 에서 가져오기' — 등록 클러스터에서 카탈로그 패턴에 맞는 워크로드 후보(읽기만)."""
    require_cluster_access(db, user, body.cluster_id, "read")
    cluster = db.query(Cluster).filter(Cluster.id == body.cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        return {"items": S.discover(db, cluster, (body.namespace or "").strip() or None, body.service_type)}
    except S.CommonServiceError as exc:
        _raise(exc)
        raise  # pragma: no cover


@router.post("/instances/{instance_id}/run/stream")
async def run_stream(instance_id: UUID, request: Request, kind: str = Query(default="collect", pattern="^(collect|test)$"),
                     db: Session = Depends(get_db), user: User = Depends(require_operator)):
    """지금 수집(collect) / 접속 테스트(test, 저장 없음) — SSE 실시간 로그. 첫 이벤트 ``{type:"run", run_id}``."""
    from app.services.sse import stream_async_job

    inst = _load(db, user, instance_id)
    if inst.cluster_id:
        require_cluster_access(db, user, inst.cluster_id, "read")
    try:
        run = S.start_run(db, inst, kind, "manual", user.username)
    except S.CommonServiceError as exc:
        _raise(exc)
    audit_logger.record(db, action=f"common_service.{kind}", actor=user, target_type="common_service",
                        target_id=str(instance_id), details={"run_id": str(run.id), "name": inst.name}, request=request)
    run_id = run.id

    async def job(sdb: Session, emit):
        emit({"type": "run", "run_id": str(run_id)})

        def work() -> dict[str, Any]:
            i = sdb.query(CommonServiceInstance).filter(CommonServiceInstance.id == instance_id).one()
            r = sdb.query(CommonServiceRun).filter(CommonServiceRun.id == run_id).one()
            return S.run_collect(sdb, i, r, emit)

        return await asyncio.get_running_loop().run_in_executor(None, work)

    return stream_async_job(job, name=f"common-service-{kind}")


@router.get("/instances/{instance_id}/config")
def get_config(instance_id: UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return S.latest_config(db, _load(db, user, instance_id))


@router.get("/instances/{instance_id}/changes")
def get_changes(instance_id: UUID, limit: int = Query(default=300, ge=1, le=2000), db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": S.list_changes(db, _load(db, user, instance_id), limit)}


@router.get("/instances/{instance_id}/runs")
def get_runs(instance_id: UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": S.list_runs(db, _load(db, user, instance_id))}


@router.get("/instances/{instance_id}/runs/{run_id}")
def get_run(instance_id: UUID, run_id: UUID, db: Session = Depends(get_db),
            user: User = Depends(get_current_user)) -> dict[str, Any]:
    _load(db, user, instance_id)
    r = db.query(CommonServiceRun).filter(CommonServiceRun.id == run_id, CommonServiceRun.instance_id == instance_id).first()
    if r is None:
        raise HTTPException(status_code=404, detail="실행 기록을 찾을 수 없습니다.")
    return S.run_row(r, full=True)
