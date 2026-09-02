"""수집기 — 클러스터 1개의 NS/워크로드 샘플을 한 번 적재한다(Celery 워커에서 실행).

`k8s_allocation._build_overview` 를 **재사용**해 같은 Pod 순회(on_pod 훅)에서 워크로드/컨테이너
집계를 함께 얻고, 그 결과로 Redis 공유 스냅샷도 데운다(화면 진입 시 전수 스캔이 거의 안 돎).

사용률 소스(정책 `usage_source`):
  auto      → metrics-server(빠름) → 비어 있으면 Prometheus 순간 조회 → 둘 다 없으면 none
  metrics   → metrics-server 만
  prometheus→ Prometheus 만
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any, Callable, Optional

from kubernetes import client as k8s_client
from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sNamespaceSample, K8sWorkloadSample
from app.routers import k8s_allocation as ka
from app.services.k8s_paging import list_all
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.snapshot_jobs import Progress

from . import owners as _owners
from . import prometheus as _prom
from .settings import get_policy_defaults

logger = logging.getLogger(__name__)

# 워커에서는 게이트웨이와 무관하므로 metrics 타임아웃을 넉넉히(초).
_WORKER_METRICS_TIMEOUT = (3.05, 60.0)
_PER_NS_USAGE_BUDGET_S = 120.0

STEP_PLAN = [
    {"id": "kubeconfig", "label": "kubeconfig 확인"},
    {"id": "overview", "label": "노드/파드 전수 집계"},
    {"id": "quota", "label": "ResourceQuota 조회"},
    {"id": "workload_meta", "label": "워크로드 메타(오퍼레이터/opt-out)"},
    {"id": "usage", "label": "사용률 수집"},
    {"id": "save", "label": "샘플 저장"},
    {"id": "warm", "label": "스냅샷 워밍"},
]


class _WorkloadAcc:
    """on_pod 훅 누적기 — {(ns,kind,name): {...}}."""

    def __init__(self) -> None:
        self.wl: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.pod_owner: dict[tuple[str, str], tuple[str, str, str]] = {}

    def add(self, pod, res: tuple[int, int, int, int], owner: tuple[str, str]) -> None:
        ns = pod.metadata.namespace
        kind, name = owner
        key = (ns, kind, name)
        w = self.wl.setdefault(key, {
            "pods": 0, "rc": 0, "rm": 0, "lc": 0, "lm": 0, "containers": {}, "pod_names": [],
        })
        rc, rm, lc, lm = res
        w["pods"] += 1
        w["rc"] += rc; w["rm"] += rm; w["lc"] += lc; w["lm"] += lm
        if len(w["pod_names"]) < 500:
            w["pod_names"].append(pod.metadata.name)
        self.pod_owner[(ns, pod.metadata.name)] = key
        spec = pod.spec
        containers = list((spec.containers if spec else None) or []) + ka._sidecar_containers(spec)
        for c in containers:
            r = getattr(c, "resources", None)
            req = (r.requests or {}) if r else {}
            lim = (r.limits or {}) if r else {}
            cc = w["containers"].setdefault(c.name, {
                "rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0,
                "uc_sum": 0, "um_sum": 0, "uc_max": 0, "um_max": 0, "u_n": 0,
            })
            # 파드당(템플릿) 값 — 모든 파드가 같은 템플릿이므로 첫 값 유지, 이후는 max 로 보정
            cc["rc"] = max(cc["rc"], ka._cpu_m(req.get("cpu")))
            cc["rm"] = max(cc["rm"], ka._mem_b(req.get("memory")))
            cc["lc"] = max(cc["lc"], ka._cpu_m(lim.get("cpu")))
            cc["lm"] = max(cc["lm"], ka._mem_b(lim.get("memory")))
            cc["pods"] += 1


def _quota_map(client) -> dict[str, dict[str, Any]]:
    """{ns: {name, hard_cpu_m, hard_mem_b, used_cpu_m, used_mem_b}} — NS 당 첫 quota(requests 우선)."""
    core = k8s_client.CoreV1Api(client)
    out: dict[str, dict[str, Any]] = {}
    try:
        items = list_all(lambda **kw: core.list_resource_quota_for_all_namespaces(**kw), resource_version="0")
    except Exception as e:  # noqa: BLE001
        logger.warning("ResourceQuota LIST 실패: %s", str(e)[:160])
        return out
    for q in items:
        ns = q.metadata.namespace
        hard = (q.status.hard if q.status and q.status.hard else None) or (q.spec.hard if q.spec else None) or {}
        used = (q.status.used if q.status and q.status.used else None) or {}

        def pick(d, *keys):
            for k in keys:
                if k in d:
                    return d[k]
            return None
        hc, hm = pick(hard, "requests.cpu", "cpu"), pick(hard, "requests.memory", "memory")
        uc, um = pick(used, "requests.cpu", "cpu"), pick(used, "requests.memory", "memory")
        if hc is None and hm is None:
            continue
        entry = {
            "name": q.metadata.name,
            "hard_cpu_m": ka._cpu_m(hc) if hc is not None else None,
            "hard_mem_b": ka._mem_b(hm) if hm is not None else None,
            "used_cpu_m": ka._cpu_m(uc) if uc is not None else None,
            "used_mem_b": ka._mem_b(um) if um is not None else None,
        }
        if ns not in out:
            out[ns] = entry
    return out


def _usage_metrics(client, cluster_pods: int, ns_pod_counts: dict[str, int],
                   log: Callable[[str], None]) -> dict[tuple[str, str], dict]:
    """metrics-server 순간 사용량. 활성 Pod 가 상한을 넘으면 Pod 수 상위 NS 부터 NS 단위로 순차 조회."""
    prev = ka._METRICS_TIMEOUT
    ka._METRICS_TIMEOUT = _WORKER_METRICS_TIMEOUT
    try:
        if cluster_pods <= ka._POD_USAGE_MAX:
            return ka._pod_usage(client)
        log(f"활성 Pod {cluster_pods} > {ka._POD_USAGE_MAX} — NS 단위로 순차 조회(예산 {int(_PER_NS_USAGE_BUDGET_S)}s)")
        out: dict[tuple[str, str], dict] = {}
        deadline = time.monotonic() + _PER_NS_USAGE_BUDGET_S
        for ns, _n in sorted(ns_pod_counts.items(), key=lambda kv: -kv[1]):
            if time.monotonic() >= deadline:
                log("NS 단위 usage 조회 예산 초과 — 나머지 NS 는 이번 샘플에서 usage 생략")
                break
            out.update(ka._pod_usage(client, ns))
        return out
    finally:
        ka._METRICS_TIMEOUT = prev


def collect_cluster(db: Session, cluster, *, warm_snapshot: bool = True,
                    log: Optional[Callable[[str], None]] = None,
                    step: Optional[Callable[[str, str, Optional[str]], None]] = None) -> dict[str, Any]:
    """NS/워크로드 샘플 1회 수집·저장. 반환: 요약 dict(로그용)."""
    log = log or (lambda s: logger.info("[collect %s] %s", getattr(cluster, "name", "?"), s))
    step = step or (lambda sid, st, d=None: None)
    t0 = time.monotonic()
    defaults = get_policy_defaults(db)
    optout_key = defaults.get("optout_annotation") or "pep.io/rightsize"
    usage_pref = (defaults.get("usage_source") or "auto").lower()

    step("kubeconfig", "running", None)
    ensure_kubeconfig_file(cluster)
    step("kubeconfig", "success", None)

    step("overview", "running", None)
    acc = _WorkloadAcc()
    prog = Progress()
    overview = ka._build_overview(cluster, prog, on_pod=acc.add, publish_interval=1e9)
    summary = overview["summary"]
    log(f"노드 {summary['node_count']} · NS {summary['namespace_count']} · 활성 Pod {summary['pod_count']} "
        f"· 워크로드 {len(acc.wl)} (순회 {prog.processed} pods, partial={overview.get('partial')})")
    step("overview", "success", f"pods={prog.processed}, workloads={len(acc.wl)}")

    with ka._api(cluster) as client:
        step("quota", "running", None)
        quotas = _quota_map(client)
        step("quota", "success", f"{len(quotas)} NS")
        log(f"ResourceQuota 보유 NS {len(quotas)}")

        step("workload_meta", "running", None)
        meta = _owners.workload_meta_map(client, optout_key)
        ns_optout = _owners.namespace_optouts(client, optout_key)
        managed = sum(1 for m in meta.values() if m.get("managed_by"))
        step("workload_meta", "success", f"workloads={len(meta)}, operator-managed={managed}, ns-optout={len(ns_optout)}")
        log(f"워크로드 메타 {len(meta)} (오퍼레이터 관리 {managed}, NS opt-out {len(ns_optout)})")

        step("usage", "running", None)
        ns_pod_counts = {ns: s["pods"] for ns, s in overview["per_ns"].items()}
        pu: dict[tuple[str, str], dict] = {}
        usage_source = "none"
        if usage_pref in ("auto", "metrics"):
            pu = _usage_metrics(client, summary["pod_count"], ns_pod_counts, log)
            if pu:
                usage_source = "metrics"
        if not pu and usage_pref in ("auto", "prometheus"):
            pu, err = _prom.fetch_instant_usage(cluster)
            if pu:
                usage_source = "prometheus"
            elif err:
                log(f"Prometheus 순간 사용량 조회 불가: {err}")
        step("usage", "success" if pu else "skipped", f"source={usage_source}, pods_with_usage={len(pu)}")
        log(f"사용률 소스 {usage_source} · usage 있는 Pod {len(pu)}")

    # ── 워크로드 usage 귀속 ─────────────────────────────────────────────────────
    ns_use: dict[str, list[int]] = {}
    for (ns, pod), u in pu.items():
        key = acc.pod_owner.get((ns, pod))
        agg = ns_use.setdefault(ns, [0, 0, 0])
        agg[0] += u["cpu"]; agg[1] += u["mem"]; agg[2] += 1
        if key is None:
            continue
        w = acc.wl[key]
        w.setdefault("uc", 0); w.setdefault("um", 0); w.setdefault("u_pods", 0)
        w["uc"] += u["cpu"]; w["um"] += u["mem"]; w["u_pods"] += 1
        for cname, (cc_cpu, cc_mem) in (u.get("containers") or {}).items():
            cc = w["containers"].get(cname)
            if cc is None:
                continue
            cc["uc_sum"] += cc_cpu; cc["um_sum"] += cc_mem
            cc["uc_max"] = max(cc["uc_max"], cc_cpu); cc["um_max"] = max(cc["um_max"], cc_mem)
            cc["u_n"] += 1

    step("save", "running", None)
    now = datetime.utcnow()
    ns_rows: list[K8sNamespaceSample] = []
    for ns, s in overview["per_ns"].items():
        q = quotas.get(ns) or {}
        u = ns_use.get(ns)
        ns_rows.append(K8sNamespaceSample(
            cluster_id=cluster.id, namespace=ns, sampled_at=now,
            pod_count=s["pods"], workload_count=s.get("workload_count", 0), no_request_pods=s["norq"],
            cpu_req_m=s["rc"], mem_req_b=s["rm"], cpu_lim_m=s["lc"], mem_lim_b=s["lm"],
            cpu_use_m=(u[0] if u else None), mem_use_b=(u[1] if u else None),
            usage_source=(usage_source if u else "none"),
            quota_name=q.get("name"), quota_hard_cpu_m=q.get("hard_cpu_m"), quota_hard_mem_b=q.get("hard_mem_b"),
            quota_used_cpu_m=q.get("used_cpu_m"), quota_used_mem_b=q.get("used_mem_b"),
        ))
    wl_rows: list[K8sWorkloadSample] = []
    for (ns, kind, name), w in acc.wl.items():
        m = meta.get((ns, kind, name)) or {}
        containers = {}
        for cname, cc in w["containers"].items():
            n = cc["u_n"]
            containers[cname] = {
                "rc": cc["rc"], "rm": cc["rm"], "lc": cc["lc"], "lm": cc["lm"], "pods": cc["pods"],
                "uc_avg": (cc["uc_sum"] // n) if n else None, "um_avg": (cc["um_sum"] // n) if n else None,
                "uc_max": cc["uc_max"] if n else None, "um_max": cc["um_max"] if n else None,
            }
        has_u = w.get("u_pods", 0) > 0
        wl_rows.append(K8sWorkloadSample(
            cluster_id=cluster.id, namespace=ns, kind=kind, name=name, sampled_at=now,
            pod_count=w["pods"], cpu_req_m=w["rc"], mem_req_b=w["rm"], cpu_lim_m=w["lc"], mem_lim_b=w["lm"],
            cpu_use_m=(w.get("uc") if has_u else None), mem_use_b=(w.get("um") if has_u else None),
            containers=containers, pods=w["pod_names"], managed_by=m.get("managed_by"),
            optout=bool(m.get("optout")) or (ns in ns_optout),
        ))
    db.bulk_save_objects(ns_rows)
    db.bulk_save_objects(wl_rows)
    db.commit()
    step("save", "success", f"ns={len(ns_rows)}, workloads={len(wl_rows)}")
    log(f"샘플 저장 — NS {len(ns_rows)}행, 워크로드 {len(wl_rows)}행")

    step("warm", "running", None)
    warmed = False
    if warm_snapshot:
        try:
            ka.warm_overview_snapshot(cluster.id, overview, processed=prog.processed)
            warmed = ka._overview_mgr.is_shared
        except Exception as e:  # noqa: BLE001
            log(f"스냅샷 워밍 실패(무시): {str(e)[:120]}")
    step("warm", "success" if warmed else "skipped", "redis 공유 스냅샷 갱신" if warmed else "공유 스토어 없음(메모리 모드)")

    elapsed = int((time.monotonic() - t0) * 1000)
    return {
        "namespaces": len(ns_rows), "workloads": len(wl_rows), "pods": prog.processed,
        "usage_source": usage_source, "partial": bool(overview.get("partial")),
        "operator_managed": managed, "elapsed_ms": elapsed, "sampled_at": now.isoformat(),
    }
