"""서비스 구성 라우터 — K8S 허브 ▸ 구성 ▸ 서비스 구성.

서비스 목록, 서비스별 설정 화면 데이터(설정 항목 × 버전 값 × 노드별 현재 값, 노드 그룹 범위), 현재 값으로 V1 만들기,
초안 의존 평가, 버전 저장·비교·되돌리기, 노드 그룹 CRUD.
경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 read(GET)/operate(POST·PUT·DELETE)를 판정한다.
초안 평가는 읽기라 viewer 도 써야 해서 경로가 아니라 본문으로 클러스터를 받고 핸들러가 read 를 판정한다.
노드에는 아무것도 실행하지 않는다(수집은 ``versions`` 라우터, 적용은 다음 단계).
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.cluster_access import require_cluster_access
from app.services.service_config import apply as A
from app.services.service_config import view as V

router = APIRouter(prefix="/service-config", tags=["Service Config"])


def _cluster(db: Session, cluster_id: UUID) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return c


@router.get("/services")
def list_services(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": V.service_list(db)}


def _raise(exc: "V.ServiceConfigError"):
    raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


# ── 서비스 상태(드리프트·알람·최근 변경) — `{service}` 경로보다 먼저 등록해야 'status' 가 서비스 이름으로 잡히지 않는다 ──

@router.get("/clusters/{cluster_id}/status")
def all_service_status(
    cluster_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """서비스별 수준(ok·warning·critical)과 사유 — 서비스 레일 상태 점용."""
    from app.services.service_config import status as S

    return S.all_status(db, _cluster(db, cluster_id))


@router.post("/clusters/{cluster_id}/collect-static-pods")
def collect_static_pods(
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """컨트롤 플레인 정적 파드(etcd·kube-apiserver·kube-controller-manager·kube-scheduler) 플래그를 노드별로 수집 — K8S API, 노드는 그대로."""
    from app.services.service_config import collect as CL

    from app.services.service_config import watch as W

    cluster = _cluster(db, cluster_id)
    out = CL.collect_static_pods(db, cluster)
    W.sync_drift(db, cluster, ("etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"))
    audit_logger.record(db, action="service_config.collect.static_pods", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"changed": out["changed"], "errors": out["errors"][:5]},
                        request=request)
    return out


@router.get("/clusters/{cluster_id}/{service}/status")
def one_service_status(
    cluster_id: UUID,
    service: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """한 서비스의 드리프트(기준 버전과 다른 노드 값)·열린 알람·최근 변경·미적용·최근 적용 — 배너·행 배지·요약 탭용."""
    from app.services.service_config import status as S

    try:
        return S.service_status(db, _cluster(db, cluster_id), service)
    except V.ServiceConfigError as exc:
        _raise(exc)


@router.get("/clusters/{cluster_id}/{service}")
def service_view(
    cluster_id: UUID,
    service: str,
    version: Optional[int] = Query(default=None, ge=1, description="보여줄 버전 번호(없으면 최신)"),
    group_id: Optional[UUID] = Query(default=None, description="노드 그룹(없으면 기본 그룹)"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return V.build_view(db, _cluster(db, cluster_id), service, version, group_id)
    except V.ServiceConfigError as exc:
        _raise(exc)


@router.post("/clusters/{cluster_id}/{service}/import", status_code=201)
def import_current(
    cluster_id: UUID,
    service: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """현재 노드 값으로 V1 을 만든다(DB 저장만 — 노드에는 아무것도 하지 않는다)."""
    cluster = _cluster(db, cluster_id)
    try:
        out = V.import_v1(db, cluster, service, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.import", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "imported": out["imported"], "mixed": len(out["mixed"])},
                        request=request)
    return out


# ── 초안 평가(읽기) ──────────────────────────────────────────────────────────

class ConfigValue(BaseModel):
    """설정 값 1개. 맵이 아니라 목록으로 받는 이유: 프런트 axios 가 요청 본문 키를 snake_case 로 바꾸므로
    ``SystemdCgroup`` 같은 설정 키가 객체 키로 오면 망가진다 — 키를 값 자리에 둔다."""
    key: str = Field(..., min_length=1, max_length=300)
    value: Optional[str] = Field(default=None, max_length=2000)


def _as_map(values: list[ConfigValue]) -> dict[str, Optional[str]]:
    return {v.key: v.value for v in values}


class EvaluateInput(BaseModel):
    cluster_id: UUID
    service: str = Field(..., max_length=32)
    group_id: Optional[UUID] = None
    values: list[ConfigValue] = Field(default_factory=list, max_length=1000)


@router.post("/evaluate")
def evaluate(
    body: EvaluateInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """편집 중인 초안 값 → 의존 규칙 결과(권장·필수·영향). 저장하지 않는다."""
    require_cluster_access(db, user, body.cluster_id, "read")
    try:
        return V.evaluate_draft(db, _cluster(db, body.cluster_id), body.service, body.group_id, _as_map(body.values))
    except V.ServiceConfigError as exc:
        _raise(exc)


# ── 버전 ─────────────────────────────────────────────────────────────────────

class SaveVersionInput(BaseModel):
    base_version_no: int = Field(..., ge=0, description="편집을 시작한 버전 번호 — 그사이 다른 저장이 있으면 409")
    group_id: Optional[UUID] = None
    values: list[ConfigValue] = Field(..., max_length=1000)
    note: Optional[str] = Field(default=None, max_length=2000)


@router.post("/clusters/{cluster_id}/{service}/versions", status_code=201)
def save_version(
    cluster_id: UUID,
    service: str,
    body: SaveVersionInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """새 설정 버전 저장(노드에는 아무것도 하지 않는다 — 적용은 따로)."""
    try:
        out = V.save_version(db, _cluster(db, cluster_id), service, body.group_id, body.base_version_no,
                             _as_map(body.values), body.note, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.version.save", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "group_id": str(body.group_id or ""),
                                 "version_no": out["version"]["version_no"],
                                 "keys": [c["key"] for c in out["changes"]][:50]},
                        request=request)
    return out


@router.get("/clusters/{cluster_id}/{service}/versions/compare")
def compare_versions(
    cluster_id: UUID,
    service: str,
    a: int = Query(..., ge=1),
    b: int = Query(..., ge=1),
    group_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return V.compare_versions(db, _cluster(db, cluster_id), service, group_id, a, b)
    except V.ServiceConfigError as exc:
        _raise(exc)


@router.post("/clusters/{cluster_id}/{service}/versions/{version_no}/revert", status_code=201)
def revert_version(
    cluster_id: UUID,
    service: str,
    version_no: int,
    request: Request,
    group_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """고른 버전의 값으로 새 버전을 저장한다(적용은 따로)."""
    try:
        out = V.revert_to(db, _cluster(db, cluster_id), service, group_id, version_no, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.version.revert", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "group_id": str(group_id or ""), "from": version_no,
                                 "version_no": out["version"]["version_no"]},
                        request=request)
    return out


# ── 노드 그룹 ────────────────────────────────────────────────────────────────

class GroupInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    node_pattern: str = Field(..., min_length=1, max_length=500)
    description: Optional[str] = Field(default=None, max_length=2000)


def _group_out(g) -> dict[str, Any]:
    return {"id": str(g.id), "name": g.name, "node_pattern": g.node_pattern, "description": g.description,
            "sort_order": g.sort_order}


@router.post("/clusters/{cluster_id}/{service}/groups", status_code=201)
def create_group(
    cluster_id: UUID,
    service: str,
    body: GroupInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    try:
        g = V.save_group(db, _cluster(db, cluster_id), service, None, body.name, body.node_pattern,
                         body.description, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.group.create", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "name": g.name}, request=request)
    return _group_out(g)


@router.put("/clusters/{cluster_id}/{service}/groups/{group_id}")
def update_group(
    cluster_id: UUID,
    service: str,
    group_id: UUID,
    body: GroupInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    try:
        g = V.save_group(db, _cluster(db, cluster_id), service, group_id, body.name, body.node_pattern,
                         body.description, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.group.update", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "name": g.name}, request=request)
    return _group_out(g)


@router.delete("/clusters/{cluster_id}/{service}/groups/{group_id}", status_code=204)
def delete_group(
    cluster_id: UUID,
    service: str,
    group_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """그룹과 그 그룹의 재정의 버전을 지운다 — 그룹 노드는 기본 그룹 값으로 돌아간다(노드 적용은 따로)."""
    try:
        name = V.delete_group(db, _cluster(db, cluster_id), service, group_id)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.group.delete", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "name": name}, request=request)


# ── 적용 ─────────────────────────────────────────────────────────────────────

@router.get("/clusters/{cluster_id}/{service}/apply/plan")
def apply_plan(
    cluster_id: UUID,
    service: str,
    version: Optional[int] = Query(default=None, ge=1),
    group_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """적용 미리보기 — 대상 노드·접속 주소·변경 목록(노드에는 아무것도 하지 않는다)."""
    try:
        return A.plan_apply(db, _cluster(db, cluster_id), service, version, group_id)
    except V.ServiceConfigError as exc:
        _raise(exc)


class ApplySsh(BaseModel):
    username: str = Field(default="root", min_length=1, max_length=64)
    port: int = Field(default=22, ge=1, le=65535)
    password: Optional[str] = Field(default=None, max_length=4096)
    private_key: Optional[str] = Field(default=None, max_length=20000)
    use_sudo: bool = False
    connect_timeout: int = Field(default=8, ge=1, le=60)


class ApplyOptions(BaseModel):
    batch_size: int = Field(default=1, ge=1, le=50)
    pause_sec: int = Field(default=10, ge=0, le=600)
    stop_on_failure: bool = True
    persist: bool = True                 # OS — 영구 파일 기록(끄면 sysctl -w 만)
    update_watch_rules: bool = True      # OS — 감시 규칙을 적용 값으로
    restart: bool = True                 # CILIUM — DaemonSet 롤링 재시작
    rollout_timeout_sec: Optional[int] = Field(default=None, ge=30, le=3600)
    auto_restore: bool = True            # ETCD·CONTAINERD — 실패 시 백업 복원
    health_timeout_sec: Optional[int] = Field(default=None, ge=30, le=1800)    # ETCD
    cordon: bool = True                  # CONTAINERD
    drain: bool = False                  # CONTAINERD
    drain_timeout_sec: int = Field(default=300, ge=30, le=1800)
    node_ready_timeout_sec: Optional[int] = Field(default=None, ge=30, le=1800)


class ApplyInput(BaseModel):
    version_no: Optional[int] = Field(default=None, ge=1)
    group_id: Optional[UUID] = None
    target_mode: str = Field(default="scope", pattern="^(scope|nodes)$")
    nodes: list[str] = Field(default_factory=list, max_length=2000)
    options: ApplyOptions = Field(default_factory=ApplyOptions)
    ssh: Optional[ApplySsh] = None


@router.post("/clusters/{cluster_id}/{service}/apply/stream")
async def apply_stream(
    cluster_id: UUID,
    service: str,
    body: ApplyInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """설정 버전을 노드에 적용 — SSE 실시간 로그. 검증 실패는 스트림을 열기 전에 일반 HTTP 오류로 낸다.
    SSH 자격증명은 이 요청 안에서만 쓰고 어디에도 저장하지 않는다(실행 이력·감사 로그에도 남기지 않는다)."""
    from app.services.sse import stream_async_job

    cluster = _cluster(db, cluster_id)
    try:
        plan = A.plan_apply(db, cluster, service, body.version_no, body.group_id, body.target_mode, body.nodes)
        creds: dict[str, Any] = {}
        if service in A.SSH_SERVICES:
            if body.ssh is None or not (body.ssh.password or (body.ssh.private_key or "").strip()):
                raise A.ApplyError(422, f"{plan['service']['label']} 적용에는 SSH 비밀번호 또는 개인 키가 필요합니다(저장하지 않습니다).")
            creds = body.ssh.model_dump()
            A.validate_pairs(plan["values"])
        opts = body.options.model_dump()
        if service in A.ONE_BY_ONE_SERVICES:  # 쿼럼·컨트롤 플레인 보호 — 한 대씩·실패 시 중단은 고정
            opts.update(batch_size=1, stop_on_failure=True)
        run = A.start_run(db, cluster, service, plan, opts, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.apply.start", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "run_id": str(run.id), "version_no": plan["version_no"],
                                 "group": plan["group"]["name"], "target_mode": plan["target_mode"],
                                 "nodes": [t["node"] for t in plan["targets"]][:50],
                                 "keys": [c["key"] for c in plan["changes"]][:50]},
                        request=request)
    run_id = run.id
    actor_name = user.username

    async def job(sdb: Session, emit):
        emit({"type": "run", "run_id": str(run_id)})  # 화면이 중지·이력 조회에 쓸 실행 id 를 먼저 알린다
        c = sdb.query(type(cluster)).filter(type(cluster).id == cluster_id).one()
        out = await A.execute(sdb, c, run_id, plan, opts, creds, emit)
        audit_logger.record(sdb, action="service_config.apply.finish", actor_username=actor_name,
                            status="success" if out["status"] == "succeeded" else "failure",
                            target_type="cluster", target_id=str(cluster_id),
                            details={"service": service, "run_id": str(run_id), "status": out["status"]})
        return out

    return stream_async_job(job, name=f"service-config-apply-{service}")


@router.get("/clusters/{cluster_id}/{service}/apply-runs")
def list_apply_runs(
    cluster_id: UUID,
    service: str,
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.models.service_config import ServiceConfigApplyRun as R

    rows = (db.query(R).filter(R.cluster_id == cluster_id, R.service == service)
            .order_by(R.started_at.desc()).limit(limit).all())
    return {"items": [A.run_out(r, with_logs=False) for r in rows]}


def _get_run(db: Session, cluster_id: UUID, service: str, run_id: UUID):
    from app.models.service_config import ServiceConfigApplyRun as R

    r = db.query(R).filter(R.id == run_id, R.cluster_id == cluster_id, R.service == service).first()
    if r is None:
        raise HTTPException(status_code=404, detail="적용 이력을 찾을 수 없습니다.")
    return r


@router.get("/clusters/{cluster_id}/{service}/apply-runs/{run_id}")
def get_apply_run(
    cluster_id: UUID,
    service: str,
    run_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    return A.run_out(_get_run(db, cluster_id, service, run_id))


@router.post("/clusters/{cluster_id}/{service}/apply-runs/{run_id}/stop")
def stop_apply_run(
    cluster_id: UUID,
    service: str,
    run_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """중지 요청 — 진행 중인 노드는 마치고, 다음 배치부터 건너뛴다."""
    r = _get_run(db, cluster_id, service, run_id)
    if r.status != A.RUN_ACTIVE:
        raise HTTPException(status_code=409, detail="이미 끝난 적용입니다.")
    r.stop_requested = True
    db.commit()
    audit_logger.record(db, action="service_config.apply.stop", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "run_id": str(run_id)}, request=request)
    return {"ok": True}


# ── 적용 설정(UI-First) ──────────────────────────────────────────────────────

class ApplySettingsUpdate(BaseModel):
    sysctl_file: Optional[str] = Field(default=None, max_length=300)
    cilium_namespace: Optional[str] = Field(default=None, max_length=63)
    cilium_configmap: Optional[str] = Field(default=None, max_length=253)
    cilium_daemonset: Optional[str] = Field(default=None, max_length=253)
    rollout_timeout_sec: Optional[int] = Field(default=None, ge=30, le=3600)
    etcd_mode: Optional[str] = Field(default=None, pattern="^(auto|static_pod|systemd)$")
    etcd_manifest: Optional[str] = Field(default=None, max_length=300)
    etcd_env_file: Optional[str] = Field(default=None, max_length=300)
    etcd_service: Optional[str] = Field(default=None, max_length=100)
    etcd_backup_dir: Optional[str] = Field(default=None, max_length=300)
    etcd_health_cmd: Optional[str] = Field(default=None, max_length=300)
    etcd_health_expect: Optional[str] = Field(default=None, max_length=300)
    etcd_health_timeout_sec: Optional[int] = Field(default=None, ge=30, le=1800)
    containerd_config: Optional[str] = Field(default=None, max_length=300)
    containerd_service: Optional[str] = Field(default=None, max_length=100)
    containerd_restart_cmd: Optional[str] = Field(default=None, max_length=300)
    node_ready_timeout_sec: Optional[int] = Field(default=None, ge=30, le=1800)
    static_pod_manifest_dir: Optional[str] = Field(default=None, max_length=300)
    apiserver_health_cmd: Optional[str] = Field(default=None, max_length=300)
    controller_manager_health_cmd: Optional[str] = Field(default=None, max_length=300)
    scheduler_health_cmd: Optional[str] = Field(default=None, max_length=300)
    control_plane_health_expect: Optional[str] = Field(default=None, max_length=300)
    control_plane_health_timeout_sec: Optional[int] = Field(default=None, ge=30, le=1800)
    kubelet_config: Optional[str] = Field(default=None, max_length=300)
    kubelet_service: Optional[str] = Field(default=None, max_length=100)
    kubelet_restart_cmd: Optional[str] = Field(default=None, max_length=300)


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return A.get_settings(db)


@router.put("/settings")
def update_settings(
    body: ApplySettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    try:
        out = A.set_settings(db, patch)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.settings.update", actor=user, target_type="app_setting",
                        target_id=A.SETTINGS_KEY, details={"fields": sorted(patch)}, request=request)
    return out


# ── 감시 설정(변경 감지·알람) ────────────────────────────────────────────────

class WatchSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    interval_min: Optional[int] = Field(default=None, ge=1, le=1440)
    change_alert: Optional[bool] = None
    change_severity: Optional[str] = Field(default=None, pattern="^(info|warning|critical)$")
    drift_alert: Optional[bool] = None
    drift_severity: Optional[str] = Field(default=None, pattern="^(info|warning|critical)$")


@router.get("/watch-settings")
def read_watch_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.services.service_config import watch as W

    return W.get_settings(db)


@router.put("/watch-settings")
def update_watch_settings(
    body: WatchSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    from app.services.service_config import watch as W

    patch = body.model_dump(exclude_unset=True)
    out = W.set_settings(db, patch)
    audit_logger.record(db, action="service_config.watch_settings.update", actor=user, target_type="app_setting",
                        target_id=W.SETTINGS_KEY, details={"fields": sorted(patch)}, request=request)
    return out
