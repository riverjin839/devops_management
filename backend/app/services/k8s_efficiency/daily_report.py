"""일일 리포트 — NS 자원(request/limit/사용량) 일 단위 롤업과 비효율 랭킹.

- 원천은 효율화 수집 워커가 쌓는 `k8s_ns_samples`(기본 10분 주기). 하루치 샘플을 NS 별로 묶어
  `k8s_ns_daily_reports` 에 1행으로 롤업한다 — 과거 날짜 조회는 이 작은 테이블만 읽는다.
- 오늘(진행 중인 날)은 저장하지 않고 매 조회마다 샘플에서 바로 계산한다(partial).
- 과거 날짜에 롤업이 없으면 샘플이 남아 있는 한 조회 시점에 계산해 저장한다(lazy backfill).
- 조회 가능한 과거 범위 = `retention_days`. 그보다 오래된 롤업은 매일 롤업 태스크가 지운다 —
  데이터 양/조회 부하를 운영자가 화면에서 조절하는 손잡이(UI-First, AppSetting `daily_report.settings`).
- 날짜 경계는 `settings.batch_jobs_timezone`(기본 Asia/Seoul) 자정 기준. 샘플은 UTC naive 저장.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sNsDailyReport

log = logging.getLogger(__name__)

SETTINGS_KEY = "daily_report.settings"

DEFAULTS: dict[str, Any] = {
    # 비인증 공개 페이지 노출 여부 — false 면 공개 API 가 404 를 돌려준다.
    "public_enabled": True,
    # 조회·보관 가능한 과거 일수(오늘 포함 X). 늘릴수록 롤업 행이 늘어난다(1~400).
    "retention_days": 30,
    # 랭킹 표시 개수(1~50).
    "top_n": 10,
    # 랭킹 노이즈 컷 — 당일 평균 request 가 이 값 미만인 NS 는 랭킹에서 뺀다.
    "min_cpu_req_m": 100,
    "min_mem_req_b": 256 * 1024 ** 2,
    # 효율화 정책 기본값의 system_namespaces 를 랭킹에서 제외.
    "exclude_system_namespaces": True,
    # 공개 대상 클러스터 id 목록. 비어 있으면 테넌트 바인딩이 없는 클러스터 전체.
    "public_cluster_ids": [],
}

RANK_KEYS = ("cpu_rate", "mem_rate", "cpu_slack", "mem_slack")


# ── 설정 ───────────────────────────────────────────────────────────────────────
def _row(db: Session):
    from app.models.app_setting import AppSetting
    return db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()


def _clamp_int(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def normalize(values: dict[str, Any]) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for k, v in (values or {}).items():
        if k in DEFAULTS and v is not None:
            out[k] = v
    out["public_enabled"] = bool(out["public_enabled"])
    out["exclude_system_namespaces"] = bool(out["exclude_system_namespaces"])
    out["retention_days"] = _clamp_int(out["retention_days"], 1, 400, DEFAULTS["retention_days"])
    out["top_n"] = _clamp_int(out["top_n"], 1, 50, DEFAULTS["top_n"])
    out["min_cpu_req_m"] = _clamp_int(out["min_cpu_req_m"], 0, 10 ** 9, DEFAULTS["min_cpu_req_m"])
    out["min_mem_req_b"] = _clamp_int(out["min_mem_req_b"], 0, 10 ** 15, DEFAULTS["min_mem_req_b"])
    ids = out.get("public_cluster_ids") or []
    out["public_cluster_ids"] = [str(i) for i in ids if str(i).strip()] if isinstance(ids, list) else []
    return out


def get_settings(db: Session) -> dict[str, Any]:
    row = _row(db)
    return normalize(row.value if row and isinstance(row.value, dict) else {})


def set_settings(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    merged = normalize({**get_settings(db), **{k: v for k, v in (values or {}).items() if k in DEFAULTS}})
    row = _row(db)
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return merged


# ── 날짜 경계 ──────────────────────────────────────────────────────────────────
def report_tz() -> ZoneInfo:
    from app.config import settings
    try:
        return ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return ZoneInfo("Asia/Seoul")


def today_local(now: Optional[datetime] = None) -> date:
    now = now or datetime.now(timezone.utc)
    return now.astimezone(report_tz()).date()


def day_window_utc(day: date) -> tuple[datetime, datetime]:
    """현지 day 00:00 ~ 익일 00:00 을 UTC naive 로(샘플 sampled_at 과 같은 기준)."""
    tz = report_tz()
    start = datetime.combine(day, time.min, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
    return start, end


# ── 집계 ───────────────────────────────────────────────────────────────────────
_AGG_SQL = text("""
    SELECT namespace,
           count(*) AS samples,
           count(cpu_use_m) AS usage_samples,
           avg(pod_count) AS pod_avg,
           avg(cpu_req_m) AS cpu_req, avg(cpu_lim_m) AS cpu_lim,
           avg(mem_req_b) AS mem_req, avg(mem_lim_b) AS mem_lim,
           avg(cpu_use_m) AS cpu_use_avg, min(cpu_use_m) AS cpu_use_min, max(cpu_use_m) AS cpu_use_max,
           avg(mem_use_b) AS mem_use_avg, min(mem_use_b) AS mem_use_min, max(mem_use_b) AS mem_use_max,
           avg(cpu_use_m::float / NULLIF(cpu_req_m, 0)) AS cpu_rate_avg,
           min(cpu_use_m::float / NULLIF(cpu_req_m, 0)) AS cpu_rate_min,
           max(cpu_use_m::float / NULLIF(cpu_req_m, 0)) AS cpu_rate_max,
           avg(mem_use_b::float / NULLIF(mem_req_b, 0)) AS mem_rate_avg,
           min(mem_use_b::float / NULLIF(mem_req_b, 0)) AS mem_rate_min,
           max(mem_use_b::float / NULLIF(mem_req_b, 0)) AS mem_rate_max
    FROM k8s_ns_samples
    WHERE cluster_id = :cid AND sampled_at >= :start AND sampled_at < :end
    GROUP BY namespace
