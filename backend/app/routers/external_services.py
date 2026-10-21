"""외부 서비스(도메인·IP:Port) — 공개 조회 + 수집 실행(SSE 실시간 로그) + 설정.

- `public_router` (`/public/external-services/*`): **비인증**. 로그인 없는 공개 화면(`/external-services`)이
  쓴다. 저장된 스냅샷만 읽는다(K8s 직접 조회 없음). 노출 클러스터 규칙은 일일 리포트와 같다
  (`services/public_pages.py` — 테넌트 바인딩 없는 클러스터 또는 allowlist). `public_enabled=false` 면 404.
  공개 방식이 `link` 면 `?t=<공유 링크 토큰>` 이 필요하다. `/{cluster_id}/changes` 는 외부 노출 변경 이력.
- `router` (`/external-services/*`, JWT):
  - `POST /{cluster_id}/collect/stream` — 지금 수집(require_operator + 클러스터 operate 권한). SSE 로
    단계·로그를 흘린다. SSH 역조회 자격증명은 이 요청에서만 쓰고 저장하지 않는다.
  - `GET|PUT /settings` — 조회는 인증 사용자, 변경은 require_admin(+감사).
"""
from __future__ import annotations

import asyncio
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services import external_services as _es
from app.services import public_pages as _pp
from app.services.cluster_access import require_cluster_access
from app.services.sse import Emit, log_evt, step_evt, stream_async_job

public_router = APIRouter(prefix="/public/external-services", tags=["external-services-public"])
router = APIRouter(prefix="/external-services", tags=["external-services"])


def _ensure_public(db: Session, token: Optional[str]):
    cfg = _es.get_settings(db)
    if not cfg["public_enabled"]:
        raise HTTPException(status_code=404, detail="외부 서비스 목록 공개가 비활성화되어 있습니다")
    return cfg, _pp.authorize(db, "external_services", cfg["access_mode"], token)


def _public_cluster(db: Session, cluster_id: UUID, link):
    cluster = next((c for c in _pp.filter_by_link(_es.public_clusters(db), link) if c.id == cluster_id), None)
    if cluster is None:
        raise HTTPException(status_code=404, detail="공개 대상 클러스터가 아닙니다")
    return cluster


@public_router.get("/clusters")
def public_clusters(t: Optional[str] = Query(None, max_length=200), db: Session = Depends(get_db)):
    cfg, link = _ensure_public(db, t)
    return {"clusters": [{"id": str(c.id), "name": c.name} for c in _pp.filter_by_link(_es.public_clusters(db), link)],
            "access_mode": cfg["access_mode"],
            "link_expires_at": link.expires_at.isoformat() if link else None}


@public_router.get("/{cluster_id}")
def public_cluster_view(cluster_id: UUID, t: Optional[str] = Query(None, max_length=200),
                        db: Session = Depends(get_db)):
    _cfg, link = _ensure_public(db, t)
    return _es.public_view(db, _public_cluster(db, cluster_id, link))


@public_router.get("/{cluster_id}/changes")
def public_changes(cluster_id: UUID, days: int = Query(30, ge=1, le=400),
                   t: Optional[str] = Query(None, max_length=200), db: Session = Depends(get_db)):
    """외부 노출 변경 이력 — 최근 days 일 동안 새로 열리거나 사라진 엔드포인트."""
    _cfg, link = _ensure_public(db, t)
    return _es.changes_view(db, _public_cluster(db, cluster_id, link), days)


class SshCreds(BaseModel):
    host: str = Field(..., min_length=1, max_length=255)
    port: int = Field(22, ge=1, le=65535)
    username: str = Field("root", min_length=1, max_length=64)
    password: Optional[str] = None
    private_key: Optional[str] = None


class CollectBody(BaseModel):
    # ssh: 노드에서 nslookup(정확) → 못 찾은 IP 는 backend 폴백 / backend: backend PTR 만 / none: 역조회 생략
    resolver: Literal["ssh", "backend", "none"] = "backend"
    ssh: Optional[SshCreds] = None
    # 이번 수집에서만 설정값을 덮는다(None 이면 설정 `forward_check` / `probe_enabled`).
    forward_check: Optional[bool] = None
    probe: Optional[bool] = None
    tls_check: Optional[bool] = None


