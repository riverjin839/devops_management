"""Cilium 데이터패스(eBPF) 라우터 — Rust 노드 에이전트(pep-bpf-agent) 수신과 화면 API.

- ``ingest_router`` : **JWT 없음**. 에이전트가 Bearer ``CILIUM_BPF_AGENT_TOKEN`` 으로 보고·작업 수신·로그 전송을 한다.
  토큰 미설정 시 **503 fail-closed**(노드 파라미터·알람 수신과 같은 정책).
- ``router``        : JWT. 클러스터별 맵 사용률·프로그램 목록, 「지금 수집」(SSE 실시간 로그), 설정·설치 매니페스트.
  경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 read/operate 를 판정한다.

판정·알람·실행 로직은 ``services/cilium_datapath/`` 에 있다.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.config import settings
from app.database import SessionLocal, get_db
from app.models.cilium_datapath import CiliumBpfAgent, CiliumDatapathRun
from app.models.cluster import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.cilium_datapath import runs as R
from app.services.cilium_datapath import service as svc
from app.services.cilium_datapath.manifest import render_manifest
from app.services.cilium_datapath.settings import get_settings, set_settings
from app.services.node_param_watch.service import resolve_cluster
from app.services.sse import Emit, step_evt, stream_async_job

logger = logging.getLogger(__name__)

ingest_router = APIRouter(prefix="/cilium-datapath", tags=["Cilium Datapath Ingest"])
router = APIRouter(prefix="/cilium-datapath", tags=["Cilium Datapath"])

TASK_POLL_SEC = 2.0


# ── 수신 (에이전트) ──────────────────────────────────────────────────────────

def _verify_token(authorization: str = Header(default="")) -> None:
    expected = (settings.cilium_bpf_agent_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                "Cilium 데이터패스 수신 비활성화: CILIUM_BPF_AGENT_TOKEN 이 설정되지 않았습니다. "
                "backend 환경변수에 토큰을 설정한 뒤 에이전트 Secret 에 같은 값을 넣으세요."
            ),
        )
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="수신 토큰이 올바르지 않습니다.")


class AgentReport(BaseModel):
    cluster: str = Field(..., min_length=1, max_length=253, description="클러스터 UUID 또는 이름")
    node: str = Field(..., min_length=1, max_length=253)
    host_ip: Optional[str] = Field(default=None, max_length=64)
    agent_version: Optional[str] = Field(default=None, max_length=32)
    collected_at: Optional[str] = Field(default=None, max_length=40)
    run_id: Optional[str] = Field(default=None, max_length=64)
    features: dict[str, Any] = Field(default_factory=dict)
    maps: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    maps_skipped: int = 0
    programs: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    programs_other: int = 0
    programs_error: Optional[str] = None
    errors: list[str] = Field(default_factory=list, max_length=500)
    collect_ms: Optional[int] = None


def _cluster_or_404(db: Session, hint: str) -> Cluster:
    cluster = resolve_cluster(db, hint)
    if cluster is None:
        raise HTTPException(status_code=404, detail=f"클러스터 '{hint}' 를 찾을 수 없습니다.")
    return cluster


@ingest_router.post("/agent/report")
def agent_report(body: AgentReport, db: Session = Depends(get_db), _: None = Depends(_verify_token)) -> dict[str, Any]:
    """보고 1건 — 응답으로 다음 주기의 수집 설정(``config``)을 돌려준다."""
    cluster = _cluster_or_404(db, body.cluster)
    try:
        return svc.handle_report(db, cluster, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("cilium bpf report 처리 실패 (%s/%s)", body.cluster, body.node)
        raise HTTPException(status_code=500, detail=f"보고 처리 실패: {exc}") from exc


def _claim(cluster_id: UUID, node: str) -> Optional[dict[str, Any]]:
    with SessionLocal() as s:
        return R.claim_task(s, cluster_id, node)


@ingest_router.get("/agent/tasks")
async def agent_tasks(
    cluster: str = Query(..., min_length=1, max_length=253),
    node: str = Query(..., min_length=1, max_length=253),
    wait: int = Query(default=25, ge=0, le=30),
    _: None = Depends(_verify_token),
) -> dict[str, Any]:
    """수동 실행 작업 수신(long-poll) — 작업이 생기면 바로, 없으면 ``wait`` 초 뒤 ``{"task": null}``."""
    with SessionLocal() as s:
        cid = _cluster_or_404(s, cluster).id
    deadline = time.monotonic() + wait
    while True:
        task = await asyncio.to_thread(_claim, cid, node)
        if task:
            return {"task": task}
        if time.monotonic() >= deadline:
            return {"task": None}
        await asyncio.sleep(min(TASK_POLL_SEC, max(0.0, deadline - time.monotonic())))


class RunLogBody(BaseModel):
    cluster: str = Field(..., min_length=1, max_length=253)
    node: str = Field(..., min_length=1, max_length=253)
    lines: list[dict[str, Any]] = Field(default_factory=list, max_length=500)


@ingest_router.post("/agent/runs/{run_id}/log")
def agent_run_log(run_id: str, body: RunLogBody, db: Session = Depends(get_db),
                  _: None = Depends(_verify_token)) -> dict[str, Any]:
    cluster = _cluster_or_404(db, body.cluster)
    if not R.append_logs(db, run_id, cluster.id, body.node, body.lines):
        raise HTTPException(status_code=404, detail="실행을 찾을 수 없거나 이 노드가 대상이 아닙니다.")
    return {"ok": True}


# ── 설정 ─────────────────────────────────────────────────────────────────────

class SettingsUpdate(BaseModel):
    interval_sec: Optional[int] = Field(default=None, ge=30, le=3600)
    map_budget_ms: Optional[int] = Field(default=None, ge=50, le=30000)
    total_budget_ms: Optional[int] = Field(default=None, ge=500, le=120000)
    warn_pct: Optional[int] = Field(default=None, ge=1, le=100)
    crit_pct: Optional[int] = Field(default=None, ge=1, le=100)
    alerts_enabled: Optional[bool] = None
    pin_dirs: Optional[list[str]] = Field(default=None, max_length=20)
    map_prefixes: Optional[list[str]] = Field(default=None, max_length=20)
    program_prefixes: Optional[list[str]] = Field(default=None, max_length=20)
    sys_admin: Optional[bool] = None
    run_timeout_sec: Optional[int] = Field(default=None, ge=15, le=600)
    offline_minutes: Optional[int] = Field(default=None, ge=1, le=1440)
    agent_image: Optional[str] = Field(default=None, max_length=500)
    agent_namespace: Optional[str] = Field(default=None, max_length=63)
    ingest_base_url: Optional[str] = Field(default=None, max_length=500)
    tls_verify: Optional[bool] = None


def _settings_out(db: Session) -> dict[str, Any]:
    return {**get_settings(db), "token_configured": bool((settings.cilium_bpf_agent_token or "").strip())}


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _settings_out(db)


@router.put("/settings")
def update_settings(body: SettingsUpdate, request: Request, db: Session = Depends(get_db),
                    user: User = Depends(require_admin)) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    warn = patch.get("warn_pct", get_settings(db)["warn_pct"])
    crit = patch.get("crit_pct", get_settings(db)["crit_pct"])
    if warn >= crit:
        raise HTTPException(status_code=422, detail="주의 임계치는 위험 임계치보다 작아야 합니다.")
    set_settings(db, patch)
    audit_logger.record(db, action="cilium_datapath.settings.update", actor=user, target_type="app_setting",
                        target_id="cilium_datapath.settings", details={"fields": sorted(patch)}, request=request)
    return _settings_out(db)


# ── 클러스터별 조회·실행 ──────────────────────────────────────────────────────

def _cluster(db: Session, cluster_id: UUID) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return c


@router.get("/clusters/{cluster_id}")
def cluster_view(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    view = svc.cluster_view(db, _cluster(db, cluster_id))
    last = (db.query(CiliumDatapathRun).filter(CiliumDatapathRun.cluster_id == cluster_id)
            .order_by(CiliumDatapathRun.created_at.desc()).first())
    view["last_run"] = R.run_out(last) if last else None
    view["token_configured"] = bool((settings.cilium_bpf_agent_token or "").strip())
    return view


@router.get("/clusters/{cluster_id}/runs")
def cluster_runs(cluster_id: UUID, limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db),
                 _: User = Depends(get_current_user)) -> dict[str, Any]:
    _cluster(db, cluster_id)
    rows = (db.query(CiliumDatapathRun).filter(CiliumDatapathRun.cluster_id == cluster_id)
            .order_by(CiliumDatapathRun.created_at.desc()).limit(limit).all())
    return {"items": [R.run_out(r) for r in rows]}


class CollectRequest(BaseModel):
    nodes: Optional[list[str]] = Field(default=None, max_length=500, description="비우면 보고 중인 전체 노드")


@router.post("/clusters/{cluster_id}/collect")
async def collect_now(cluster_id: UUID, body: CollectRequest, request: Request, db: Session = Depends(get_db),
                      user: User = Depends(require_operator)):
    """「지금 수집」 — 에이전트에 작업을 보내고 단계별 로그를 SSE 로 흘린다(마지막 이벤트 ``result``)."""
    cluster = _cluster(db, cluster_id)
    try:
        run = R.create_run(db, cluster, user.username, body.nodes)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit_logger.record(db, action="cilium_datapath.collect", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"run_id": str(run.id), "nodes": len(run.target_nodes)},
                        request=request)
    run_id = run.id
    targets = list(run.target_nodes)
    timeout = get_settings(db)["run_timeout_sec"]

    async def job(sdb: Session, emit: Emit) -> dict[str, Any]:
        for n in targets:
            step_evt(emit, f"node:{n}", n, "running")
        sent = 0
        marked: set[str] = set()
        t0 = time.monotonic()
        while True:
            sdb.expire_all()
            r = sdb.get(CiliumDatapathRun, run_id)
            if r is None:
                raise HTTPException(status_code=404, detail="실행 기록이 사라졌습니다.")
            lines = r.log_lines or []
            for ln in lines[sent:]:
                node = ln.get("node")
                msg = f"[{node}] {ln.get('message', '')}" if node else str(ln.get("message", ""))
                emit({"type": "log", "level": ln.get("level") or "info", "ts": ln.get("ts"), "message": msg})
            sent = len(lines)
            for n in r.done_nodes or []:
                if n not in marked:
                    marked.add(n)
                    step_evt(emit, f"node:{n}", n, "done")
            if r.status != "running":
                for n in targets:
                    if n not in marked:
                        step_evt(emit, f"node:{n}", n, "failed")
                return {"run": R.run_out(r)}
            if time.monotonic() - t0 > timeout:
                R.finalize(sdb, run_id)
                continue
            await asyncio.sleep(0.5)

    return stream_async_job(job, name="cilium-datapath-collect")


def _agent(db: Session, cluster_id: UUID, agent_id: UUID) -> CiliumBpfAgent:
    agent = (db.query(CiliumBpfAgent)
             .filter(CiliumBpfAgent.id == agent_id, CiliumBpfAgent.cluster_id == cluster_id).first())
    if agent is None:
        raise HTTPException(status_code=404, detail="에이전트를 찾을 수 없습니다.")
    return agent


@router.post("/clusters/{cluster_id}/agents/{agent_id}/baseline")
def set_program_baseline(cluster_id: UUID, agent_id: UUID, request: Request, db: Session = Depends(get_db),
                         user: User = Depends(require_operator)) -> dict[str, Any]:
    """이 노드의 현재 프로그램 목록을 비교 기준으로 저장한다(설정 적용 직전에 누르면 전후 비교가 된다)."""
    agent = _agent(db, cluster_id, agent_id)
    svc.set_baseline(db, agent)
    audit_logger.record(db, action="cilium_datapath.baseline", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"node": agent.node}, request=request)
    return {"ok": True, "node": agent.node, "baseline_at": agent.baseline_at.isoformat() + "Z"}


@router.delete("/clusters/{cluster_id}/agents/{agent_id}", status_code=204)
def delete_agent(cluster_id: UUID, agent_id: UUID, request: Request, db: Session = Depends(get_db),
                 user: User = Depends(require_operator)):
    """없앤 노드의 에이전트를 목록에서 지운다(열린 사용률 알람은 닫는다). 노드가 살아 있으면 다음 보고 때 다시 생긴다."""
    cluster = _cluster(db, cluster_id)
    agent = _agent(db, cluster_id, agent_id)
    node = agent.node
    svc.remove_agent(db, cluster, agent)
    audit_logger.record(db, action="cilium_datapath.agent.delete", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"node": node}, request=request)


@router.get("/clusters/{cluster_id}/manifest")
def agent_manifest(cluster_id: UUID, request: Request, db: Session = Depends(get_db),
                   _: User = Depends(get_current_user)) -> dict[str, Any]:
    """이 클러스터용 에이전트 설치 매니페스트(토큰은 자리표시자)."""
    cluster = _cluster(db, cluster_id)
    cfg = get_settings(db)
    base = cfg["ingest_base_url"] or str(request.base_url).rstrip("/") + "/api/v1"
    return {
        "yaml": render_manifest(cluster_id=str(cluster.id), cluster_name=cluster.name, api_base_url=base,
                                image=cfg["agent_image"], namespace=cfg["agent_namespace"],
                                tls_verify=cfg["tls_verify"], sys_admin=cfg["sys_admin"]),
        "api_base_url": base,
        "api_base_url_from_settings": bool(cfg["ingest_base_url"]),
        "token_configured": bool((settings.cilium_bpf_agent_token or "").strip()),
        "sys_admin": cfg["sys_admin"],
    }
