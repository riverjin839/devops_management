"""
Cluster Trends — per-node 메트릭 시계열(추이) 라우터.

노드(라우터/스위치가 아닌 K8s 노드) 단위로 CPU/Memory/Disk/DiskIO/Network/NetworkErr 의
시간창(30m/1h/6h/24h/7d) 추이를 Prometheus range query 로 가져온다.

300+ 노드 과수집 방지 설계:
- 노드를 **명시 선택**해야만 조회(미선택 시 400). 선택 개수는 `settings.trends_max_nodes`(기본 30) 상한.
- 시간창별 step(해상도)을 자동 조정 → 시리즈당 datapoint 를 ~340 이하로 제한.
- 노드들을 `<label>=~"a|b|c"` regex 로 묶어 **메트릭당 range query 1회**(노드 수와 무관, 최대 6회/refresh).

데이터 소스는 per-cluster Prometheus(`clusters.prometheus_url`), 없으면 전역 settings.prometheus_url.
`prometheus_enabled=false` 면 부정확 데이터 노출을 막기 위해 offline 로 응답.
PrometheusService 의 fail-safe 패턴을 그대로 따라 500 을 내지 않는다.
"""

import re
import time
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.cluster import Cluster
from app.routers.k8s_resources import _require_cluster
from app.services.prometheus_service import PrometheusService

router = APIRouter(prefix="/k8s", tags=["cluster-trends"])

# 시간창 → (전체 구간 초, step, rate window). step·rate 는 datapoint 수를 묶어 과수집을 막는다.
# datapoint/series ≈ duration/step → 모두 ~340 이하.
_RANGE_MAP: dict[str, tuple[int, str, str]] = {
    "30m": (30 * 60, "30s", "2m"),
    "1h": (60 * 60, "60s", "2m"),
    "6h": (6 * 60 * 60, "2m", "4m"),
    "24h": (24 * 60 * 60, "5m", "10m"),
    "7d": (7 * 24 * 60 * 60, "30m", "1h"),
}

# 메트릭 → (단위, PromQL 템플릿). `<L>`=노드 라벨명, `$n`=노드 regex, `$w`=rate window.
# 모두 검증된 node-exporter 표준 메트릭명. 라벨 매칭은 `<L>=~"$n"`.
_METRICS: dict[str, tuple[str, str]] = {
    "cpu": (
        "%",
        '100 - (avg by (<L>) (rate(node_cpu_seconds_total{mode="idle",<L>=~"$n"}[$w])) * 100)',
    ),
    "memory": (
        "%",
        "100 * (1 - (node_memory_MemAvailable_bytes{<L>=~\"$n\"} "
        "/ node_memory_MemTotal_bytes{<L>=~\"$n\"}))",
    ),
    "disk": (
        "%",
        '100 * (1 - (node_filesystem_avail_bytes{<L>=~"$n",fstype!~"tmpfs|overlay",mountpoint="/"} '
        '/ node_filesystem_size_bytes{<L>=~"$n",fstype!~"tmpfs|overlay",mountpoint="/"}))',
    ),
    "diskio": (
        "B/s",
        "sum by (<L>) (rate(node_disk_read_bytes_total{<L>=~\"$n\"}[$w]) "
        "+ rate(node_disk_written_bytes_total{<L>=~\"$n\"}[$w]))",
    ),
    "network": (
        "B/s",
        'sum by (<L>) (rate(node_network_receive_bytes_total{<L>=~"$n",device!~"lo"}[$w]) '
        '+ rate(node_network_transmit_bytes_total{<L>=~"$n",device!~"lo"}[$w]))',
    ),
    "networkerr": (
        "errors/s",
        'sum by (<L>) (rate(node_network_receive_errs_total{<L>=~"$n",device!~"lo"}[$w]) '
        '+ rate(node_network_transmit_errs_total{<L>=~"$n",device!~"lo"}[$w]))',
    ),
}


