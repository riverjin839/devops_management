"""자동화 디스패치 — 수집 사이클 끝에 NS 정책(opt-in)을 평가해 apply/quota run 을 만든다.

안전장치: 전역 automation_enabled · NS opt-in · 쿨다운 · 1회 최대 변경폭(max_step_pct) ·
run 당 최대 대상 수 · maintenance_cron(허용 시간대) · recommend_only(오퍼레이터 관리) 제외.
실제 패치는 Celery `run_k8s_efficiency_run` 이 수행하고 실행 로그/감사에 남는다.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sNamespacePolicy, K8sRightsizeRecommendation

from . import history as _hist
from .apply import targets_from_recommendations
from .engine import merge_policy
from .quota import evaluate as quota_evaluate, fmt_cpu_q, fmt_mem_q, merge_quota_params
from .runs import create_run

logger = logging.getLogger(__name__)


def in_maintenance_window(cron: Optional[str], now: Optional[datetime] = None) -> bool:
    """maintenance_cron 이 없으면 항상 허용. 있으면 현재 분이 cron 에 매치할 때만."""
    if not cron:
        return True
    try:
        from croniter import croniter
        return bool(croniter.match(cron, now or datetime.now()))
    except Exception:  # noqa: BLE001
        return False


def capped_target(current: int, target: int, max_step_pct: float) -> int:
    """1회 변경폭 상한 — current 대비 max_step_pct 이상 내리지 않는다."""
    floor_step = int(round(current * (1 - max_step_pct / 100.0)))
    return max(target, floor_step)


def dispatch_auto(db: Session, cluster, defaults: dict[str, Any], *, enqueue: Callable[[Any], None],
                  log: Optional[Callable[[str], None]] = None) -> dict[str, Any]:
    log = log or (lambda s: logger.info("[auto %s] %s", getattr(cluster, "name", "?"), s))
    if not defaults.get("automation_enabled"):
        return {"skipped": "automation_disabled"}
    if not in_maintenance_window(defaults.get("maintenance_cron")):
        return {"skipped": "outside_maintenance_window"}
    now = datetime.utcnow()
    policies = db.query(K8sNamespacePolicy).filter(K8sNamespacePolicy.cluster_id == cluster.id).all()
    created: list[str] = []
    for p in policies:
        # ── 자동 right-size ────────────────────────────────────────────────────
        if p.auto_rightsize:
            pol = merge_policy(defaults, p)
            cd = timedelta(minutes=float(pol.get("cooldown_minutes") or 0))
            if p.last_auto_apply_at and now - p.last_auto_apply_at < cd:
                log(f"{p.namespace}: right-size 쿨다운 중")
            else:
                recs = (db.query(K8sRightsizeRecommendation)
                        .filter(K8sRightsizeRecommendation.cluster_id == cluster.id,
                                K8sRightsizeRecommendation.namespace == p.namespace,
                                K8sRightsizeRecommendation.status == "open",
                                K8sRightsizeRecommendation.recommend_only.is_(False))
                        .order_by(K8sRightsizeRecommendation.savings.desc()).all())
                step_pct = float(pol.get("max_step_pct") or 100)
                for r in recs:
                    r.target_req = capped_target(r.current_req, r.target_req, step_pct)
                    if r.target_lim is not None:
                        r.target_lim = r.target_req
                targets = targets_from_recommendations(recs)[: int(defaults.get("max_targets_per_run") or 20)]
                if targets:
                    run = create_run(db, cluster.id, "rightsize_apply", trigger="auto", triggered_by="automation",
                                     dry_run=False, targets=targets)
                    p.last_auto_apply_at = now
                    db.commit()
                    enqueue(run.id)
                    created.append(str(run.id))
                    log(f"{p.namespace}: 자동 right-size run {run.id} ({len(targets)} 대상)")
        # ── ResourceQuota 탄력 ─────────────────────────────────────────────────
        if p.quota_elastic:
            qp = merge_quota_params(defaults, p.quota_params)
            samples = _hist.ns_samples_window(db, cluster.id, p.namespace, hours=max(float(qp["sustain_hours"]), 1.0) + 1)
            dec = quota_evaluate(p, samples, qp, now)
            if dec.get("skipped"):
                log(f"{p.namespace}: quota 평가 건너뜀({dec['skipped']})")
            else:
                hard: dict[str, str] = {}
                notes = []
                for res, key, fmt in (("cpu", "requests.cpu", fmt_cpu_q), ("memory", "requests.memory", fmt_mem_q)):
                    d = dec.get(res) or {}
                    if d.get("action") in ("raise", "lower"):
                        hard[key] = fmt(d["to"])
                        notes.append(f"{res}: {d['action']} {d['from']}→{d['to']} ({d.get('reason')})")
                if hard:
                    run = create_run(db, cluster.id, "quota_adjust", trigger="auto", triggered_by="automation",
                                     dry_run=False, targets=[{"type": "resourcequota", "namespace": p.namespace,
                                                              "name": p.quota_name or dec["quota_name"], "hard": hard,
                                                              "decision": dec}])
                    p.last_quota_adjust_at = now
                    db.commit()
                    enqueue(run.id)
                    created.append(str(run.id))
                    log(f"{p.namespace}: quota 조정 run {run.id} — {'; '.join(notes)}")
        # ── CR 어댑터(예: StarRocks CN replicas) — NS 사용률 기반 단순 ±1 ───────────
        for idx, t in enumerate(p.custom_targets or []):
            if not t.get("enabled", True):
                continue
            qp = merge_quota_params(defaults, p.quota_params)
            samples = _hist.ns_samples_window(db, cluster.id, p.namespace, hours=max(float(qp["sustain_hours"]), 1.0) + 1)
            if not samples:
                continue
            latest = samples[0]
            if latest.cpu_use_m is None or latest.cpu_req_m <= 0:
                continue
            ratio = latest.cpu_use_m / latest.cpu_req_m
            cur = t.get("current")  # 마지막으로 알고 있는 값(적용 run 이 갱신) — 없으면 건너뜀
            if cur is None:
                continue
            lo, hi = int(t.get("min") or 1), int(t.get("max") or cur)
            new = None
            if ratio >= float(qp["up_threshold"]) and cur < hi:
                new = cur + 1
            elif ratio <= float(qp["low_threshold"]) and cur > lo:
                # 축소는 sustain 창 내내 낮았을 때만
                vals = [s.cpu_use_m / s.cpu_req_m for s in samples if s.cpu_use_m is not None and s.cpu_req_m > 0]
                if vals and max(vals) <= float(qp["low_threshold"]):
                    new = cur - 1
            if new is None:
                continue
            run = create_run(db, cluster.id, "custom_scale", trigger="auto", triggered_by="automation", dry_run=False,
                             targets=[{"type": "custom_resource", "namespace": p.namespace, "group": t["group"],
                                       "version": t["version"], "plural": t["plural"], "name": t["name"],
                                       "jsonpath": t.get("jsonpath") or "spec.replicas", "value": new,
                                       "policy_target_index": idx}])
            enqueue(run.id)
            created.append(str(run.id))
            log(f"{p.namespace}: CR {t.get('plural')}/{t.get('name')} {cur}→{new} run {run.id}")
    return {"runs": created}
