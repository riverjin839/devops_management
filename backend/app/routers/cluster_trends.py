"""
Cluster Trends — per-node 메트릭 시계열(추이) 라우터.

노드(라우터/스위치가 아닌 K8s 노드) 단위로 CPU/Memory/Disk/DiskIO/Network/NetworkErr 의
시간창(30m/1h/6h/24h/7d) 추이를 Prometheus range query 로 가져온다.

300+ 노드 과수집 방지 설계:
- 노드를 **명시 선택**해야만 조회(미선택 시 400). 선택 개수는 `settings.trends_max_nodes`(기본 30) 상한
  — 응답 `max_nodes` 로 내려 화면이 같은 상한을 쓴다.
- 시간창별 step(해상도)을 자동 조정 → 시리즈당 datapoint 를 ~340 이하로 제한.
- 노드들을 `<label>=~"a|b|c"` regex 로 묶어 **메트릭당 range query 1회**(노드 수와 무관, 최대 6회/refresh)
  — 6회는 병렬, 전체 예산 25초.
- 노드 라벨은 클러스터 컬럼 `trend_node_label`(클러스터 정보 수정 화면). 비었거나 `auto` 면
  node → kubernetes_node → instance 순 자동 탐지(UI-First, D-185).

데이터 소스는 per-cluster Prometheus(`clusters.prometheus_url`), 없으면 전역 settings.prometheus_url.
`prometheus_enabled=false` 면 부정확 데이터 노출을 막기 위해 offline 로 응답.
PrometheusService 의 fail-safe 패턴을 그대로 따라 500 을 내지 않는다.
"""

import asyncio
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
from app.schemas.cluster import TREND_NODE_LABEL_PATTERN
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


# 전체 응답 예산 — 프론트 axios 30초보다 짧게(지표 6종 병렬 + 라벨 자동 탐지 포함).
_TRENDS_BUDGET_SECONDS = 25.0
# 라벨 자동 탐지(probe) 단계 상한 — 남은 예산은 지표 질의에 쓴다.
_LABEL_PROBE_BUDGET_SECONDS = 8.0
# 자동 탐지 순서 (정책 결정 ⑤) — 첫 번째로 시리즈가 나오는 라벨을 쓴다.
_AUTO_LABEL_CANDIDATES: tuple[str, ...] = ("node", "kubernetes_node", "instance")
_AUTO_LABEL_PROBE = "count by (<L>) (node_memory_MemTotal_bytes{<L>=~\"$n\"})"
_AUTO_LABEL_CACHE_TTL = 600.0
# (cluster_id, prometheus base_url) → (label, 만료 monotonic). 성공한 탐지만 캐시한다.
_auto_label_cache: dict[tuple[str, str], tuple[str, float]] = {}
_LABEL_RE = re.compile(TREND_NODE_LABEL_PATTERN)


def _configured_label(cluster: Cluster) -> Optional[str]:
    """클러스터 컬럼 `trend_node_label` — 빈 값·`auto` 면 None(=자동 탐지)."""
    raw = (getattr(cluster, "trend_node_label", None) or "").strip()
    if not raw or raw.lower() == "auto" or not _LABEL_RE.match(raw):
        return None
    return raw


def _auto_candidates() -> list[str]:
    """자동 탐지 후보. 환경변수 PROMETHEUS_NODE_LABEL 이 표준 후보 밖의 이름이면 맨 앞에 둔다
    (배포 전역 기본값 fallback — 클러스터별 값은 화면에서 지정)."""
    out = list(_AUTO_LABEL_CANDIDATES)
    env_label = (getattr(settings, "prometheus_node_label", "") or "").strip()
    if env_label and _LABEL_RE.match(env_label) and env_label not in out:
        out.insert(0, env_label)
    return out


def _max_nodes() -> int:
    return max(1, int(settings.trends_max_nodes))