""")


def _i(v) -> Optional[int]:
    return None if v is None else int(round(float(v)))


def _f(v) -> Optional[float]:
    return None if v is None else float(v)


def aggregate_day(db: Session, cluster_id, day: date) -> list[dict[str, Any]]:
    """원본 샘플에서 하루치 NS 집계(저장하지 않음)."""
    start, end = day_window_utc(day)
    rows = db.execute(_AGG_SQL, {"cid": str(cluster_id), "start": start, "end": end}).mappings().all()
    return [{
        "namespace": r["namespace"],
        "samples": int(r["samples"] or 0),
        "usage_samples": int(r["usage_samples"] or 0),
        "pod_avg": _f(r["pod_avg"]),
        "cpu_req_m": _i(r["cpu_req"]) or 0, "cpu_lim_m": _i(r["cpu_lim"]) or 0,
        "mem_req_b": _i(r["mem_req"]) or 0, "mem_lim_b": _i(r["mem_lim"]) or 0,
        "cpu_use_avg_m": _i(r["cpu_use_avg"]), "cpu_use_min_m": _i(r["cpu_use_min"]),
        "cpu_use_max_m": _i(r["cpu_use_max"]),
        "mem_use_avg_b": _i(r["mem_use_avg"]), "mem_use_min_b": _i(r["mem_use_min"]),
        "mem_use_max_b": _i(r["mem_use_max"]),
        "cpu_rate_avg": _f(r["cpu_rate_avg"]), "cpu_rate_min": _f(r["cpu_rate_min"]),
        "cpu_rate_max": _f(r["cpu_rate_max"]),
        "mem_rate_avg": _f(r["mem_rate_avg"]), "mem_rate_min": _f(r["mem_rate_min"]),
        "mem_rate_max": _f(r["mem_rate_max"]),
        "gpu_req": None, "gpu_lim": None,
    } for r in rows]


_ROW_FIELDS = (
    "samples", "usage_samples", "pod_avg", "cpu_req_m", "cpu_lim_m", "mem_req_b", "mem_lim_b",
    "cpu_use_avg_m", "cpu_use_min_m", "cpu_use_max_m", "mem_use_avg_b", "mem_use_min_b", "mem_use_max_b",
    "cpu_rate_avg", "cpu_rate_min", "cpu_rate_max", "mem_rate_avg", "mem_rate_min", "mem_rate_max",
    "gpu_req", "gpu_lim",
)


def build_day(db: Session, cluster_id, day: date) -> list[dict[str, Any]]:
    """하루치 롤업을 계산해 (cluster, day) 단위로 교체 저장. 샘플이 없으면 아무것도 쓰지 않는다."""
    rows = aggregate_day(db, cluster_id, day)
    if not rows:
        return rows
    db.query(K8sNsDailyReport).filter(
        K8sNsDailyReport.cluster_id == cluster_id, K8sNsDailyReport.report_date == day,
    ).delete(synchronize_session=False)
    now = datetime.utcnow()
    for r in rows:
        db.add(K8sNsDailyReport(cluster_id=cluster_id, report_date=day, namespace=r["namespace"],
                                computed_at=now, **{k: r[k] for k in _ROW_FIELDS}))
    db.commit()
    return rows


def _stored(db: Session, cluster_id, day: date) -> tuple[list[dict[str, Any]], Optional[datetime]]:
    recs = db.query(K8sNsDailyReport).filter(
        K8sNsDailyReport.cluster_id == cluster_id, K8sNsDailyReport.report_date == day,
    ).all()
    rows = [{"namespace": r.namespace, **{k: getattr(r, k) for k in _ROW_FIELDS}} for r in recs]
    computed = max((r.computed_at for r in recs), default=None)
    return rows, computed


def purge_old(db: Session, retention_days: int) -> int:
    cutoff = today_local() - timedelta(days=retention_days)
    n = db.query(K8sNsDailyReport).filter(K8sNsDailyReport.report_date < cutoff).delete(synchronize_session=False)
    db.commit()
    return int(n or 0)


# ── 리포트 ─────────────────────────────────────────────────────────────────────
def _system_namespaces(db: Session) -> set[str]:
    from app.services.k8s_efficiency import settings as effcfg
    return set(effcfg.get_policy_defaults(db).get("system_namespaces") or [])


def _item(r: dict[str, Any]) -> dict[str, Any]:
    def slack(req, use):
        return None if use is None else max(0, int(req) - int(use))
    return {
        "namespace": r["namespace"],
        "samples": r["samples"], "usage_samples": r["usage_samples"],
        "pods": None if r["pod_avg"] is None else round(float(r["pod_avg"]), 1),
        "cpu": {
            "req": r["cpu_req_m"], "lim": r["cpu_lim_m"],
            "use_avg": r["cpu_use_avg_m"], "use_min": r["cpu_use_min_m"], "use_max": r["cpu_use_max_m"],
            "rate_avg": r["cpu_rate_avg"], "rate_min": r["cpu_rate_min"], "rate_max": r["cpu_rate_max"],
            "slack": slack(r["cpu_req_m"], r["cpu_use_avg_m"]),
        },
        "mem": {
            "req": r["mem_req_b"], "lim": r["mem_lim_b"],
            "use_avg": r["mem_use_avg_b"], "use_min": r["mem_use_min_b"], "use_max": r["mem_use_max_b"],
            "rate_avg": r["mem_rate_avg"], "rate_min": r["mem_rate_min"], "rate_max": r["mem_rate_max"],
            "slack": slack(r["mem_req_b"], r["mem_use_avg_b"]),
        },
        "gpu": {"req": r.get("gpu_req"), "lim": r.get("gpu_lim")},
    }


def rank(items: list[dict[str, Any]], rank_by: str, cfg: dict[str, Any], system_ns: set[str]
         ) -> tuple[list[dict[str, Any]], int]:
    """비효율 랭킹 — rate 는 사용률 오름차순, slack 은 (request - 평균 사용량) 내림차순."""
    res, metric = rank_by.split("_", 1)
    min_req = cfg["min_cpu_req_m"] if res == "cpu" else cfg["min_mem_req_b"]
    cand = [it for it in items
            if it[res]["use_avg"] is not None and it[res]["req"] > 0 and it[res]["req"] >= min_req
            and not (cfg["exclude_system_namespaces"] and it["namespace"] in system_ns)]
    if metric == "rate":
        cand.sort(key=lambda it: (it[res]["rate_avg"] if it[res]["rate_avg"] is not None else 9e9,
                                  -it[res]["req"]))
    else:
        cand.sort(key=lambda it: -(it[res]["slack"] or 0))
    return cand, len(cand)


def _day_rows(db: Session, cluster, day: date) -> tuple[list[dict[str, Any]], str, Optional[datetime]]:
    """(rows, source, computed_at) — 오늘은 실시간 집계, 지난 날짜는 롤업(없으면 계산·저장)."""
    if day == today_local():
        return aggregate_day(db, cluster.id, day), "live", None
    rows, computed_at = _stored(db, cluster.id, day)
    if rows:
        return rows, "rollup", computed_at
    rows = build_day(db, cluster.id, day)
    return rows, ("backfill" if rows else "none"), (datetime.utcnow() if rows else None)


def build_report(db: Session, cluster, day: date, rank_by: str = "cpu_rate") -> dict[str, Any]:
    cfg = get_settings(db)
    if rank_by not in RANK_KEYS:
        rank_by = "cpu_rate"
    today = today_local()
    is_today = day == today
    rows, source, computed_at = _day_rows(db, cluster, day)

    items = [_item(r) for r in rows]
    ranked, total = rank(items, rank_by, cfg, _system_namespaces(db))
    top = [{"rank": i + 1, **it} for i, it in enumerate(ranked[: cfg["top_n"]])]

    def s(res, key):
        vals = [it[res][key] for it in items if it[res][key] is not None]
        return sum(vals) if vals else None

    summary = {
        "namespaces": len(items),
        "pods": round(sum(it["pods"] or 0 for it in items), 1) if items else 0,
        "samples": max((it["samples"] for it in items), default=0),
        "cpu": {"req": s("cpu", "req") or 0, "lim": s("cpu", "lim") or 0, "use_avg": s("cpu", "use_avg")},
        "mem": {"req": s("mem", "req") or 0, "lim": s("mem", "lim") or 0, "use_avg": s("mem", "use_avg")},
    }
    for res in ("cpu", "mem"):
        req, use = summary[res]["req"], summary[res]["use_avg"]
        summary[res]["rate_avg"] = (use / req) if (use is not None and req) else None

    start, end = day_window_utc(day)
    return {
        "cluster": {"id": str(cluster.id), "name": cluster.name},
        "date": day.isoformat(),
        "timezone": str(report_tz()),
        "window_utc": {"start": start.isoformat(), "end": end.isoformat()},
        "is_today": is_today,
        "source": source,   # live | rollup | backfill | none(샘플 없음)
        "computed_at": computed_at.isoformat() if computed_at else None,
        "min_date": (today - timedelta(days=cfg["retention_days"])).isoformat(),
        "max_date": today.isoformat(),
        "rank_by": rank_by,
        "top_n": cfg["top_n"],
        "ranked_total": total,
        "no_usage_namespaces": sum(1 for it in items if it["usage_samples"] == 0),
        "thresholds": {"min_cpu_req_m": cfg["min_cpu_req_m"], "min_mem_req_b": cfg["min_mem_req_b"],
                       "exclude_system_namespaces": cfg["exclude_system_namespaces"]},
        "summary": summary,
        "items": top,
    }


# ── 검색(본인 업무 모듈 찾기) ─────────────────────────────────────────────────────
SEARCH_LIMIT = 50
_WL_SEARCH_SQL = text("""
    SELECT s.namespace, s.kind, s.name,
           array_remove(array_agg(DISTINCT p.pod) FILTER (WHERE position(:q IN lower(p.pod)) > 0), NULL) AS pods
    FROM k8s_workload_samples s
    LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(s.pods, '[]'::jsonb)) AS p(pod) ON true
    WHERE s.cluster_id = :cid AND s.sampled_at >= :start AND s.sampled_at < :end
    GROUP BY s.namespace, s.kind, s.name
    HAVING position(:q IN lower(s.name)) > 0 OR bool_or(position(:q IN lower(p.pod)) > 0)
    LIMIT 500
