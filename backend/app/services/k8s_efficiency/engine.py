"""추천 엔진 — 컨테이너 request 축소 추천.

규칙(정책 기본값 + NS 오버라이드):
  target = max(p95 × (1 + headroom_pct/100), floor)
  current > target × threshold_ratio 이고 (current − target) ≥ min_savings 일 때만 추천
제외: 시스템 NS · opt-out annotation(NS/워크로드) · DaemonSet(옵션) · 데이터 부족.
오퍼레이터(CR) 관리 워크로드는 `recommend_only=True`(적용 거부, CR 에서 조정하라는 힌트).

p95 소스: Prometheus(quantile_over_time) → DB 샘플(percentile_cont) → 부족(usage_source="insufficient").
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sNamespacePolicy, K8sRightsizeRecommendation, K8sWorkloadSample

from . import history as _hist
from . import prometheus as _prom

logger = logging.getLogger(__name__)

_RS_OVERRIDE_KEYS = ("percentile", "headroom_pct", "floor_cpu_m", "floor_mem_b", "threshold_ratio",
                     "min_savings_cpu_m", "min_savings_mem_b", "include_daemonsets", "keep_guaranteed",
                     "cooldown_minutes", "max_step_pct", "window_days")


def merge_policy(defaults: dict[str, Any], ns_policy: Optional[K8sNamespacePolicy]) -> dict[str, Any]:
    out = dict(defaults)
    if ns_policy is not None and isinstance(ns_policy.rightsize_params, dict):
        for k in _RS_OVERRIDE_KEYS:
            v = ns_policy.rightsize_params.get(k)
            if v is not None:
                out[k] = v
    return out


def recommend_target(current: int, p95: Optional[int], *, headroom_pct: float, floor: int,
                     threshold_ratio: float, min_savings: int) -> Optional[int]:
    """추천 target(파드당). 추천 조건 미달이면 None."""
    if p95 is None or current <= 0:
        return None
    target = max(int(round(p95 * (1 + headroom_pct / 100.0))), int(floor))
    if current <= target * threshold_ratio:
        return None
    if current - target < min_savings:
        return None
    return target


def exclusion_reason(sample: K8sWorkloadSample, policy: dict[str, Any]) -> Optional[str]:
    if sample.namespace in set(policy.get("system_namespaces") or []):
        return "system_namespace"
    if sample.optout:
        return "opt_out_annotation"
    if sample.kind == "DaemonSet" and not policy.get("include_daemonsets"):
        return "daemonset_excluded"
    if sample.kind not in ("Deployment", "StatefulSet", "DaemonSet"):
        return "unsupported_kind"
    return None


def _prom_p95_by_container(cluster, samples: list[K8sWorkloadSample], window_days: int, percentile: int,
                           log: Callable[[str], None]) -> Optional[dict[tuple[str, str, str, str], dict]]:
    """Prometheus 컨테이너 p95 → 워크로드/컨테이너로 귀속(파드 중 최대값 = 보수적)."""
    pod_p95, err = _prom.fetch_p95_usage(cluster, window_days=window_days, percentile=percentile)
    if not pod_p95:
        log(f"Prometheus p95 조회 불가({err}) — DB 샘플 백분위로 폴백")
        return None
    out: dict[tuple[str, str, str, str], dict] = {}
    for s in samples:
        for pod in (s.pods or []):
            for cname in (s.containers or {}):
                v = pod_p95.get((s.namespace, pod, cname))
                if not v:
                    continue
                e = out.setdefault((s.namespace, s.kind, s.name, cname), {"p_cpu": None, "p_mem": None, "n": 0})
                if v.get("cpu_m") is not None:
                    e["p_cpu"] = max(e["p_cpu"] or 0, v["cpu_m"])
                if v.get("mem_b") is not None:
                    e["p_mem"] = max(e["p_mem"] or 0, v["mem_b"])
                e["n"] += 1
    log(f"Prometheus p95 — 컨테이너 {len(out)}건 귀속")
    return out


def generate(db: Session, cluster, defaults: dict[str, Any],
             log: Optional[Callable[[str], None]] = None) -> dict[str, Any]:
    log = log or (lambda s: logger.info("[recommend %s] %s", getattr(cluster, "name", "?"), s))
    samples = _hist.latest_workload_samples(db, cluster.id)
    if not samples:
        log("워크로드 샘플 없음 — 수집이 먼저 필요")
        return {"generated": 0, "superseded": 0, "skipped": {"no_samples": 1}, "usage_source": "insufficient"}
    policies = {p.namespace: p for p in db.query(K8sNamespacePolicy).filter(K8sNamespacePolicy.cluster_id == cluster.id).all()}
    window_days = int(defaults.get("window_days") or 7)
    percentile = int(defaults.get("percentile") or 95)
    usage_pref = (defaults.get("usage_source") or "auto").lower()

    stats: Optional[dict] = None
    source = "insufficient"
    if usage_pref in ("auto", "prometheus"):
        stats = _prom_p95_by_container(cluster, samples, window_days, percentile, log)
        if stats:
            source = "prometheus"
    if stats is None and usage_pref in ("auto", "metrics"):
        stats = _hist.workload_percentiles(db, cluster.id, window_days, percentile)
        if stats:
            source = "metrics"
            log(f"DB 샘플 백분위 — 컨테이너 {len(stats)}건")
    stats = stats or {}

    min_samples = int(defaults.get("min_samples") or 0)
    min_cov = timedelta(hours=float(defaults.get("min_coverage_hours") or 0))
    now = datetime.utcnow()
    new_rows: list[K8sRightsizeRecommendation] = []
    skipped: dict[str, int] = {}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    for s in samples:
        policy = merge_policy(defaults, policies.get(s.namespace))
        ex = exclusion_reason(s, policy)
        if ex:
            skip(ex)
            continue
        managed = s.managed_by if isinstance(s.managed_by, dict) and s.managed_by else None
        for cname, cc in (s.containers or {}).items():
            st = stats.get((s.namespace, s.kind, s.name, cname))
            if not st:
                skip("no_usage_data")
                continue
            if source == "metrics":
                if st.get("n", 0) < min_samples:
                    skip("insufficient_samples")
                    continue
                first, last = st.get("first"), st.get("last")
                if first and last and (last - first) < min_cov:
                    skip("insufficient_coverage")
                    continue
            for res, cur_key, lim_key, p_key, floor_key, sav_key in (
                ("cpu", "rc", "lc", "p_cpu", "floor_cpu_m", "min_savings_cpu_m"),
                ("memory", "rm", "lm", "p_mem", "floor_mem_b", "min_savings_mem_b"),
            ):
                current = int(cc.get(cur_key) or 0)
                if current <= 0:
                    continue  # request 미설정은 축소 대상이 아님(별도 "미설정" 배지)
                target = recommend_target(
                    current, st.get(p_key), headroom_pct=float(policy["headroom_pct"]), floor=int(policy[floor_key]),
                    threshold_ratio=float(policy["threshold_ratio"]), min_savings=int(policy[sav_key]),
                )
                if target is None:
                    continue
                cur_lim = int(cc.get(lim_key) or 0) or None
                target_lim = None
                if cur_lim and cur_lim == current and policy.get("keep_guaranteed", True):
                    target_lim = target   # Guaranteed 유지 — limit 도 같이 내린다
                new_rows.append(K8sRightsizeRecommendation(
                    cluster_id=cluster.id, namespace=s.namespace, kind=s.kind, name=s.name, container=cname,
                    resource=res, pod_count=max(1, s.pod_count), current_req=current, target_req=target,
                    current_lim=cur_lim, target_lim=target_lim, p95_use=st.get(p_key), usage_source=source,
                    samples=int(st.get("n") or 0), window_days=window_days,
                    savings=(current - target) * max(1, s.pod_count),
                    reason={"percentile": percentile, "headroom_pct": policy["headroom_pct"], "floor": policy[floor_key],
                            "threshold_ratio": policy["threshold_ratio"], "window_days": window_days},
                    managed_by=managed, recommend_only=bool(managed),
                    hint=(f"오퍼레이터 관리({managed.get('kind')}/{managed.get('name')}) — CR spec 에서 조정하세요"
                          if managed else None),
                    status="open", created_at=now, updated_at=now,
                ))

    # 기존 open → superseded, 새 추천 삽입(트랜잭션 1회)
    superseded = (db.query(K8sRightsizeRecommendation)
                  .filter(K8sRightsizeRecommendation.cluster_id == cluster.id,
                          K8sRightsizeRecommendation.status == "open")
                  .update({"status": "superseded", "updated_at": now}, synchronize_session=False))
    db.bulk_save_objects(new_rows)
    db.commit()
    log(f"추천 {len(new_rows)}건 생성(이전 open {superseded}건 superseded) · 소스 {source} · 제외 {skipped}")
    return {"generated": len(new_rows), "superseded": superseded, "skipped": skipped, "usage_source": source}