async def _with_deadline(coro, deadline: float) -> dict:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        coro.close()
        return {"status": "error", "error": "시간 초과 — 응답 예산(25초) 안에 질의하지 못했습니다."}
    try:
        return await asyncio.wait_for(coro, timeout=remaining)
    except asyncio.TimeoutError:
        return {"status": "error", "error": "시간 초과 — Prometheus 가 응답 예산(25초) 안에 답하지 않았습니다."}
    except Exception as e:  # noqa: BLE001 — fail-safe
        return {"status": "error", "error": str(e)[:200] or type(e).__name__}


async def _detect_label(
    svc: PrometheusService, cluster: Cluster, node_regex: str, deadline: float,
) -> tuple[Optional[str], list[str]]:
    """auto — 후보 라벨을 병렬 probe 해 우선순위상 첫 번째로 시리즈가 있는 라벨. 없으면 (None, 후보)."""
    candidates = _auto_candidates()
    key = (str(getattr(cluster, "id", "")), getattr(svc, "base_url", ""))
    cached = _auto_label_cache.get(key)
    if cached and cached[1] > time.monotonic():
        return cached[0], candidates
    probe_deadline = min(deadline, time.monotonic() + _LABEL_PROBE_BUDGET_SECONDS)
    results = await asyncio.gather(*[
        _with_deadline(svc.query(_build_promql(_AUTO_LABEL_PROBE, lab, node_regex, "")), probe_deadline)
        for lab in candidates
    ])
    for lab, res in zip(candidates, results):
        if res.get("status") == "ok" and (res.get("results") or res.get("labels") is not None):
            _auto_label_cache[key] = (lab, time.monotonic() + _AUTO_LABEL_CACHE_TTL)
            return lab, candidates
    return None, candidates


