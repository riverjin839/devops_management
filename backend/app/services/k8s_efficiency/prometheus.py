"""Prometheus 사용률 소스 — 클러스터별 인스턴스 해석 + 컨테이너 단위 p95/순간 사용량 조회.

모든 함수는 fail-safe: Prometheus 가 꺼져 있거나(prometheus_enabled=false) 응답이 없으면
빈 dict 와 사유를 돌려주고 예외를 올리지 않는다(호출측이 metrics-server/DB 샘플로 폴백).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from app.services.prometheus_service import PrometheusService, prometheus_service

logger = logging.getLogger(__name__)

_CONTAINER_SEL = 'container!="",container!="POD"'


def service_for_cluster(cluster) -> Optional[PrometheusService]:
    """클러스터별 Prometheus URL 오버라이드가 있으면 그 인스턴스, 없으면 전역.
    prometheus_enabled=false 면 None(=offline) 으로 부정확 데이터 노출을 막는다."""
    if not bool(getattr(cluster, "prometheus_enabled", False)):
        return None
    override = (getattr(cluster, "prometheus_url", None) or "").strip()
    if override:
        return PrometheusService(base_url=override)
    return prometheus_service


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _vector(svc: PrometheusService, promql: str) -> tuple[list[dict], Optional[str]]:
    """instant query → [(labels, value)] 목록. 실패 시 ([], 사유)."""
    try:
        res = _run(svc.query(promql))
    except Exception as e:  # noqa: BLE001
        return [], str(e)[:120]
    if res.get("status") != "ok":
        return [], res.get("error") or res.get("status")
    rows = res.get("results")
    if rows is None and res.get("labels") is not None:
        rows = [{"labels": res.get("labels"), "value": res.get("value")}]
    out = []
    for r in rows or []:
        labels = r.get("labels") or r.get("metric") or {}
        v = r.get("value")
        if isinstance(v, (list, tuple)) and len(v) == 2:
            v = v[1]
        try:
            out.append({"labels": labels, "value": float(v)})
        except (TypeError, ValueError):
            continue
    return out, None


def _key(labels: dict) -> Optional[tuple[str, str, str]]:
    ns, pod, c = labels.get("namespace"), labels.get("pod"), labels.get("container")
    if not ns or not pod or not c:
        return None
    return (ns, pod, c)


def fetch_p95_usage(cluster, window_days: int = 7, percentile: int = 95,
                    step: str = "5m") -> tuple[dict[tuple[str, str, str], dict], Optional[str]]:
    """컨테이너별 p95 (cpu_m, mem_b) over window. 반환: ({(ns,pod,container): {cpu_m, mem_b}}, error)."""
    svc = service_for_cluster(cluster)
    if svc is None:
        return {}, "prometheus_disabled"
    q = max(0.5, min(0.999, percentile / 100.0))
    win = f"{int(window_days)}d"
    cpu_q = (f"quantile_over_time({q}, sum by (namespace,pod,container) "
             f"(rate(container_cpu_usage_seconds_total{{{_CONTAINER_SEL}}}[5m]))[{win}:{step}])")
    mem_q = (f"quantile_over_time({q}, sum by (namespace,pod,container) "
             f"(container_memory_working_set_bytes{{{_CONTAINER_SEL}}})[{win}:{step}])")
    cpu_rows, err1 = _vector(svc, cpu_q)
    mem_rows, err2 = _vector(svc, mem_q)
    if not cpu_rows and not mem_rows:
        return {}, err1 or err2 or "empty"
    out: dict[tuple[str, str, str], dict] = {}
    for r in cpu_rows:
        k = _key(r["labels"])
        if k:
            out.setdefault(k, {})["cpu_m"] = int(round(r["value"] * 1000))
    for r in mem_rows:
        k = _key(r["labels"])
        if k:
            out.setdefault(k, {})["mem_b"] = int(round(r["value"]))
    return out, None


def fetch_instant_usage(cluster) -> tuple[dict[tuple[str, str], dict[str, Any]], Optional[str]]:
    """순간 사용량 — metrics-server 와 같은 모양 {(ns,pod): {cpu, mem, containers:{c:(cpu,mem)}}}."""
    svc = service_for_cluster(cluster)
    if svc is None:
        return {}, "prometheus_disabled"
    cpu_rows, err1 = _vector(svc, f"sum by (namespace,pod,container) (rate(container_cpu_usage_seconds_total{{{_CONTAINER_SEL}}}[5m]))")
    mem_rows, err2 = _vector(svc, f"sum by (namespace,pod,container) (container_memory_working_set_bytes{{{_CONTAINER_SEL}}})")
    if not cpu_rows and not mem_rows:
        return {}, err1 or err2 or "empty"
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for rows, idx, scale in ((cpu_rows, 0, 1000.0), (mem_rows, 1, 1.0)):
        for r in rows:
            k = _key(r["labels"])
            if not k:
                continue
            ns, pod, c = k
            e = out.setdefault((ns, pod), {"cpu": 0, "mem": 0, "containers": {}})
            cur = list(e["containers"].get(c, (0, 0)))
            cur[idx] = int(round(r["value"] * scale))
            e["containers"][c] = (cur[0], cur[1])
    for e in out.values():
        e["cpu"] = sum(v[0] for v in e["containers"].values())
        e["mem"] = sum(v[1] for v in e["containers"].values())
    return out, None
