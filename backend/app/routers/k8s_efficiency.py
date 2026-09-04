"""K8S 자원 효율화 — 히스토리/추천/정책/실행 API.

- 조회: 인증된 모든 역할.
- 수집/추천 생성/적용/롤백/쿼터 조정/NS 정책: require_operator (+감사).
- 전역 스케줄·정책 기본값: require_admin (+감사).
무거운 작업(수집·적용)은 Celery 로 큐잉하고 run_id 를 돌려준다 — 프론트가 `GET /runs/{id}` 를
폴링해 단계/로그를 실시간 표시한다(CLAUDE.md "실행 버튼 = 실시간 로그" 규칙).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models import Cluster
from app.models.k8s_efficiency import (
    K8sEfficiencyRun, K8sNamespacePolicy, K8sRightsizeRecommendation,
)
from app.models.user import User
from app.schemas.k8s_efficiency import (
    ApplyBody, CustomScaleBody, NamespacePolicyBody, PolicyDefaultsBody, QuotaAdjustBody, ScheduleBody,
)
from app.services import audit_logger
from app.services.k8s_efficiency import history as _hist
from app.services.k8s_efficiency import settings as _cfg
from app.services.k8s_efficiency.apply import rollback_targets, targets_from_recommendations
from app.services.k8s_efficiency.quota import fmt_cpu_q, fmt_mem_q
from app.services.k8s_efficiency.runs import create_run

router = APIRouter(prefix="/k8s", tags=["k8s-efficiency"])


def _require_cluster(cluster_id: UUID, db: Session) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return c


def _enqueue(task_name: str, *args) -> Optional[str]:
    """Celery 태스크 큐잉 — 브로커 불가 시 503(빈 500 금지)."""
    try:
        from app import celery_app as ca
        task = getattr(ca, task_name).delay(*[str(a) if isinstance(a, UUID) else a for a in args])
        return getattr(task, "id", None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"작업 큐잉 실패(Celery/Redis 확인): {str(e)[:200]}")


def _next_run(cron: str) -> Optional[str]:
    try:
        from croniter import croniter
        if not croniter.is_valid(cron):
            return None
        return croniter(cron, datetime.now()).get_next(datetime).isoformat()
    except Exception:  # noqa: BLE001
        return None


def _validate_cron(cron: Optional[str]) -> None:
    if not cron:
        return
    try:
        from croniter import croniter
        ok = croniter.is_valid(cron)
    except Exception:  # noqa: BLE001
        ok = True
    if not ok:
        raise HTTPException(status_code=422, detail=f"유효하지 않은 cron 표현식: {cron}")


def _run_dict(r: K8sEfficiencyRun) -> dict[str, Any]:
    return {
        "id": str(r.id), "cluster_id": str(r.cluster_id), "run_type": r.run_type, "trigger": r.trigger,
        "triggered_by": r.triggered_by, "run_state": r.run_state, "dry_run": r.dry_run,
        "targets": r.targets or [], "before": r.before, "after": r.after, "steps": r.steps or [],
        "log_lines": r.log_lines or "", "summary": r.summary, "error": r.error,
        "rollback_of": str(r.rollback_of) if r.rollback_of else None,
        "queued_at": r.queued_at.isoformat() if r.queued_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "duration_ms": r.duration_ms or 0,
    }


def _rec_dict(r: K8sRightsizeRecommendation) -> dict[str, Any]:
    fmt = fmt_cpu_q if r.resource == "cpu" else fmt_mem_q
    return {
        "id": str(r.id), "namespace": r.namespace, "kind": r.kind, "name": r.name, "container": r.container,
        "resource": r.resource, "pod_count": r.pod_count,
        "current_req": r.current_req, "target_req": r.target_req,
        "current_req_display": fmt(r.current_req), "target_req_display": fmt(r.target_req),
        "current_lim": r.current_lim, "target_lim": r.target_lim,
        "p95_use": r.p95_use, "usage_source": r.usage_source, "samples": r.samples, "window_days": r.window_days,
        "savings": r.savings, "savings_display": fmt(r.savings), "reason": r.reason,
        "managed_by": r.managed_by, "recommend_only": r.recommend_only, "hint": r.hint, "status": r.status,
        "applied_run_id": str(r.applied_run_id) if r.applied_run_id else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _policy_dict(p: K8sNamespacePolicy) -> dict[str, Any]:
    return {
        "id": str(p.id), "cluster_id": str(p.cluster_id), "namespace": p.namespace,
        "auto_rightsize": p.auto_rightsize, "quota_elastic": p.quota_elastic, "quota_name": p.quota_name,
        "quota_cpu_min_m": p.quota_cpu_min_m, "quota_cpu_max_m": p.quota_cpu_max_m,
        "quota_mem_min_b": p.quota_mem_min_b, "quota_mem_max_b": p.quota_mem_max_b,
        "rightsize_params": p.rightsize_params or {}, "quota_params": p.quota_params or {},
        "custom_targets": p.custom_targets or [],
        "last_auto_apply_at": p.last_auto_apply_at.isoformat() if p.last_auto_apply_at else None,
        "last_quota_adjust_at": p.last_quota_adjust_at.isoformat() if p.last_quota_adjust_at else None,
        "updated_by": p.updated_by, "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


# ── 전역: 수집 스케줄 / 정책 기본값 (경로 충돌 방지 — /{cluster_id} 보다 먼저) ──────────
@router.get("/efficiency/schedule")
def get_schedule(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    sch = _cfg.get_schedule(db)
    clusters = {}
    for cid, c in sch["clusters"].items():
        cron = c.get("cron") or sch["default_cron"]
        clusters[cid] = {**c, "effective_cron": cron,
                         "next_run": _next_run(cron) if sch["enabled"] and c.get("enabled", True) else None}
    return {**sch, "clusters": clusters, "next_run": _next_run(sch["default_cron"]) if sch["enabled"] else None}


@router.put("/efficiency/schedule")
def put_schedule(payload: ScheduleBody, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_admin)):
    _validate_cron(payload.default_cron)
    clusters = None
    if payload.clusters is not None:
        clusters = {}
        for cid, c in payload.clusters.items():
            _validate_cron(c.cron)
            clusters[cid] = {"enabled": c.enabled, "cron": c.cron}
    val = _cfg.set_schedule(db, payload.enabled, payload.default_cron.strip(), clusters)
    audit_logger.record(db, action="k8s.efficiency.schedule.update", actor=actor, status="success",
                        target_type="k8s_efficiency", target_id="schedule",
                        details={"enabled": payload.enabled, "default_cron": payload.default_cron}, request=request)
    return val


@router.get("/efficiency/policy-defaults")
def get_policy_defaults(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return _cfg.get_policy_defaults(db)


@router.put("/efficiency/policy-defaults")
def put_policy_defaults(payload: PolicyDefaultsBody, request: Request, db: Session = Depends(get_db),
                        actor: User = Depends(require_admin)):
    _validate_cron(payload.maintenance_cron)
    values = payload.model_dump(exclude_none=True)
    if "quota" in values and isinstance(values["quota"], dict):
        values["quota"] = {k: v for k, v in values["quota"].items() if v is not None}
    val = _cfg.set_policy_defaults(db, values)
    audit_logger.record(db, action="k8s.efficiency.defaults.update", actor=actor, status="success",
                        target_type="k8s_efficiency", target_id="policy_defaults", details=values, request=request)
    return val


# ── 실행 로그 ──────────────────────────────────────────────────────────────────
@router.get("/efficiency/runs/{run_id}")
def get_run(run_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    r = db.query(K8sEfficiencyRun).filter(K8sEfficiencyRun.id == run_id).first()
    if r is None:
        raise HTTPException(status_code=404, detail="run not found")
    return _run_dict(r)


@router.post("/efficiency/runs/{run_id}/rollback")
def rollback_run(run_id: UUID, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_operator)):
    r = db.query(K8sEfficiencyRun).filter(K8sEfficiencyRun.id == run_id).first()
    if r is None:
        raise HTTPException(status_code=404, detail="run not found")
    if r.dry_run:
        raise HTTPException(status_code=422, detail="dry-run 실행은 롤백 대상이 아닙니다.")
    if r.run_state not in ("succeeded", "partial"):
        raise HTTPException(status_code=422, detail=f"롤백할 수 없는 상태입니다: {r.run_state}")
    targets = rollback_targets(r)
    if not targets:
        raise HTTPException(status_code=422, detail="복원할 before 스냅샷이 없습니다.")
    rb = create_run(db, r.cluster_id, r.run_type, trigger="rollback", triggered_by=actor.username,
                    dry_run=False, targets=targets, rollback_of=r.id)
    task_id = _enqueue("run_k8s_efficiency_run", rb.id)
    audit_logger.record(db, action="k8s.efficiency.rollback", actor=actor, status="success", target_type="k8s",
                        target_id=str(r.cluster_id), details={"run_id": str(r.id), "rollback_run_id": str(rb.id)},
                        request=request)
    return {"run_id": str(rb.id), "task_id": task_id}


@router.get("/{cluster_id}/efficiency/runs")
def list_runs(cluster_id: UUID, run_type: Optional[str] = None, limit: int = 30,
              db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    _require_cluster(cluster_id, db)
    q = db.query(K8sEfficiencyRun).filter(K8sEfficiencyRun.cluster_id == cluster_id)
    if run_type:
        q = q.filter(K8sEfficiencyRun.run_type == run_type)
    rows = q.order_by(K8sEfficiencyRun.queued_at.desc()).limit(max(1, min(limit, 200))).all()
    items = []
    for r in rows:
        d = _run_dict(r)
        d["log_lines"] = ""  # 목록에서는 로그 본문 제외(상세 폴링에서)
        items.append(d)
    return {"count": len(items), "items": items}


# ── 수집 ───────────────────────────────────────────────────────────────────────
@router.post("/{cluster_id}/efficiency/collect")
def collect_now(cluster_id: UUID, request: Request, db: Session = Depends(get_db),
                actor: User = Depends(require_operator)):
    _require_cluster(cluster_id, db)
    from app.services.k8s_efficiency.collector import STEP_PLAN
    run = create_run(db, cluster_id, "collect", trigger="manual", triggered_by=actor.username,
                     step_plan=STEP_PLAN + [{"id": "recommend", "label": "추천 생성"}, {"id": "automation", "label": "자동화 평가"}])
    task_id = _enqueue("collect_k8s_efficiency_one", cluster_id, run.id, actor.username)
    run.celery_task_id = task_id
    db.commit()
    audit_logger.record(db, action="k8s.efficiency.collect", actor=actor, status="success", target_type="cluster",
                        target_id=str(cluster_id), details={"run_id": str(run.id)}, request=request)
    return {"run_id": str(run.id), "task_id": task_id}


# ── 이력 ───────────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/efficiency/history/namespaces")
def history_namespaces(cluster_id: UUID, namespace: str, range: str = "7d",
                       db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    _require_cluster(cluster_id, db)
    if range not in _hist.RANGES:
        raise HTTPException(status_code=422, detail=f"range 는 {', '.join(_hist.RANGES)} 중 하나")
    return _hist.ns_series(db, cluster_id, namespace, range)


@router.get("/{cluster_id}/efficiency/history/ranking")
def history_ranking(cluster_id: UUID, range: str = "7d", metric: str = "cpu", top: int = 10,
                    db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    _require_cluster(cluster_id, db)
    if range not in _hist.RANGES:
        raise HTTPException(status_code=422, detail=f"range 는 {', '.join(_hist.RANGES)} 중 하나")
    if metric not in ("cpu", "mem"):
        raise HTTPException(status_code=422, detail="metric 은 cpu|mem")
    return _hist.ranking_over_time(db, cluster_id, range, metric=metric, top=max(1, min(top, 50)))


@router.get("/{cluster_id}/efficiency/history/summary")
def history_summary(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """NS 별 최신 샘플(NS 선택/quota 현황용)."""
    _require_cluster(cluster_id, db)
    rows = _hist.latest_ns_samples(db, cluster_id)
    return {"count": len(rows), "items": [{
        "namespace": s.namespace, "sampled_at": s.sampled_at.isoformat(), "pod_count": s.pod_count,
        "workload_count": s.workload_count, "cpu_req_m": s.cpu_req_m, "mem_req_b": s.mem_req_b,
        "cpu_use_m": s.cpu_use_m, "mem_use_b": s.mem_use_b, "usage_source": s.usage_source,
        "quota_name": s.quota_name, "quota_hard_cpu_m": s.quota_hard_cpu_m, "quota_hard_mem_b": s.quota_hard_mem_b,
        "quota_used_cpu_m": s.quota_used_cpu_m, "quota_used_mem_b": s.quota_used_mem_b,
    } for s in rows]}


@router.get("/{cluster_id}/efficiency/history/workloads")
def history_workloads(cluster_id: UUID, namespace: Optional[str] = None,
                      db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    _require_cluster(cluster_id, db)
    rows = _hist.latest_workload_samples(db, cluster_id, namespace)
    return {"count": len(rows), "items": [{
        "namespace": s.namespace, "kind": s.kind, "name": s.name, "sampled_at": s.sampled_at.isoformat(),
        "pod_count": s.pod_count, "cpu_req_m": s.cpu_req_m, "mem_req_b": s.mem_req_b,
        "cpu_use_m": s.cpu_use_m, "mem_use_b": s.mem_use_b, "containers": s.containers,
        "managed_by": s.managed_by, "optout": s.optout,
    } for s in rows]}


@router.get("/{cluster_id}/efficiency/quotas")
def live_quotas(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """라이브 ResourceQuota(정책 다이얼로그 기본값 프리필). apiserver 1회 LIST(작음)."""
    cluster = _require_cluster(cluster_id, db)
    from app.routers import k8s_allocation as ka
    from app.services.k8s_efficiency.collector import _quota_map
    try:
        with ka._api(cluster) as client:
            qm = _quota_map(client)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"ResourceQuota 조회 실패: {str(e)[:200]}")
    return {"count": len(qm), "items": [{"namespace": ns, **v} for ns, v in sorted(qm.items())]}


# ── 추천 ───────────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/efficiency/recommendations")
def list_recommendations(cluster_id: UUID, status: str = "open", namespace: Optional[str] = None,
                         db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    _require_cluster(cluster_id, db)
    q = db.query(K8sRightsizeRecommendation).filter(K8sRightsizeRecommendation.cluster_id == cluster_id)
    if status != "all":
        q = q.filter(K8sRightsizeRecommendation.status == status)
    if namespace:
        q = q.filter(K8sRightsizeRecommendation.namespace == namespace)
    rows = q.order_by(K8sRightsizeRecommendation.savings.desc()).limit(2000).all()
    items = [_rec_dict(r) for r in rows]
    totals = {"cpu_m": sum(r.savings for r in rows if r.resource == "cpu"),
              "mem_b": sum(r.savings for r in rows if r.resource == "memory"),
              "applicable": sum(1 for r in rows if not r.recommend_only),
              "recommend_only": sum(1 for r in rows if r.recommend_only)}
    latest = max((r.created_at for r in rows), default=None)
    return {"count": len(items), "items": items, "totals": totals,
            "computed_at": latest.isoformat() if latest else None}


@router.post("/{cluster_id}/efficiency/recommendations/generate")
def generate_recommendations(cluster_id: UUID, request: Request, db: Session = Depends(get_db),
                             actor: User = Depends(require_operator)):
    _require_cluster(cluster_id, db)
    run = create_run(db, cluster_id, "recommend", trigger="manual", triggered_by=actor.username,
                     step_plan=[{"id": "recommend", "label": "추천 생성"}])
    task_id = _enqueue("run_k8s_efficiency_recommend", run.id)
    audit_logger.record(db, action="k8s.efficiency.recommend", actor=actor, status="success", target_type="cluster",
                        target_id=str(cluster_id), details={"run_id": str(run.id)}, request=request)
    return {"run_id": str(run.id), "task_id": task_id}


@router.post("/{cluster_id}/efficiency/recommendations/{rec_id}/dismiss")
def dismiss_recommendation(cluster_id: UUID, rec_id: UUID, request: Request, db: Session = Depends(get_db),
                           actor: User = Depends(require_operator)):
    r = (db.query(K8sRightsizeRecommendation)
         .filter(K8sRightsizeRecommendation.id == rec_id, K8sRightsizeRecommendation.cluster_id == cluster_id).first())
    if r is None:
        raise HTTPException(status_code=404, detail="recommendation not found")
    r.status = "dismissed"
    r.dismissed_by = actor.username
    r.updated_at = datetime.utcnow()
    db.commit()
    audit_logger.record(db, action="k8s.efficiency.dismiss", actor=actor, status="success", target_type="k8s",
                        target_id=f"{r.kind}/{r.namespace}/{r.name}", details={"container": r.container, "resource": r.resource},
                        request=request)
    return _rec_dict(r)


@router.post("/{cluster_id}/efficiency/apply")
def apply_recommendations(cluster_id: UUID, payload: ApplyBody, request: Request, db: Session = Depends(get_db),
                          actor: User = Depends(require_operator)):
    _require_cluster(cluster_id, db)
    ids = []
    for s in payload.recommendation_ids:
        try:
            ids.append(UUID(str(s)))
        except ValueError:
            raise HTTPException(status_code=422, detail=f"잘못된 추천 id: {s}")
    recs = (db.query(K8sRightsizeRecommendation)
            .filter(K8sRightsizeRecommendation.cluster_id == cluster_id, K8sRightsizeRecommendation.id.in_(ids)).all())
    if len(recs) != len(set(ids)):
        raise HTTPException(status_code=404, detail="일부 추천을 찾을 수 없습니다.")
    blocked = [r for r in recs if r.recommend_only]
    if blocked:
        b = blocked[0]
        raise HTTPException(status_code=422, detail=(
            f"오퍼레이터 관리 워크로드는 직접 적용할 수 없습니다: {b.kind}/{b.namespace}/{b.name} — {b.hint or 'CR spec 에서 조정하세요'}"))
    not_open = [r for r in recs if r.status != "open"]
    if not_open:
        raise HTTPException(status_code=422, detail=f"open 상태가 아닌 추천이 포함됨({not_open[0].status}).")
    targets = targets_from_recommendations(recs)
    run = create_run(db, cluster_id, "rightsize_apply", trigger="manual", triggered_by=actor.username,
                     dry_run=payload.dry_run, targets=targets)
    task_id = _enqueue("run_k8s_efficiency_run", run.id)
    run.celery_task_id = task_id
    db.commit()
    audit_logger.record(db, action="k8s.efficiency.apply", actor=actor, status="success", target_type="cluster",
                        target_id=str(cluster_id), details={"run_id": str(run.id), "dry_run": payload.dry_run,
                                                            "targets": len(targets)}, request=request)
    return {"run_id": str(run.id), "task_id": task_id, "targets": targets}


@router.post("/{cluster_id}/efficiency/quota/adjust")
def quota_adjust(cluster_id: UUID, payload: QuotaAdjustBody, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_operator)):
    _require_cluster(cluster_id, db)
    if payload.cpu_m is None and payload.mem_b is None:
        raise HTTPException(status_code=422, detail="cpu_m 또는 mem_b 중 하나는 필요합니다.")
    policy = (db.query(K8sNamespacePolicy)
              .filter(K8sNamespacePolicy.cluster_id == cluster_id, K8sNamespacePolicy.namespace == payload.namespace).first())
    quota_name = policy.quota_name if policy and policy.quota_name else None
    if not quota_name:
        samples = _hist.ns_samples_window(db, cluster_id, payload.namespace, hours=48)
        quota_name = next((s.quota_name for s in samples if s.quota_name), None)
    if not quota_name:
        raise HTTPException(status_code=422, detail="이 네임스페이스의 ResourceQuota 를 찾을 수 없습니다(정책에 quota_name 지정).")
    hard: dict[str, str] = {}
    if payload.cpu_m is not None:
        hard["requests.cpu"] = fmt_cpu_q(payload.cpu_m)
    if payload.mem_b is not None:
        hard["requests.memory"] = fmt_mem_q(payload.mem_b)
    run = create_run(db, cluster_id, "quota_adjust", trigger="manual", triggered_by=actor.username, dry_run=payload.dry_run,
                     targets=[{"type": "resourcequota", "namespace": payload.namespace, "name": quota_name, "hard": hard}])
    task_id = _enqueue("run_k8s_efficiency_run", run.id)
    audit_logger.record(db, action="k8s.efficiency.quota", actor=actor, status="success", target_type="k8s",
                        target_id=f"ResourceQuota/{payload.namespace}/{quota_name}",
                        details={"run_id": str(run.id), "hard": hard, "dry_run": payload.dry_run}, request=request)
    return {"run_id": str(run.id), "task_id": task_id}


@router.post("/{cluster_id}/efficiency/custom-targets/scale")
def custom_scale(cluster_id: UUID, payload: CustomScaleBody, request: Request, db: Session = Depends(get_db),
                 actor: User = Depends(require_operator)):
    _require_cluster(cluster_id, db)
    policy = (db.query(K8sNamespacePolicy)
              .filter(K8sNamespacePolicy.cluster_id == cluster_id, K8sNamespacePolicy.namespace == payload.namespace).first())
    targets = (policy.custom_targets or []) if policy else []
    if payload.target_index >= len(targets):
        raise HTTPException(status_code=404, detail="custom target 이 없습니다(정책에서 먼저 등록).")
    t = targets[payload.target_index]
    lo, hi = int(t.get("min") or 0), int(t.get("max") or 10 ** 9)
    if not (lo <= payload.value <= hi):
        raise HTTPException(status_code=422, detail=f"값 {payload.value} 이(가) 허용 범위 [{lo}, {hi}] 밖입니다.")
    run = create_run(db, cluster_id, "custom_scale", trigger="manual", triggered_by=actor.username, dry_run=payload.dry_run,
                     targets=[{"type": "custom_resource", "namespace": payload.namespace, "group": t["group"],
                               "version": t["version"], "plural": t["plural"], "name": t["name"],
                               "jsonpath": t.get("jsonpath") or "spec.replicas", "value": payload.value,
                               "policy_target_index": payload.target_index}])
    task_id = _enqueue("run_k8s_efficiency_run", run.id)
    audit_logger.record(db, action="k8s.efficiency.scale", actor=actor, status="success", target_type="k8s",
                        target_id=f"{t.get('plural')}/{payload.namespace}/{t.get('name')}",
                        details={"run_id": str(run.id), "value": payload.value, "dry_run": payload.dry_run}, request=request)
    return {"run_id": str(run.id), "task_id": task_id}


# ── NS 정책 ────────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/efficiency/policies")
def list_policies(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    _require_cluster(cluster_id, db)
    rows = (db.query(K8sNamespacePolicy).filter(K8sNamespacePolicy.cluster_id == cluster_id)
            .order_by(K8sNamespacePolicy.namespace).all())
    return {"count": len(rows), "items": [_policy_dict(p) for p in rows]}


@router.put("/{cluster_id}/efficiency/policies/{namespace}")
def put_policy(cluster_id: UUID, namespace: str, payload: NamespacePolicyBody, request: Request,
               db: Session = Depends(get_db), actor: User = Depends(require_operator)):
    _require_cluster(cluster_id, db)
    if payload.quota_cpu_min_m is not None and payload.quota_cpu_max_m is not None and payload.quota_cpu_min_m > payload.quota_cpu_max_m:
        raise HTTPException(status_code=422, detail="quota CPU min 이 max 보다 큽니다.")
    if payload.quota_mem_min_b is not None and payload.quota_mem_max_b is not None and payload.quota_mem_min_b > payload.quota_mem_max_b:
        raise HTTPException(status_code=422, detail="quota MEM min 이 max 보다 큽니다.")
    p = (db.query(K8sNamespacePolicy)
         .filter(K8sNamespacePolicy.cluster_id == cluster_id, K8sNamespacePolicy.namespace == namespace).first())
    if p is None:
        p = K8sNamespacePolicy(cluster_id=cluster_id, namespace=namespace)
        db.add(p)
    p.auto_rightsize = payload.auto_rightsize
    p.quota_elastic = payload.quota_elastic
    p.quota_name = payload.quota_name
    p.quota_cpu_min_m, p.quota_cpu_max_m = payload.quota_cpu_min_m, payload.quota_cpu_max_m
    p.quota_mem_min_b, p.quota_mem_max_b = payload.quota_mem_min_b, payload.quota_mem_max_b
    p.rightsize_params = payload.rightsize_params or None
    p.quota_params = payload.quota_params or None
    p.custom_targets = [t.model_dump() for t in (payload.custom_targets or [])] or None
    p.updated_by = actor.username
    p.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(p)
    audit_logger.record(db, action="k8s.efficiency.policy.update", actor=actor, status="success", target_type="k8s",
                        target_id=f"Namespace/{namespace}", details=payload.model_dump(exclude_none=True), request=request)
    return _policy_dict(p)


@router.delete("/{cluster_id}/efficiency/policies/{namespace}", status_code=204)
def delete_policy(cluster_id: UUID, namespace: str, request: Request, db: Session = Depends(get_db),
                  actor: User = Depends(require_operator)):
    p = (db.query(K8sNamespacePolicy)
         .filter(K8sNamespacePolicy.cluster_id == cluster_id, K8sNamespacePolicy.namespace == namespace).first())
    if p is None:
        raise HTTPException(status_code=404, detail="policy not found")
    db.delete(p)
    db.commit()
    audit_logger.record(db, action="k8s.efficiency.policy.delete", actor=actor, status="success", target_type="k8s",
                        target_id=f"Namespace/{namespace}", details=None, request=request)
    return None
