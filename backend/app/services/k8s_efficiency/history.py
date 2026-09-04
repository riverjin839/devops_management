"""이력 조회 — NS 시계열 · 저효율 랭킹 추이 · 최신 워크로드 샘플 · 워크로드 백분위(SQL)."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sNamespaceSample, K8sWorkloadSample

# range → (기간, 버킷 초)
RANGES: dict[str, tuple[timedelta, int]] = {
    "24h": (timedelta(hours=24), 600),
    "7d": (timedelta(days=7), 3600),
    "30d": (timedelta(days=30), 6 * 3600),
}


def _range(range_key: str) -> tuple[datetime, int]:
    span, step = RANGES.get(range_key, RANGES["7d"])
    return datetime.utcnow() - span, step


def ns_series(db: Session, cluster_id, namespace: str, range_key: str) -> dict[str, Any]:
    since, step = _range(range_key)
    sql = text("""
        SELECT (floor(extract(epoch FROM sampled_at) / :step) * :step) AS t,
               avg(cpu_req_m) AS cpu_req, avg(cpu_use_m) AS cpu_use, avg(quota_hard_cpu_m) AS cpu_quota,
               avg(quota_used_cpu_m) AS cpu_quota_used,
               avg(mem_req_b) AS mem_req, avg(mem_use_b) AS mem_use, avg(quota_hard_mem_b) AS mem_quota,
               avg(quota_used_mem_b) AS mem_quota_used,
               avg(pod_count) AS pods, count(*) AS n
        FROM k8s_ns_samples
        WHERE cluster_id = :cid AND namespace = :ns AND sampled_at >= :since
        GROUP BY 1 ORDER BY 1
    """)
    rows = db.execute(sql, {"step": step, "cid": str(cluster_id), "ns": namespace, "since": since}).mappings().all()

    def f(v):
        return None if v is None else int(round(float(v)))
    points = [{
        "t": int(r["t"]), "cpu_req": f(r["cpu_req"]), "cpu_use": f(r["cpu_use"]), "cpu_quota": f(r["cpu_quota"]),
        "cpu_quota_used": f(r["cpu_quota_used"]), "mem_req": f(r["mem_req"]), "mem_use": f(r["mem_use"]),
        "mem_quota": f(r["mem_quota"]), "mem_quota_used": f(r["mem_quota_used"]), "pods": f(r["pods"]), "n": int(r["n"]),
    } for r in rows]
    return {"namespace": namespace, "range": range_key, "step": step, "points": points}


def ranking_over_time(db: Session, cluster_id, range_key: str, metric: str = "cpu", top: int = 10,
                      min_req: int = 0) -> dict[str, Any]:
    """저효율(use/req 낮은) NS 상위 N 의 버킷별 효율 시계열 + 기간 평균."""
    since, step = _range(range_key)
    use_col, req_col = ("cpu_use_m", "cpu_req_m") if metric == "cpu" else ("mem_use_b", "mem_req_b")
    sql = text(f"""
        SELECT namespace, (floor(extract(epoch FROM sampled_at) / :step) * :step) AS t,
               avg({req_col}) AS req, avg({use_col}) AS use
        FROM k8s_ns_samples
        WHERE cluster_id = :cid AND sampled_at >= :since AND {use_col} IS NOT NULL
        GROUP BY namespace, 2
    """)
    rows = db.execute(sql, {"step": step, "cid": str(cluster_id), "since": since}).mappings().all()
    by_ns: dict[str, list[tuple[int, float, float]]] = {}
    for r in rows:
        by_ns.setdefault(r["namespace"], []).append((int(r["t"]), float(r["req"] or 0), float(r["use"] or 0)))
    ranked = []
    for ns, pts in by_ns.items():
        req_avg = sum(p[1] for p in pts) / len(pts)
        use_avg = sum(p[2] for p in pts) / len(pts)
        if req_avg <= max(0, min_req):
            continue
        eff = use_avg / req_avg if req_avg > 0 else None
        # 추세: 전반 평균 효율 vs 후반 평균 효율
        pts.sort()
        half = max(1, len(pts) // 2)
        def _eff(ps):
            r = sum(p[1] for p in ps); u = sum(p[2] for p in ps)
            return (u / r) if r > 0 else None
        if len(pts) > 1:
            e1, e2 = _eff(pts[:half]), _eff(pts[half:])
        else:
            e1, e2 = None, None
        trend = None if (e1 is None or e2 is None) else ("up" if e2 > e1 + 0.02 else "down" if e2 < e1 - 0.02 else "flat")
        ranked.append({
            "namespace": ns, "avg_efficiency": eff, "avg_req": int(round(req_avg)), "avg_use": int(round(use_avg)),
            "avg_slack": int(round(max(0.0, req_avg - use_avg))), "trend": trend,
            "points": [{"t": t, "eff": (u / r if r > 0 else None)} for t, r, u in pts],
        })
    ranked.sort(key=lambda x: (x["avg_efficiency"] if x["avg_efficiency"] is not None else 9e9))
    return {"range": range_key, "metric": metric, "step": step, "items": ranked[:top], "total": len(ranked)}


def latest_workload_samples(db: Session, cluster_id, namespace: Optional[str] = None,
                            max_age: timedelta = timedelta(days=2)) -> list[K8sWorkloadSample]:
    """워크로드별 최신 샘플(DISTINCT ON). max_age 보다 오래된(=사라진) 워크로드는 제외."""
    since = datetime.utcnow() - max_age
    q = (db.query(K8sWorkloadSample)
         .filter(K8sWorkloadSample.cluster_id == cluster_id, K8sWorkloadSample.sampled_at >= since))
    if namespace:
        q = q.filter(K8sWorkloadSample.namespace == namespace)
    q = q.distinct(K8sWorkloadSample.namespace, K8sWorkloadSample.kind, K8sWorkloadSample.name).order_by(
        K8sWorkloadSample.namespace, K8sWorkloadSample.kind, K8sWorkloadSample.name,
        K8sWorkloadSample.sampled_at.desc())
    return q.all()


def latest_ns_samples(db: Session, cluster_id, max_age: timedelta = timedelta(days=2)) -> list[K8sNamespaceSample]:
    since = datetime.utcnow() - max_age
    return (db.query(K8sNamespaceSample)
            .filter(K8sNamespaceSample.cluster_id == cluster_id, K8sNamespaceSample.sampled_at >= since)
            .distinct(K8sNamespaceSample.namespace)
            .order_by(K8sNamespaceSample.namespace, K8sNamespaceSample.sampled_at.desc()).all())


def ns_samples_window(db: Session, cluster_id, namespace: str, hours: float) -> list[K8sNamespaceSample]:
    since = datetime.utcnow() - timedelta(hours=hours)
    return (db.query(K8sNamespaceSample)
            .filter(K8sNamespaceSample.cluster_id == cluster_id, K8sNamespaceSample.namespace == namespace,
                    K8sNamespaceSample.sampled_at >= since)
            .order_by(K8sNamespaceSample.sampled_at.desc()).all())


def workload_percentiles(db: Session, cluster_id, window_days: int, percentile: int
                         ) -> dict[tuple[str, str, str, str], dict[str, Any]]:
    """{(ns,kind,name,container): {p_cpu, p_mem, n, first, last}} — DB 샘플 기반 백분위(단일 SQL)."""
    since = datetime.utcnow() - timedelta(days=window_days)
    q = max(0.5, min(0.999, percentile / 100.0))
    sql = text("""
        SELECT s.namespace, s.kind, s.name, c.key AS container,
               percentile_cont(:q) WITHIN GROUP (ORDER BY NULLIF(c.value->>'uc_max','')::bigint) AS p_cpu,
               percentile_cont(:q) WITHIN GROUP (ORDER BY NULLIF(c.value->>'um_max','')::bigint) AS p_mem,
               count(NULLIF(c.value->>'uc_max','')) AS n,
               min(s.sampled_at) AS first_at, max(s.sampled_at) AS last_at
        FROM k8s_workload_samples s, jsonb_each(s.containers) c
        WHERE s.cluster_id = :cid AND s.sampled_at >= :since
        GROUP BY s.namespace, s.kind, s.name, c.key
    """)
    rows = db.execute(sql, {"q": q, "cid": str(cluster_id), "since": since}).mappings().all()
    out: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for r in rows:
        out[(r["namespace"], r["kind"], r["name"], r["container"])] = {
            "p_cpu": None if r["p_cpu"] is None else int(round(float(r["p_cpu"]))),
            "p_mem": None if r["p_mem"] is None else int(round(float(r["p_mem"]))),
            "n": int(r["n"] or 0), "first": r["first_at"], "last": r["last_at"],
        }
    return out
