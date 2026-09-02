"""AppSetting 에 저장되는 효율화 설정 — 수집 스케줄(전역 + 클러스터 오버라이드) · 정책 기본값.

UI-First: 운영자가 화면에서 고치는 값이므로 코드에 리터럴로 박지 않고 여기 기본값 + AppSetting
오버라이드로만 결정한다. 자격증명은 저장하지 않는다.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Optional

from sqlalchemy.orm import Session

SCHEDULE_KEY = "k8s_efficiency.schedule"
DEFAULTS_KEY = "k8s_efficiency.policy_defaults"
DEFAULT_CRON = "*/10 * * * *"

# 전역 정책 기본값 — NS 정책(rightsize_params/quota_params)이 키 단위로 오버라이드한다.
POLICY_DEFAULTS: dict[str, Any] = {
    # 자동 적용 마스터 스위치(false 면 NS 가 opt-in 해도 추천만 낸다).
    "automation_enabled": False,
    # 사용률 소스: auto(Prometheus 우선 → metrics-server 샘플 → 데이터 부족) | prometheus | metrics
    "usage_source": "auto",
    "percentile": 95,
    "window_days": 7,
    "headroom_pct": 30,          # target = p95 × (1 + headroom)
    "floor_cpu_m": 50,
    "floor_mem_b": 64 * 1024 ** 2,
    "threshold_ratio": 1.25,     # current > target × threshold 일 때만 추천
    "min_savings_cpu_m": 100,    # 파드당 절감이 이 미만이면 추천 안 함
    "min_savings_mem_b": 128 * 1024 ** 2,
    "min_samples": 12,           # DB 샘플 소스일 때 최소 샘플 수(10분 주기 = 2시간)
    "min_coverage_hours": 24,    # DB 샘플 소스일 때 최소 관측 기간
    "system_namespaces": [
        "kube-system", "kube-public", "kube-node-lease", "monitoring", "ingress-nginx",
        "cilium", "istio-system", "cert-manager", "metallb-system", "k8s-monitor",
    ],
    "optout_annotation": "pep.io/rightsize",   # 값 "off"|"false" 면 제외
    "include_daemonsets": False,
    "keep_guaranteed": True,     # req==lim(Guaranteed) 이면 limit 도 같이 내려 QoS 유지
    "cooldown_minutes": 1440,
    "max_step_pct": 20,          # 자동 적용 1회당 컨테이너 request 최대 감소폭(%)
    "max_targets_per_run": 20,
    "maintenance_cron": None,    # 자동 적용 허용 시간대(cron 분 단위 매치) — None 이면 항상
    "quota": {
        "up_threshold": 0.85,
        "low_threshold": 0.5,
        "sustain_hours": 24,
        "lower_factor": 1.3,
        "step_pct": 25,
        "cooldown_minutes": 60,
    },
}


def _row(db: Session, key: str):
    from app.models.app_setting import AppSetting
    return db.query(AppSetting).filter(AppSetting.key == key).first()


def _upsert(db: Session, key: str, value: dict) -> dict:
    from app.models.app_setting import AppSetting
    row = _row(db, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()
    return value


# ── 수집 스케줄 ──────────────────────────────────────────────────────────────────
def get_schedule(db: Session) -> dict[str, Any]:
    row = _row(db, SCHEDULE_KEY)
    val = (row.value if row and isinstance(row.value, dict) else None) or {}
    return {
        "enabled": bool(val.get("enabled", True)),
        "default_cron": val.get("default_cron") or DEFAULT_CRON,
        "clusters": dict(val.get("clusters") or {}),
    }


def set_schedule(db: Session, enabled: bool, default_cron: str,
                 clusters: Optional[dict[str, dict]] = None) -> dict[str, Any]:
    prev = get_schedule(db)
    new_clusters: dict[str, dict] = {}
    for cid, c in (clusters if clusters is not None else prev["clusters"]).items():
        c = dict(c or {})
        old = prev["clusters"].get(cid) or {}
        new_clusters[cid] = {
            "enabled": bool(c.get("enabled", True)),
            "cron": (c.get("cron") or "").strip() or None,
            "last_run_at": c.get("last_run_at", old.get("last_run_at")),
        }
    return _upsert(db, SCHEDULE_KEY, {
        "enabled": bool(enabled), "default_cron": default_cron or DEFAULT_CRON, "clusters": new_clusters,
    })


def effective_cron(sch: dict, cluster_id: str) -> tuple[bool, str, Optional[str]]:
    """(enabled, cron, last_run_at) — 클러스터 오버라이드가 있으면 그것, 없으면 전역."""
    c = (sch.get("clusters") or {}).get(str(cluster_id)) or {}
    enabled = bool(sch.get("enabled", True)) and bool(c.get("enabled", True))
    cron = c.get("cron") or sch.get("default_cron") or DEFAULT_CRON
    return enabled, cron, c.get("last_run_at")


def mark_cluster_run(db: Session, cluster_id: str, iso_ts: str) -> None:
    sch = get_schedule(db)
    c = dict(sch["clusters"].get(str(cluster_id)) or {})
    c["last_run_at"] = iso_ts
    c.setdefault("enabled", True)
    c.setdefault("cron", None)
    sch["clusters"][str(cluster_id)] = c
    _upsert(db, SCHEDULE_KEY, sch)


# ── 정책 기본값 ──────────────────────────────────────────────────────────────────
def get_policy_defaults(db: Session) -> dict[str, Any]:
    row = _row(db, DEFAULTS_KEY)
    stored = (row.value if row and isinstance(row.value, dict) else None) or {}
    return merge_defaults(stored)


def merge_defaults(stored: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(POLICY_DEFAULTS)
    for k, v in (stored or {}).items():
        if k == "quota" and isinstance(v, dict):
            out["quota"].update({kk: vv for kk, vv in v.items() if vv is not None})
        elif v is not None:
            out[k] = v
    return out


def set_policy_defaults(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    row = _row(db, DEFAULTS_KEY)
    stored = dict((row.value if row and isinstance(row.value, dict) else None) or {})
    for k, v in (values or {}).items():
        if k not in POLICY_DEFAULTS:
            continue
        if k == "quota" and isinstance(v, dict):
            q = dict(stored.get("quota") or {})
            q.update({kk: vv for kk, vv in v.items() if kk in POLICY_DEFAULTS["quota"]})
            stored["quota"] = q
        else:
            stored[k] = v
    _upsert(db, DEFAULTS_KEY, stored)
    return merge_defaults(stored)