@router.get("/{cluster_id}/trends")
async def cluster_trends(
    cluster_id: UUID,
    range: str = Query("1h"),
    metrics: str = Query("cpu,memory"),
    nodes: str = Query(""),
    db: Session = Depends(get_db),
):
    """선택 노드들의 메트릭 추이(시계열)를 반환.

    응답: {range, step, status, error, hint, dropped, max_nodes, node_label,
           metrics: {<m>: {unit, error, series: [{node, points:[{t,v}]}]}}}
    - 지표 질의는 병렬, 전체 예산 25초(프론트 30초 이내). 지표별 실패는 `metrics[m].error`.
    - `node_label` = 실제로 쓴 노드 라벨. 클러스터 `trend_node_label` 이 비었거나 `auto` 면
      node → kubernetes_node → instance 순으로 시리즈가 있는 첫 라벨(D-185).
    - `hint` = 데이터가 없는 이유(연동 꺼짐·연결 불가·라벨 불일치)와 고칠 위치.
    """
    t0 = time.monotonic()
    deadline = t0 + _TRENDS_BUDGET_SECONDS
    cluster = _require_cluster(cluster_id, db)

    if range not in _RANGE_MAP:
        raise HTTPException(status_code=400, detail=f"range must be one of {list(_RANGE_MAP)}")

    node_list = [n.strip() for n in nodes.split(",") if n.strip()]
    if not node_list:
        raise HTTPException(status_code=400, detail="노드를 1개 이상 선택하세요 (nodes 파라미터).")

    # 상한 — 초과분은 잘라내고 dropped 에 기록(과수집 방지). 화면은 응답 max_nodes 를 상한으로 쓴다.
    dropped: list[str] = []
    cap = _max_nodes()
    if len(node_list) > cap:
        dropped = node_list[cap:]
        node_list = node_list[:cap]

    metric_keys = [m.strip().lower() for m in metrics.split(",") if m.strip().lower() in _METRICS]
    if not metric_keys:
        raise HTTPException(status_code=400, detail=f"metrics must include any of {list(_METRICS)}")

    duration, step, window = _RANGE_MAP[range]
    configured = _configured_label(cluster)
    # 노드명을 regex 로 묶음 (정규식 메타문자 escape — 노드명에 '.' 등 포함 가능).
    # re.escape 는 `-`·`.` 앞에 `\` 를 붙이는데 PromQL 큰따옴표 문자열은 `\-` 같은 미지의 escape 를 거부한다
    # (parse error) — 문자열 안에서 한 번 더 escape 해 정규식 엔진에 `\-` 가 그대로 가게 한다.
    node_regex = "|".join(re.escape(n) for n in node_list).replace("\\", "\\\\")

    base = {
        "range": range,
        "step": step,
        "dropped": dropped,
        "max_nodes": cap,
    }

    svc = _service_for(cluster)
    if svc is None:
        return {
            **base,
            "status": "offline",
            "error": "이 클러스터의 Prometheus 연동(prometheus_enabled)이 꺼져 있습니다.",
            "hint": (
                "클러스터 정보 수정의 '메트릭 추이 (Prometheus)' 에서 prometheus_enabled"
                "(이 클러스터에서 클러스터 추이(Prometheus) 사용)를 켜세요. "
                "Prometheus URL 을 비우면 전역 PROMETHEUS_URL 을 씁니다."
            ),
            "node_label": configured or "auto",
            "metrics": {},
        }

    try:
        auto_tried: list[str] = []
        if configured:
            label = configured
        else:
            detected, auto_tried = await _detect_label(svc, cluster, node_regex, deadline)
            # 아무 후보도 시리즈가 없으면 마지막 후보(instance)로 질의해 연결 상태·오류를 그대로 보인다.
            label = detected or auto_tried[-1]

        end = time.time()
        start = end - duration
        results = await asyncio.gather(*[
            _with_deadline(
                svc.query_range(_build_promql(_METRICS[m][1], label, node_regex, window), start, end, step),
                deadline,
            )
            for m in metric_keys
        ])
    finally:
        await _close_if_private(svc)

    out_metrics: dict[str, dict] = {}
    overall_status = "ok"
    first_error: Optional[str] = None
    statuses: list[str] = []
    any_series = False

    for m, res in zip(metric_keys, results):
        unit = _METRICS[m][0]
        st = res.get("status") or "error"
        statuses.append(st)
        if st != "ok":
            # fail-safe: 한 메트릭 실패해도 나머지는 계속. 전체 상태는 첫 비정상으로 표기.
            err = res.get("error") or st
            if overall_status == "ok":
                overall_status = st
                first_error = err
            out_metrics[m] = {"unit": unit, "error": err, "series": []}
            continue

        series = []
        for s in res.get("series") or []:
            node_name = (s.get("labels") or {}).get(label, "")
            points = [
                {"t": int(float(ts)), "v": _to_float(val)}
                for ts, val in (s.get("values") or [])
            ]
            series.append({"node": node_name, "points": points})
        any_series = any_series or bool(series)
        out_metrics[m] = {"unit": unit, "error": None, "series": series}

    hint: Optional[str] = None
    if statuses and all(s == "offline" for s in statuses):
        hint = (
            f"Prometheus({getattr(svc, 'base_url', '')})에 연결할 수 없습니다 — "
            "클러스터 정보 수정의 Prometheus URL(prometheus_url)과 PEP 백엔드에서의 네트워크 도달을 확인하세요."
        )
    elif "ok" in statuses and not any_series:
        if configured:
            hint = (
                f"Prometheus 시리즈의 '{label}' 라벨이 노드 이름과 맞지 않습니다 — "
                "클러스터 정보 수정의 '추이 노드 라벨'(trend_node_label)을 바꾸거나 비워 자동 탐지하세요."
            )
        else:
            hint = (
                f"자동 탐지한 라벨({', '.join(auto_tried)}) 중 노드 이름과 맞는 node-exporter 시리즈가 없습니다 — "
                "클러스터 정보 수정의 '추이 노드 라벨'(trend_node_label)에 노드 이름이 든 라벨을 지정하세요."
            )
    elif statuses and all(s != "ok" for s in statuses):
        hint = "모든 지표 질의가 실패했습니다 — 지표별 오류를 확인하세요."

    return {
        **base,
        "status": overall_status,
        "error": first_error,
        "hint": hint,
        "node_label": label,
        "metrics": out_metrics,
    }


async def _close_if_private(svc: PrometheusService) -> None:
    from app.services.prometheus_service import aclose_if_private
    await aclose_if_private(svc)


def _to_float(val) -> Optional[float]:
    try:
        f = float(val)
        if f != f:  # NaN
            return None
        return round(f, 4)
    except (ValueError, TypeError):
        return None