@router.post("/{cluster_id}/collect/stream")
async def collect_stream(cluster_id: UUID, payload: CollectBody, request: Request,
                         db: Session = Depends(get_db), user: User = Depends(require_operator)):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    require_cluster_access(db, user, cluster_id)
    target = None
    if payload.resolver == "ssh":
        s = payload.ssh
        if s is None or not (s.password or s.private_key):
            raise HTTPException(status_code=422, detail="SSH 역조회는 호스트와 비밀번호 또는 개인키가 필요합니다")
        from app.services.ssh_runner import SSHTarget
        target = SSHTarget(host=s.host.strip(), port=s.port, username=s.username.strip(),
                           password=s.password or None, private_key=s.private_key or None)
    audit_logger.record(db, action="external_services.collect", actor=user, status="success",
                        target_type="cluster", target_id=str(cluster_id),
                        details={"resolver": payload.resolver, "ssh_host": target.host if target else None},
                        request=request)
    username = user.username
    cname = cluster.name

    async def job(sdb: Session, emit: Emit):
        c = sdb.query(Cluster).filter(Cluster.id == cluster_id).first()
        log_evt(emit, "info", f"{cname} 외부 서비스 수집 시작 — 역조회 방식 {payload.resolver}")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: _es.collect(
            sdb, c, resolver=payload.resolver, ssh_target=target, actor=username,
            forward_check=payload.forward_check, probe=payload.probe, tls_check=payload.tls_check,
            emit=lambda lvl, msg: log_evt(emit, lvl, msg),
            step=lambda name, label, st: step_evt(emit, name, label, st),
        ))

    return stream_async_job(job, name="external-services-collect")


class SettingsBody(BaseModel):
    public_enabled: Optional[bool] = None
    public_cluster_ids: Optional[list[str]] = None
    schedule_enabled: Optional[bool] = None
    schedule_cron: Optional[str] = None
    include_nodeport: Optional[bool] = None
    exclude_namespaces: Optional[list[str]] = None
    backend_ptr: Optional[bool] = None
    dns_timeout_sec: Optional[int] = None
    ptr_command: Optional[str] = None
    check_source: Optional[Literal["auto", "node", "backend"]] = None
    forward_check: Optional[bool] = None
    fwd_command: Optional[str] = None
    probe_enabled: Optional[bool] = None
    probe_http: Optional[bool] = None
    probe_timeout_sec: Optional[int] = None
    probe_max: Optional[int] = None
    probe_tcp_command: Optional[str] = None
    probe_http_command: Optional[str] = None
    tls_check: Optional[bool] = None
    tls_ports: Optional[list[int]] = None
    tls_warn_days: Optional[int] = None
    tls_critical_days: Optional[int] = None
    tls_command: Optional[str] = None
    access_mode: Optional[Literal["open", "link"]] = None
    change_retention_days: Optional[int] = None
    new_badge_days: Optional[int] = None


@router.get("/settings")
def get_settings(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return _es.get_settings(db)


@router.put("/settings")
def put_settings(payload: SettingsBody, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_admin)):
    values = payload.model_dump(exclude_none=True)
    if "schedule_cron" in values:
        try:
            from croniter import croniter
            if not croniter.is_valid(values["schedule_cron"].strip()):
                raise HTTPException(status_code=422, detail="schedule_cron 이 올바른 cron 식이 아닙니다")
        except ImportError:
            pass
    if "ptr_command" in values and "{ip}" not in values["ptr_command"]:
        raise HTTPException(status_code=422, detail="ptr_command 에는 {ip} 자리표시가 있어야 합니다")
    for key, ph in (("fwd_command", "{domain}"), ("probe_tcp_command", "{ip}"), ("probe_http_command", "{host}"),
                    ("tls_command", "{ip}")):
        if key in values and (ph not in values[key] or not _es.template_ok(values[key])):
            raise HTTPException(status_code=422, detail=(
                f"{key} 에는 {ph} 자리표시가 있어야 하고, 쓸 수 있는 자리표시는 "
                "{domain}·{ip}·{port}·{host}·{scheme}·{timeout}·{sni} 뿐입니다(리터럴 중괄호는 {{ }})"))
    val = _es.set_settings(db, values)
    audit_logger.record(db, action="external_services.settings.update", actor=actor, status="success",
                        target_type="external_services", target_id="settings", details=values, request=request)
    return val