def _service_for(cluster: Cluster) -> Optional[PrometheusService]:
    """클러스터별 Prometheus 인스턴스 해석 — k8s_efficiency.prometheus.service_for_cluster 와 공유."""
    from app.services.k8s_efficiency.prometheus import service_for_cluster
    return service_for_cluster(cluster)


def _build_promql(template: str, label: str, node_regex: str, window: str) -> str:
    return (
        template.replace("<L>", label)
        .replace("$n", node_regex)
        .replace("$w", window)
    )


@router.get("/{cluster_id}/trends")
async def cluster_trends(
    cluster_id: UUID,
    range: str = Query("1h"),
    metrics: str = Query("cpu,memory"),
    nodes: str = Query(""),
    db: Session = Depends(get_db),
):
    """선택 노드들의 메트릭 추이(시계열)를 반환.

    응답: {range, step, status, error, dropped, metrics: {<m>: {unit, series: [{node, points:[{t,v}]}]}}}
    """
    cluster = _require_cluster(cluster_id, db)

    if range not in _RANGE_MAP:
        raise HTTPException(status_code=400, detail=f"range must be one of {list(_RANGE_MAP)}")

    node_list = [n.strip() for n in nodes.split(",") if n.strip()]
    if not node_list:
        raise HTTPException(status_code=400, detail="노드를 1개 이상 선택하세요 (nodes 파라미터).")

    # 상한 — 초과분은 잘라내고 dropped 에 기록(과수집 방지).
    dropped: list[str] = []
    cap = max(1, int(settings.trends_max_nodes))
    if len(node_list) > cap:
        dropped = node_list[cap:]
        node_list = node_list[:cap]

    metric_keys = [m.strip().lower() for m in metrics.split(",") if m.strip().lower() in _METRICS]
    if not metric_keys:
        raise HTTPException(status_code=400, detail=f"metrics must include any of {list(_METRICS)}")

    duration, step, window = _RANGE_MAP[range]
    label = settings.prometheus_node_label
    # 노드명을 regex 로 묶음 (정규식 메타문자 escape — 노드명에 '.' 등 포함 가능).
    node_regex = "|".join(re.escape(n) for n in node_list)

    svc = _service_for(cluster)
    if svc is None:
        return {
            "range": range,
            "step": step,
            "status": "offline",
            "error": "이 클러스터에 Prometheus 가 설정/활성화되지 않았습니다 (클러스터 관리에서 설정).",
            "dropped": dropped,
            "metrics": {},
        }

    end = time.time()
    start = end - duration

    out_metrics: dict[str, dict] = {}
    overall_status = "ok"
    first_error: Optional[str] = None

    for m in metric_keys:
        unit, template = _METRICS[m]
        promql = _build_promql(template, label, node_regex, window)
        res = await svc.query_range(promql, start, end, step)

        if res.get("status") != "ok":
            # fail-safe: 한 메트릭 실패해도 나머지는 계속. 전체 상태는 첫 비정상으로 표기.
            if overall_status == "ok":
                overall_status = res.get("status", "error")
                first_error = res.get("error")
            out_metrics[m] = {"unit": unit, "series": []}
            continue

        series = []
        for s in res.get("series") or []:
            node_name = (s.get("labels") or {}).get(label, "")
            points = [
                {"t": int(float(ts)), "v": _to_float(val)}
                for ts, val in (s.get("values") or [])
            ]
            series.append({"node": node_name, "points": points})
        out_metrics[m] = {"unit": unit, "series": series}

    return {
        "range": range,
        "step": step,
        "status": overall_status,
        "error": first_error,
        "dropped": dropped,
        "metrics": out_metrics,
    }


def _to_float(val) -> Optional[float]:
    try:
        f = float(val)
        if f != f:  # NaN
            return None
        return round(f, 4)
    except (ValueError, TypeError):
        return None