""")


def search_report(db: Session, cluster, day: date, q: str, rank_by: str = "cpu_rate") -> dict[str, Any]:
    """네임스페이스 이름 또는 워크로드/파드 이름(부분 일치, 대소문자 무시)으로 당일 NS 를 찾는다.

    TOP N 밖의 NS 도 찾을 수 있게 당일 전체 NS 를 대상으로 하고, 각 결과에 비효율 랭킹 순위
    (랭킹 대상이 아니면 None)를 붙인다. 워크로드/파드 매치는 `k8s_workload_samples` 기준이라
    워크로드 샘플 보존기간(기본 8일)이 지난 날짜는 네임스페이스 이름으로만 찾힌다.
    """
    cfg = get_settings(db)
    if rank_by not in RANK_KEYS:
        rank_by = "cpu_rate"
    needle = (q or "").strip().lower()
    rows, source, _ = _day_rows(db, cluster, day)
    items = {it["namespace"]: it for it in (_item(r) for r in rows)}
    ranked, _total = rank(list(items.values()), rank_by, cfg, _system_namespaces(db))
    pos = {it["namespace"]: i + 1 for i, it in enumerate(ranked)}

    start, end = day_window_utc(day)
    wl_by_ns: dict[str, list[dict[str, Any]]] = {}
    for r in db.execute(_WL_SEARCH_SQL, {"q": needle, "cid": str(cluster.id), "start": start, "end": end}).mappings():
        wl_by_ns.setdefault(r["namespace"], []).append(
            {"kind": r["kind"], "name": r["name"], "pods": sorted(r["pods"] or [])[:5],
             "pod_matches": len(r["pods"] or [])})

    out = []
    for ns, it in items.items():
        ns_hit = needle in ns.lower()
        wls = wl_by_ns.get(ns, [])
        if not ns_hit and not wls:
            continue
        out.append({**it, "rank": pos.get(ns),
                    "match": {"namespace": ns_hit, "workloads": sorted(wls, key=lambda w: w["name"])[:10],
                              "workload_matches": len(wls)}})
    out.sort(key=lambda x: (x["rank"] is None, x["rank"] or 0, x["namespace"]))
    return {"q": q, "date": day.isoformat(), "rank_by": rank_by, "source": source,
            "total": len(out), "items": out[:SEARCH_LIMIT]}


# ── 공개 대상 클러스터 ──────────────────────────────────────────────────────────
def public_clusters(db: Session) -> list:
    """공개 대상 — 설정 allowlist 가 있으면 그것만, 없으면 테넌트 바인딩이 없는(전체 공유) 클러스터."""
    from app.models import Cluster
    from app.models.tenant import ClusterBinding
    cfg = get_settings(db)
    q = db.query(Cluster)
    if cfg["public_cluster_ids"]:
        allowed = set(cfg["public_cluster_ids"])
        return sorted([c for c in q.all() if str(c.id) in allowed], key=lambda c: c.name)
    bound = {cid for (cid,) in db.query(ClusterBinding.cluster_id).distinct().all()}
    return sorted([c for c in q.all() if c.id not in bound], key=lambda c: c.name)


# ── 롤업 태스크 본체 ─────────────────────────────────────────────────────────────
def rollup_recent(db: Session, days: int = 1) -> dict[str, Any]:
    """어제부터 `days` 일치 롤업을 (재)계산하고 보관기간 밖 롤업을 지운다. 클러스터별 실패는 격리."""
    from app.models import Cluster
    cfg = get_settings(db)
    today = today_local()
    built: dict[str, int] = {}
    errors: dict[str, str] = {}
    for c in db.query(Cluster).all():
        for d in range(1, max(1, days) + 1):
            day = today - timedelta(days=d)
            try:
                built[f"{c.name}:{day.isoformat()}"] = len(build_day(db, c.id, day))
            except Exception as e:  # noqa: BLE001
                db.rollback()
                log.exception("daily_report rollup failed cluster=%s day=%s", c.id, day)
                errors[f"{c.name}:{day.isoformat()}"] = str(e)[:200]
    try:
        purged = purge_old(db, cfg["retention_days"])
    except Exception as e:  # noqa: BLE001
        db.rollback()
        purged = 0
        errors["purge"] = str(e)[:200]
    return {"built": built, "purged": purged, "errors": errors}
