"""K8s 자원 관리 — 노드 allocatable 대비 request/사용량(slack) 가시화.

운영 목적: 노드 CPU/MEM 은 여유가 있는데 파드 request 가 과대 설정(slack)되어
스케줄러가 "꽉 찼다"고 판단 → 노드 낭비. 이를 **노드 / 네임스페이스 / 워크로드 /
파드** 단위로 드릴다운하며 request 과대·미설정 범인을 찾는다.

모두 **읽기 전용 라이브 조회** — DB 모델/마이그레이션 없음.

대규모 클러스터(수천 NS / 수만 Pod) 대응:
- 모든 LIST 는 `_continue` 페이지네이션으로 **전량** 수집(상한 truncation 없음).
- 종료 파드는 서버측 field_selector 로 제외해 전송량을 줄인다.
- 노드/네임스페이스 집계는 **단일 스냅샷**(한 번의 Pod 순회로 둘 다 계산, 결과는 작은
  숫자 dict)으로 만들고 20초 TTL 캐시 → 탭 전환 시 재조회 없음(타겟 부하 최소화).
  raw Pod 객체는 캐시하지 않는다(메모리/OOM 방지).
- metrics-server 호출은 짧은 타임아웃 + Pod 수가 많으면 cluster-wide usage 생략
  (드릴다운에서 NS 단위로 정확히 확인). 모든 API 호출에 서버측 타임아웃 → 502(프록시
  타임아웃) 대신 graceful degrade.

수량 파싱은 SDK 내장 `kubernetes.utils.parse_quantity` 재사용. CPU=millicores(int),
MEM=bytes(int). `k8s_resources` 공용 헬퍼(`_api_client`/`_require_cluster`) 재사용.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from decimal import ROUND_HALF_UP
from typing import Any, Callable, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from kubernetes import client as k8s_client
from kubernetes.utils import parse_quantity
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.k8s_resources import (
    _api_client, _require_cluster, _classify_pod_status, _TERMINAL_PHASES,
)
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.snapshot_jobs import Progress, SnapshotManager
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k8s-allocation"])

# 비종료 파드(자원을 점유)만 집계 대상.
_ACTIVE_PHASES = {"Running", "Pending"}
# 서버측에서 종료 파드 제외 — 전송량/부하 감소.
_ACTIVE_FIELD_SELECTOR = "status.phase!=Succeeded,status.phase!=Failed"
_MASTER_ROLE_KEYS = (
    "node-role.kubernetes.io/master",
    "node-role.kubernetes.io/control-plane",
)

def _envf(name: str, default: float) -> float:
    """환경변수에서 float 읽기(잘못된 값/미설정 시 default). 운영자가 게이트웨이 타임아웃에
    맞춰 코드 변경 없이 예산/타임아웃을 조정할 수 있게 한다."""
    try:
        v = os.getenv(name)
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


# K8s API 호출 서버측 타임아웃 / 페이지네이션 헬퍼는 공용 모듈로 분리.
from app.services.k8s_paging import (  # noqa: E402
    iter_all as _iter_all, list_all as _list_all, API_TIMEOUT as _API_TIMEOUT,
)
_METRICS_TIMEOUT = (3.05, _envf("K8S_ALLOC_METRICS_TIMEOUT", 8.0))  # 느리면 usage 생략(best-effort)
# cluster-wide pod usage(metrics) 는 활성 Pod 가 이 수 이하일 때만 시도(대규모 클러스터 보호 —
# 초과 시 metrics 단일 응답이 타임아웃만 반복하므로 생략하고 드릴다운에서 NS 단위로 확인).
_POD_USAGE_MAX = int(_envf("K8S_ALLOC_POD_USAGE_MAX", 6000))
# 부분(절단) 스냅샷의 캐시 수명(초) — 완전한 스냅샷(_OVERVIEW_TTL)보다 짧게 둬서 자동 재집계.
_PARTIAL_TTL = _envf("K8S_ALLOC_PARTIAL_TTL", 300.0)
# computing 이 이 시간(초)을 넘기면 행업으로 간주하고 refresh 시 새 계산으로 교체.
_STUCK_TIMEOUT = _envf("K8S_ALLOC_STUCK_TIMEOUT", 1800.0)

# 비싼 집계 스냅샷에 대한 짧은 TTL 캐시(클러스터/네임스페이스 키별 격리).
# 크기 상한을 둔다 — 드릴다운을 많이 펼치는 대형 클러스터에서 무제한 성장·클러스터 삭제 후
# 잔존(BE-14)을 막는다. 만료 항목 정리 후에도 상한을 넘으면 가장 오래된 항목부터 퇴출.
_CACHE_TTL = 20.0
_CACHE_MAX = int(_envf("K8S_ALLOC_DRILL_CACHE_MAX", 256))
_CACHE: dict[str, tuple[float, Any]] = {}
_CACHE_LOCK = threading.Lock()


def _cached(key: str, producer: Callable[[], Any]) -> Any:
    """key 가 TTL 내면 캐시 반환, 아니면 producer() 실행 후 캐시. 예외는 캐시 안 함."""
    now = time.monotonic()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None and (now - hit[0]) < _CACHE_TTL:
            return hit[1]
    val = producer()
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            for k in [k for k, (t, _) in _CACHE.items() if (now - t) >= _CACHE_TTL]:
                _CACHE.pop(k, None)
            while len(_CACHE) >= _CACHE_MAX:
                oldest = min(_CACHE.items(), key=lambda kv: kv[1][0])[0]
                _CACHE.pop(oldest, None)
        _CACHE[key] = (now, val)
    return val


def invalidate_cluster_cache(cluster_id) -> None:
    """클러스터 삭제/kubeconfig 교체 시 드릴다운 캐시 + 개요 스냅샷을 비운다."""
    cid = str(cluster_id)
    with _CACHE_LOCK:
        for k in [k for k in _CACHE if k.startswith(f"{cid}:")]:
            _CACHE.pop(k, None)
    try:
        _overview_mgr.invalidate(f"{cid}:overview")
    except Exception:  # noqa: BLE001
        pass


def _strip_hash(rs_name: str) -> str:
    """ReplicaSet 이름에서 pod-template-hash 접미사 제거 → Deployment 이름 추정(폴백).

    해시는 rand.SafeEncodeString 알파벳(bcdfghjklmnpqrstvwxz2456789)으로 생성된다 —
    hex([a-f0-9]) 가 아니므로 hex 패턴으로는 대부분의 실제 해시를 못 벗겨 RS 세대마다
    별개 워크로드로 집계된다.
    """
    return re.sub(r"-[bcdfghjklmnpqrstvwxz2456789]{5,10}$", "", rs_name)


# ── 수량 파싱/표시 ──────────────────────────────────────────────────────────────
def _cpu_m(v) -> int:
    """CPU 수량 문자열 → millicores(int, 반올림 — nanocores("451331n") 절삭 소실 방지).
    빈 값 0, 파싱 실패는 0 처리하되 로그를 남긴다(무요청 파드로 오인되는 것을 추적 가능하게)."""
    if not v:
        return 0
    try:
        return int((parse_quantity(v) * 1000).to_integral_value(rounding=ROUND_HALF_UP))
    except Exception:  # noqa: BLE001
        logger.warning("CPU 수량 파싱 실패(0 처리): %r", v)
        return 0


def _mem_b(v) -> int:
    """메모리 수량 문자열 → bytes(int). 빈 값/파싱 실패 시 0(실패는 로그)."""
    if not v:
        return 0
    try:
        return int(parse_quantity(v).to_integral_value(rounding=ROUND_HALF_UP))
    except Exception:  # noqa: BLE001
        logger.warning("메모리 수량 파싱 실패(0 처리): %r", v)
        return 0


def _pods_n(v) -> int:
    """allocatable pods 수량(예 "110") → int. 없거나 파싱 실패 시 0(미상=비제약 처리)."""
    if not v:
        return 0
    try:
        return int(parse_quantity(v))
    except Exception:  # noqa: BLE001
        logger.warning("pods 수량 파싱 실패(0 처리): %r", v)
        return 0


def _fmt_cpu(m: int) -> str:
    """millicores → 사람이 읽는 문자열 ('1.5' / '500m')."""
    if m <= 0:
        return "0"
    if m >= 1000:
        return f"{m / 1000:.2f}".rstrip("0").rstrip(".")
    return f"{m}m"


def _fmt_mem(b: int) -> str:
    """bytes → 사람이 읽는 문자열 (Ki/Mi/Gi/Ti)."""
    if b <= 0:
        return "0"
    units = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"]
    f = float(b)
    i = 0
    while f >= 1024 and i < len(units) - 1:
        f /= 1024
        i += 1
    return f"{f:.1f}".rstrip("0").rstrip(".") + units[i]


# ── 컨테이너 자원 합산 ───────────────────────────────────────────────────────────
def _sum_resources(containers) -> tuple[int, int, int, int]:
    """컨테이너 목록 → (req_cpu_m, req_mem_b, lim_cpu_m, lim_mem_b)."""
    rc = rm = lc = lm = 0
    for c in containers or []:
        res = getattr(c, "resources", None)
        if not res:
            continue
        req = res.requests or {}
        lim = res.limits or {}
        rc += _cpu_m(req.get("cpu"))
        rm += _mem_b(req.get("memory"))
        lc += _cpu_m(lim.get("cpu"))
        lm += _mem_b(lim.get("memory"))
    return rc, rm, lc, lm


def _sidecar_containers(spec) -> list:
    """네이티브 사이드카(init 이면서 restartPolicy=Always, 1.29+ GA) 목록 — 파드 수명
    내내 상주하므로 자원 집계·컨테이너 표시에서 일반 컨테이너와 동일하게 취급한다."""
    return [c for c in (getattr(spec, "init_containers", None) or [])
            if getattr(c, "restart_policy", None) == "Always"]


def _pod_effective_resources(spec) -> tuple[int, int, int, int]:
    """Pod spec → 스케줄러 기준 **유효** (req_cpu_m, req_mem_b, lim_cpu_m, lim_mem_b).

    K8s 유효 요청량 규칙: max(Σ(일반 + 사이드카 컨테이너), max(일반 init 컨테이너))
    + spec.overhead. 일반 init 는 순차 실행이라 리소스별 최대값만 점유하고, 사이드카
    (init restartPolicy=Always)는 상주하므로 합산한다. spec.containers 만 합산하면
    메시/에이전트 주입 클러스터에서 request 가 과소집계되어 slack(여유)이 과대평가된다.
    """
    if not spec:
        return 0, 0, 0, 0
    rc, rm, lc, lm = _sum_resources(getattr(spec, "containers", None))
    src, srm, slc, slm = _sum_resources(_sidecar_containers(spec))
    rc += src; rm += srm; lc += slc; lm += slm
    init_rc = init_rm = init_lc = init_lm = 0
    for c in (getattr(spec, "init_containers", None) or []):
        if getattr(c, "restart_policy", None) == "Always":
            continue  # 사이드카 — 위에서 합산됨
        crc, crm, clc, clm = _sum_resources([c])
        init_rc = max(init_rc, crc); init_rm = max(init_rm, crm)
        init_lc = max(init_lc, clc); init_lm = max(init_lm, clm)
    rc = max(rc, init_rc); rm = max(rm, init_rm)
    lc = max(lc, init_lc); lm = max(lm, init_lm)
    overhead = getattr(spec, "overhead", None) or {}
    if overhead:  # RuntimeClass 오버헤드(Kata/gVisor)는 request/limit 양쪽에 가산된다.
        oc, om = _cpu_m(overhead.get("cpu")), _mem_b(overhead.get("memory"))
        rc += oc; rm += om; lc += oc; lm += om
    return rc, rm, lc, lm


@contextmanager
def _api(cluster):
    """ApiClient 를 요청/빌드 단위로 열고 반드시 닫는다 — urllib3 풀/스레드 누수 방지
    (폴링 화면이라 요청마다 새 클라이언트가 만들어지므로 누적이 빠르다)."""
    client = _api_client(cluster)
    try:
        yield client
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


def _node_roles(labels: dict) -> list[str]:
    roles: list[str] = []
    if any(k in labels for k in _MASTER_ROLE_KEYS):
        roles.append("control-plane")
    for k in labels:
        if k.startswith("node-role.kubernetes.io/") and k not in _MASTER_ROLE_KEYS:
            r = k.split("/", 1)[1]
            if r and r not in roles:
                roles.append(r)
    return sorted(set(roles)) or ["worker"]


# ── metrics-server 수집 ──────────────────────────────────────────────────────────
def _node_usage(client) -> dict[str, tuple[int, int]]:
    """노드 usage 맵 {node: (cpu_m, mem_b)}. metrics-server 없으면 빈 dict."""
    out: dict[str, tuple[int, int]] = {}
    try:
        co = k8s_client.CustomObjectsApi(client)
        m = co.list_cluster_custom_object(
            "metrics.k8s.io", "v1beta1", "nodes", _request_timeout=_METRICS_TIMEOUT,
        )
        for it in (m.get("items") or []):
            name = (it.get("metadata") or {}).get("name", "")
            u = it.get("usage") or {}
            out[name] = (_cpu_m(u.get("cpu")), _mem_b(u.get("memory")))
    except Exception:  # noqa: BLE001
        pass
    return out


def _node_usage_one(client, node: str) -> Optional[tuple[int, int]]:
    """단일 노드 usage (cpu_m, mem_b) — 노드 1개 REFRESH 에 cluster-wide metrics 를 다 긁던
    N+1(369노드면 369건 응답)을 단건 GET 으로 대체. metrics-server 없으면 None."""
    try:
        co = k8s_client.CustomObjectsApi(client)
        it = co.get_cluster_custom_object(
            "metrics.k8s.io", "v1beta1", "nodes", node, _request_timeout=_METRICS_TIMEOUT,
        )
        u = (it or {}).get("usage") or {}
        return (_cpu_m(u.get("cpu")), _mem_b(u.get("memory")))
    except Exception:  # noqa: BLE001
        return None


def _pod_usage(client, namespace: Optional[str] = None) -> dict[tuple[str, str], dict]:
    """파드 usage 맵 {(ns,pod): {'cpu','mem','containers':{c:(cpu,mem)}}}.

    namespace 지정 시 해당 NS 만(드릴다운), 없으면 전체 클러스터.
    metrics-server 없거나 느리면 빈 dict(best-effort).
    """
    out: dict[tuple[str, str], dict] = {}
    try:
        co = k8s_client.CustomObjectsApi(client)
        if namespace:
            m = co.list_namespaced_custom_object(
                "metrics.k8s.io", "v1beta1", namespace, "pods",
                _request_timeout=_METRICS_TIMEOUT,
            )
        else:
            m = co.list_cluster_custom_object(
                "metrics.k8s.io", "v1beta1", "pods", _request_timeout=_METRICS_TIMEOUT,
            )
        for it in (m.get("items") or []):
            meta = it.get("metadata") or {}
            ns = meta.get("namespace", "")
            name = meta.get("name", "")
            cpu = mem = 0
            cmap: dict[str, tuple[int, int]] = {}
            for c in (it.get("containers") or []):
                u = c.get("usage") or {}
                ccpu, cmem = _cpu_m(u.get("cpu")), _mem_b(u.get("memory"))
                cpu += ccpu
                mem += cmem
                cmap[c.get("name", "")] = (ccpu, cmem)
            out[(ns, name)] = {"cpu": cpu, "mem": mem, "containers": cmap}
    except Exception:  # noqa: BLE001
        pass
    return out


# ── ownerRef 최상위 워크로드 귀속 ─────────────────────────────────────────────────
def _direct_owner(meta) -> tuple[Optional[str], Optional[str]]:
    refs = getattr(meta, "owner_references", None) or []
    for o in refs:
        if getattr(o, "controller", False):
            return o.kind, o.name
    if refs:
        return refs[0].kind, refs[0].name
    return None, None


def _build_rs_owner_map(apps_api, namespace: str) -> dict[tuple[str, str], tuple[str, str]]:
    """ReplicaSet → 상위(Deployment) 귀속 맵 {(ns,rs): (kind,name)} — NS 단위(드릴다운)."""
    out: dict[tuple[str, str], tuple[str, str]] = {}
    try:
        rss = _list_all(lambda **kw: apps_api.list_namespaced_replica_set(namespace, **kw))
        for rs in rss:
            ns = rs.metadata.namespace
            ok, on = _direct_owner(rs.metadata)
            out[(ns, rs.metadata.name)] = (ok or "ReplicaSet", on or rs.metadata.name)
    except Exception:  # noqa: BLE001
        pass
    return out


def _top_owner(pod, rs_map: dict) -> tuple[str, str]:
    """파드 → 최상위 워크로드 (kind, name).

    rs_map 에 ReplicaSet 이 있으면 정확히 Deployment 로 귀속, 없으면 이름 해시 strip 으로
    Deployment 명을 근사(대규모 클러스터에서 RS 전량 조회를 피하기 위함). 컨트롤러 없으면 Pod.
    """
    kind, name = _direct_owner(pod.metadata)
    if kind is None:
        return "Pod", pod.metadata.name
    if kind == "ReplicaSet":
        ns = pod.metadata.namespace
        if (ns, name) in rs_map:
            return rs_map[(ns, name)]
        return "Deployment", _strip_hash(name)
    return kind, name


# ── 응답 모델 ────────────────────────────────────────────────────────────────────
class NodeAllocRow(BaseModel):
    name: str
    roles: list[str] = []
    unschedulable: bool = False
    pod_count: int = 0
    pods_allocatable: int = 0     # 노드 max-pods(allocatable["pods"], 보통 110). 0=미상
    cpu_alloc_m: int = 0
    mem_alloc_b: int = 0
    cpu_capacity_m: int = 0
    mem_capacity_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_slack_m: int = 0          # alloc - requests
    mem_slack_b: int = 0
    cpu_alloc_display: str = "0"
    mem_alloc_display: str = "0"
    cpu_usage_display: Optional[str] = None
    mem_usage_display: Optional[str] = None
    cpu_req_display: str = "0"
    mem_req_display: str = "0"
    cpu_lim_display: str = "0"
    mem_lim_display: str = "0"


class AllocSummary(BaseModel):
    node_count: int = 0
    namespace_count: int = 0
    pod_count: int = 0
    cpu_alloc_m: int = 0
    mem_alloc_b: int = 0
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    no_request_pods: int = 0   # request 0 인 파드 수


class NamespaceAllocRow(BaseModel):
    namespace: str
    pod_count: int = 0
    workload_count: int = 0
    no_request_pods: int = 0
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    cpu_req_display: str = "0"
    mem_req_display: str = "0"
    cpu_lim_display: str = "0"
    mem_lim_display: str = "0"
    cpu_usage_display: Optional[str] = None
    mem_usage_display: Optional[str] = None


class WorkloadAllocRow(BaseModel):
    namespace: str
    kind: str
    name: str
    pod_count: int = 0
    no_request_pods: int = 0
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None


class ContainerAllocCell(BaseModel):
    name: str
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None
    has_requests: bool = False


class PodAllocRow(BaseModel):
    name: str
    namespace: str
    node: Optional[str] = None
    qos: Optional[str] = None
    phase: str = "-"
    containers: list[ContainerAllocCell] = []
    cpu_req_m: int = 0
    mem_req_b: int = 0
    cpu_lim_m: int = 0
    mem_lim_b: int = 0
    cpu_usage_m: Optional[int] = None
    mem_usage_b: Optional[int] = None


# ── 공유 스냅샷 (노드 + 네임스페이스 집계) ──────────────────────────────────────────
# 부분 결과 publish 주기(초) — 너무 잦으면 직렬화 부하, 너무 길면 누적 체감 저하.
# Redis 공유 스토어일 때는 왕복 비용이 있어 2초로 늘린다(_overview_view 에서 결정).
_PARTIAL_PUBLISH_INTERVAL = 1.0
_PARTIAL_PUBLISH_INTERVAL_SHARED = 2.0
# 종료(Succeeded/Failed) 파드까지 순회해 POD 상태 카운트를 같은 스냅샷에서 계산할지.
# 0 이면 구 동작(활성 파드만 서버측 필터) — 완료 Job 파드가 수만 개 쌓인 클러스터용 탈출구.
_COUNT_TERMINAL_PODS = os.getenv("K8S_ALLOC_COUNT_TERMINAL_PODS", "1") not in ("0", "false", "no")

_POD_STATUS_KEYS = ("running", "pending", "error", "succeeded", "failed", "unknown")


def _empty_pod_summary() -> dict:
    return {"total_pods": 0, "status_counts": {k: 0 for k in _POD_STATUS_KEYS},
            "occupied_on_schedulable": 0, "terminal_counted": _COUNT_TERMINAL_PODS}


def _assemble_overview(node_base, per_node, per_ns, node_usage, summary, ns_total, *,
                       metrics_available: bool, pod_usage_skipped: bool, partial: bool,
                       pod_summary: Optional[dict] = None) -> dict:
    """누적/최종 결과를 직렬화 가능한 안정 스냅샷으로 조립(**accumulator 비파괴**).

    per_node/per_ns 는 복사본을 만들어 반환하므로, 빌더가 계속 집계해도 이미 publish 된
    부분 결과가 변형되지 않는다(요청 스레드 직렬화 중 RuntimeError 방지). node_base/node_usage
    는 pod 루프 이후 변형되지 않으므로 참조 공유해도 안전하다.
    """
    cpu_alloc = sum(nb["cpu_alloc"] for nb in node_base.values())
    mem_alloc = sum(nb["mem_alloc"] for nb in node_base.values())
    out_node = {k: dict(v) for k, v in per_node.items()}
    out_ns = {
        ns: {
            "rc": s["rc"], "rm": s["rm"], "lc": s["lc"], "lm": s["lm"],
            "uc": s["uc"], "um": s["um"], "pods": s["pods"], "norq": s["norq"],
            "has_usage": s["has_usage"], "workload_count": len(s["owners"]),
        }
        for ns, s in per_ns.items()
    }
    return {
        "node_base": node_base,
        "per_node": out_node,
        "node_usage": node_usage,
        "per_ns": out_ns,
        "summary": {
            "node_count": len(node_base), "namespace_count": ns_total, "pod_count": summary["pods"],
            "cpu_alloc_m": cpu_alloc, "mem_alloc_b": mem_alloc,
            "cpu_req_m": summary["rc"], "mem_req_b": summary["rm"],
            "cpu_lim_m": summary["lc"], "mem_lim_b": summary["lm"],
            "cpu_usage_m": (summary["uc"] if metrics_available else None),
            "mem_usage_b": (summary["um"] if metrics_available else None),
            "no_request_pods": summary["norq"],
        },
        "metrics_available": metrics_available,
        "pod_usage_skipped": pod_usage_skipped,
        "partial": partial,
        "pods_summary": dict(pod_summary) if pod_summary else _empty_pod_summary(),
    }


def _node_ready(n) -> bool:
    conds = (n.status.conditions or []) if n.status else []
    return any(getattr(c, "type", None) == "Ready" and getattr(c, "status", None) == "True"
               for c in conds)


def _build_overview(cluster, progress: Optional[Progress] = None, *,
                    on_pod: Optional[Callable[[Any, tuple[int, int, int, int], tuple[str, str]], None]] = None,
                    publish_interval: Optional[float] = None) -> dict:
    """단일 Pod 순회로 노드/네임스페이스 집계를 모두 계산. 결과는 작은 숫자 dict 만 캐시.

    반환: {node_base, per_node, node_usage, per_ns, summary, ns_total,
           metrics_available, pod_usage_skipped, pods_summary}

    백그라운드 스냅샷 매니저에서 호출되므로 게이트웨이 타임아웃과 무관 — **전수 집계를
    끝까지 수행**해 무결성을 보장한다(시간 예산으로 자르지 않고, 폭주 방지용 hard_cap 만
    유지). progress 가 주어지면 Pod 처리량을 보고한다.

    on_pod(pod, (rc,rm,lc,lm), (owner_kind, owner_name)) 콜백을 주면 활성 파드마다 호출된다 —
    수집 워커(k8s_efficiency)가 워크로드 단위 집계를 **같은 순회**에서 얻기 위한 훅.
    POD 상태 카운트(pods_summary)도 이 순회에서 함께 계산해 별도의 전수 Pod 조회를 없앤다.
    """
    pub_every = publish_interval if publish_interval is not None else _PARTIAL_PUBLISH_INTERVAL
    with _api(cluster) as client:
        core = k8s_client.CoreV1Api(client)
        partial_flag: list = []

        # 노드/NS 목록은 작으므로 watch cache(resource_version="0")에서 싸게 읽는다.
        # (Pod 순회에는 절대 쓰지 않는다 — RV=0 은 limit 을 무시해 전량 단일 응답 → OOM.)
        nodes = _list_all(lambda **kw: core.list_node(**kw), report=partial_flag,
                          resource_version="0")
        if progress is not None:
            progress.phase = "nodes"
        node_usage = _node_usage(client)
        ns_total = len(_list_all(lambda **kw: core.list_namespace(**kw), resource_version="0"))
        if progress is not None:
            progress.phase = "pods"

        # 노드 base (allocatable/capacity/roles) — raw 객체는 보관 안 함.
        node_base: dict[str, dict] = {}
        schedulable_nodes: set[str] = set()
        for n in nodes:
            labels = n.metadata.labels or {}
            alloc = (n.status.allocatable or {}) if n.status else {}
            cap = (n.status.capacity or {}) if n.status else {}
            unsched = bool(n.spec.unschedulable) if n.spec else False
            ready = _node_ready(n)
            node_base[n.metadata.name] = {
                "roles": _node_roles(labels),
                "unschedulable": unsched,
                "ready": ready,
                "cpu_alloc": _cpu_m(alloc.get("cpu")), "mem_alloc": _mem_b(alloc.get("memory")),
                "cpu_cap": _cpu_m(cap.get("cpu")), "mem_cap": _mem_b(cap.get("memory")),
                "pods_alloc": _pods_n(alloc.get("pods")),
            }
            if ready and not unsched:
                schedulable_nodes.add(n.metadata.name)

        per_node: dict[str, dict] = {}
        per_ns: dict[str, dict] = {}
        summary = {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0, "pods": 0, "norq": 0}
        pod_summary = _empty_pod_summary()
        status_counts = pod_summary["status_counts"]

        # Pod 를 **페이지 단위로 스트리밍**하며 즉시 집계(전량 메모리 적재 금지 → OOM/502 방지).
        # 약 1초마다 부분 결과를 progress.partial 로 publish → 프론트가 누적 표시.
        last_pub = time.monotonic()
        pod_selector = None if _COUNT_TERMINAL_PODS else _ACTIVE_FIELD_SELECTOR
        for p in _iter_all(lambda **kw: core.list_pod_for_all_namespaces(**kw),
                           field_selector=pod_selector, report=partial_flag):
            if progress is not None:
                progress.processed += 1
            # POD 상태 카운트 — 종료 파드 포함(구 pods-summary 와 동일 버킷).
            pod_summary["total_pods"] += 1
            status_counts[_classify_pod_status(p)] += 1
            phase = p.status.phase if p.status else None
            node = p.spec.node_name if p.spec else None
            if phase not in _TERMINAL_PHASES and node in schedulable_nodes:
                pod_summary["occupied_on_schedulable"] += 1
            if phase not in _ACTIVE_PHASES:
                continue
            ns = p.metadata.namespace
            rc, rm, lc, lm = _pod_effective_resources(p.spec)
            no_req = (rc == 0 and rm == 0)
            owner = _top_owner(p, {})  # 대규모 보호: RS 전량 미조회(해시 strip 근사)
            if on_pod is not None:
                try:
                    on_pod(p, (rc, rm, lc, lm), owner)
                except Exception:  # noqa: BLE001
                    logger.exception("on_pod 콜백 실패(무시): %s/%s", ns, p.metadata.name)

            # per-namespace
            s = per_ns.setdefault(ns, {
                "rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0,
                "pods": 0, "norq": 0, "owners": set(), "has_usage": False,
            })
            s["rc"] += rc; s["rm"] += rm; s["lc"] += lc; s["lm"] += lm
            s["pods"] += 1
            s["owners"].add(owner)
            if no_req:
                s["norq"] += 1

            # per-node (request/limit 합산. usage 는 노드 metrics(node_usage) 사용)
            if node and node in node_base:
                ag = per_node.setdefault(node, {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0})
                ag["rc"] += rc; ag["rm"] += rm; ag["lc"] += lc; ag["lm"] += lm
                ag["pods"] += 1

            # summary
            summary["rc"] += rc; summary["rm"] += rm; summary["lc"] += lc; summary["lm"] += lm
            summary["pods"] += 1
            if no_req:
                summary["norq"] += 1

            # 부분 결과 publish(usage 미반영=pending). accumulator 비파괴 복사로 안전.
            if progress is not None:
                now = time.monotonic()
                if now - last_pub >= pub_every:
                    progress.partial = _assemble_overview(
                        node_base, per_node, per_ns, node_usage, summary, ns_total,
                        metrics_available=False, pod_usage_skipped=True, partial=bool(partial_flag),
                        pod_summary=pod_summary,
                    )
                    last_pub = now

        partial = bool(partial_flag)
        # cluster-wide pod usage — namespace 단위로 합산(NS 랭킹 실사용 표시). best-effort.
        # 활성 Pod 가 _POD_USAGE_MAX 를 넘으면 생략 — metrics 단일 응답이 타임아웃만 반복하는
        # 초대형 클러스터 보호(드릴다운에서 NS 단위로 정확히 확인 가능).
        usage_skipped = summary["pods"] > _POD_USAGE_MAX
        if usage_skipped:
            logger.info("cluster-wide pod usage 생략: 활성 Pod %d > %d",
                        summary["pods"], _POD_USAGE_MAX)
            pu = {}
        else:
            pu = _pod_usage(client)
        metrics_available = bool(pu)
        for (ns, _pod), u in pu.items():
            cpu, mem = u["cpu"], u["mem"]
            if ns in per_ns:
                per_ns[ns]["uc"] += cpu; per_ns[ns]["um"] += mem; per_ns[ns]["has_usage"] = True
            summary["uc"] += cpu; summary["um"] += mem

        return _assemble_overview(
            node_base, per_node, per_ns, node_usage, summary, ns_total,
            metrics_available=metrics_available,
            pod_usage_skipped=(usage_skipped or not metrics_available), partial=partial,
            pod_summary=pod_summary,
        )


# 비싼 overview 집계는 백그라운드 스냅샷 매니저로 수행(요청 스레드 비블로킹 → 502 방지).
# TTL 을 길게 둬서 완료된 결과를 **그대로 유지**한다. 재집계는 오직 명시적 refresh(force)
# 일 때만 — 자동갱신 OFF 면 0부터 다시 누적하는 일이 없도록(누적 결과 보존).
_OVERVIEW_TTL = _envf("K8S_ALLOC_OVERVIEW_TTL", 86400.0)
# 스냅샷 저장소: auto(Redis 가능하면 replica 간 공유, 아니면 프로세스 메모리) | redis | memory.
# 멀티 replica(HPA) 환경에서 memory 면 폴링이 파드마다 다른 진행률/결과를 보게 된다(BE-15).
_SNAPSHOT_BACKEND = (os.getenv("K8S_ALLOC_SNAPSHOT_BACKEND") or "auto").strip().lower()
_overview_mgr = SnapshotManager(ttl=_OVERVIEW_TTL, partial_ttl=_PARTIAL_TTL,
                                stuck_timeout=_STUCK_TIMEOUT, backend=_SNAPSHOT_BACKEND,
                                publish_interval=_PARTIAL_PUBLISH_INTERVAL)


def _overview_view(cluster_id: UUID, db: Session, force: bool = False) -> dict:
    """매니저 뷰 반환: {status, progress, processed, total, data(overview|None), stale, error}.
    force=True 면(명시적 새로고침/주기 갱신) 캐시를 무시하고 재집계."""
    cluster = _require_cluster(cluster_id, db)
    cid = str(cluster_id)
    # kubeconfig 파일을 요청 스레드에서 미리 구체화(백그라운드 스레드의 detached 인스턴스 접근 회피).
    try:
        ensure_kubeconfig_file(cluster)
    except Exception:  # noqa: BLE001
        pass
    pub = _PARTIAL_PUBLISH_INTERVAL_SHARED if _overview_mgr.is_shared else _PARTIAL_PUBLISH_INTERVAL
    return _overview_mgr.get(
        f"{cid}:overview",
        lambda prog: _build_overview(cluster, prog, publish_interval=pub),
        force=force,
    )


def overview_snapshot_key(cluster_id) -> str:
    return f"{cluster_id}:overview"


def warm_overview_snapshot(cluster_id, overview: dict, processed: Optional[int] = None) -> None:
    """수집 워커가 만든 완성 overview 를 스냅샷으로 등록(공유 스토어면 모든 replica 에 즉시 반영)."""
    _overview_mgr.put(overview_snapshot_key(cluster_id), overview, processed=processed)


# ── 엔드포인트 ───────────────────────────────────────────────────────────────────
def _alloc_meta(view: dict) -> dict:
    """집계 진행 상태 메타(프론트 진행률 표시·폴링 제어용)."""
    return {
        "status": view["status"],         # computing | ready | error
        "progress": view["progress"],     # 0..1 또는 null(불확정)
        "processed": view["processed"],
        "total": view["total"],
        "stale": view["stale"],
        "partial": view.get("partial", False),  # 부분(누적) 결과 여부
    }


def _node_row(name: str, nb: dict, ag: dict, u) -> NodeAllocRow:
    """node_base 항목(nb) + per_node 집계(ag) + 노드 usage 튜플(u)로 NodeAllocRow 조립."""
    cpu_alloc, mem_alloc = nb["cpu_alloc"], nb["mem_alloc"]
    return NodeAllocRow(
        name=name, roles=nb["roles"], unschedulable=nb["unschedulable"],
        pod_count=ag.get("pods", 0),
        pods_allocatable=nb.get("pods_alloc", 0),
        cpu_alloc_m=cpu_alloc, mem_alloc_b=mem_alloc,
        cpu_capacity_m=nb["cpu_cap"], mem_capacity_b=nb["mem_cap"],
        cpu_usage_m=(u[0] if u else None), mem_usage_b=(u[1] if u else None),
        cpu_req_m=ag["rc"], mem_req_b=ag["rm"], cpu_lim_m=ag["lc"], mem_lim_b=ag["lm"],
        cpu_slack_m=cpu_alloc - ag["rc"], mem_slack_b=mem_alloc - ag["rm"],
        cpu_alloc_display=_fmt_cpu(cpu_alloc), mem_alloc_display=_fmt_mem(mem_alloc),
        cpu_usage_display=(_fmt_cpu(u[0]) if u else None),
        mem_usage_display=(_fmt_mem(u[1]) if u else None),
        cpu_req_display=_fmt_cpu(ag["rc"]), mem_req_display=_fmt_mem(ag["rm"]),
        cpu_lim_display=_fmt_cpu(ag["lc"]), mem_lim_display=_fmt_mem(ag["lm"]),
    )


@router.get("/{cluster_id}/allocation/nodes")
def allocation_nodes(cluster_id: UUID, refresh: bool = False, db: Session = Depends(get_db)):
    """노드별 allocatable/capacity vs usage vs request/limit + slack. (요구 1·2)
    refresh=True 면 캐시 무시 재집계(명시적 새로고침/주기 갱신)."""
    view = _overview_view(cluster_id, db, force=refresh)
    ov = view["data"]
    if ov is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"자원 집계 실패: {view['error']}")
        return {"count": 0, "items": [], "metrics_available": False,
                "partial": False, **_alloc_meta(view)}
    node_base = ov["node_base"]
    per_node = ov["per_node"]
    node_usage = ov["node_usage"]

    empty_ag = {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0}
    rows = [_node_row(name, nb, per_node.get(name, empty_ag), node_usage.get(name))
            for name, nb in node_base.items()]
    rows.sort(key=lambda r: r.name)
    return {"count": len(rows), "items": rows, "metrics_available": bool(node_usage),
            "partial": ov.get("partial", False), **_alloc_meta(view)}


@router.get("/{cluster_id}/allocation/nodes/{node}")
def allocation_node_refresh(cluster_id: UUID, node: str, db: Session = Depends(get_db)):
    """단일 노드만 즉시 재계산(개별 REFRESH). 스냅샷 미경유 — 그 노드의 활성 파드만 조회. (요구 3)"""
    cluster = _require_cluster(cluster_id, db)
    with _api(cluster) as client:
        core = k8s_client.CoreV1Api(client)
        try:
            n = core.read_node(node, _request_timeout=_API_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            code = 404 if "not found" in msg or '"code":404' in msg or "(404)" in msg else 502
            raise HTTPException(status_code=code, detail=f"노드 조회 실패: {node}") from e

        labels = n.metadata.labels or {}
        alloc = (n.status.allocatable or {}) if n.status else {}
        cap = (n.status.capacity or {}) if n.status else {}
        nb = {
            "roles": _node_roles(labels),
            "unschedulable": bool(n.spec.unschedulable) if n.spec else False,
            "cpu_alloc": _cpu_m(alloc.get("cpu")), "mem_alloc": _mem_b(alloc.get("memory")),
            "cpu_cap": _cpu_m(cap.get("cpu")), "mem_cap": _mem_b(cap.get("memory")),
            "pods_alloc": _pods_n(alloc.get("pods")),
        }
        fs = f"spec.nodeName={node},{_ACTIVE_FIELD_SELECTOR}"
        try:
            pods = _list_all(lambda **kw: core.list_pod_for_all_namespaces(**kw), field_selector=fs)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}") from e
        ag = {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0}
        for p in pods:
            if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
                continue
            rc, rm, lc, lm = _pod_effective_resources(p.spec)
            ag["rc"] += rc; ag["rm"] += rm; ag["lc"] += lc; ag["lm"] += lm; ag["pods"] += 1
        u = _node_usage_one(client, node)
        return {"item": _node_row(node, nb, ag, u), "metrics_available": bool(u)}


def _pods_summary_payload(ov: dict) -> dict:
    """스냅샷 overview → 구 `GET /k8s/{id}/pods-summary` 와 동일한 응답 형태."""
    node_base = ov.get("node_base") or {}
    ps = ov.get("pods_summary") or _empty_pod_summary()
    allocatable_total = 0
    schedulable_allocatable = 0
    schedulable = 0
    for nb in node_base.values():
        alloc = int(nb.get("pods_alloc") or 0)
        allocatable_total += alloc
        if nb.get("ready") and not nb.get("unschedulable"):
            schedulable += 1
            schedulable_allocatable += alloc
    return {
        "total_pods": ps.get("total_pods", 0),
        "status_counts": ps.get("status_counts") or {k: 0 for k in _POD_STATUS_KEYS},
        "capacity": {
            "allocatable_pods": allocatable_total,
            "schedulable_allocatable_pods": schedulable_allocatable,
            "schedulable_free_slots": max(0, schedulable_allocatable - int(ps.get("occupied_on_schedulable") or 0)),
            "nodes_total": len(node_base),
            "nodes_schedulable": schedulable,
        },
        "terminal_counted": bool(ps.get("terminal_counted", _COUNT_TERMINAL_PODS)),
    }


@router.get("/{cluster_id}/allocation/pods-summary")
def allocation_pods_summary(cluster_id: UUID, refresh: bool = False, db: Session = Depends(get_db)):
    """POD 용량/상태 카드 — **개요 스냅샷에서 파생**(요청 스레드가 apiserver 를 치지 않는다).

    구 `GET /k8s/{id}/pods-summary` 는 전체 Pod 를 페이징 없이 60초 요청 하나로 긁어 ingress
    타임아웃(60s)과 정확히 겹쳐 502 가 났고, 같은 화면이 allocation 스냅샷과 별개로 전수
    순회를 한 번 더 하는 구조였다. 이제 같은 순회에서 상태 카운트까지 계산한다.
    """
    view = _overview_view(cluster_id, db, force=refresh)
    ov = view["data"]
    if ov is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"자원 집계 실패: {view['error']}")
        return {**_pods_summary_payload({}), **_alloc_meta(view)}
    return {**_pods_summary_payload(ov), **_alloc_meta(view)}


def _ns_row(ns: str, s: dict) -> NamespaceAllocRow:
    """per_ns 집계(s) → NamespaceAllocRow."""
    return NamespaceAllocRow(
        namespace=ns,
        pod_count=s["pods"], workload_count=s.get("workload_count", 0),
        no_request_pods=s["norq"],
        cpu_req_m=s["rc"], mem_req_b=s["rm"], cpu_lim_m=s["lc"], mem_lim_b=s["lm"],
        cpu_usage_m=(s["uc"] if s["has_usage"] else None),
        mem_usage_b=(s["um"] if s["has_usage"] else None),
        cpu_req_display=_fmt_cpu(s["rc"]), mem_req_display=_fmt_mem(s["rm"]),
        cpu_lim_display=_fmt_cpu(s["lc"]), mem_lim_display=_fmt_mem(s["lm"]),
        cpu_usage_display=(_fmt_cpu(s["uc"]) if s["has_usage"] else None),
        mem_usage_display=(_fmt_mem(s["um"]) if s["has_usage"] else None),
    )


@router.get("/{cluster_id}/allocation/namespaces")
def allocation_namespaces(cluster_id: UUID, refresh: bool = False, db: Session = Depends(get_db)):
    """네임스페이스별 request/limit/usage 총합 + 클러스터 summary. (요구 3)
    refresh=True 면 캐시 무시 재집계."""
    view = _overview_view(cluster_id, db, force=refresh)
    ov = view["data"]
    if ov is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"자원 집계 실패: {view['error']}")
        return {"count": 0, "items": [], "summary": AllocSummary().model_dump(),
                "metrics_available": False, "pod_usage_skipped": False,
                "partial": False, **_alloc_meta(view)}
    per_ns = ov["per_ns"]

    rows = [_ns_row(ns, s) for ns, s in per_ns.items()]
    rows.sort(key=lambda r: r.cpu_req_m, reverse=True)
    return {
        "count": len(rows),
        "items": rows,
        "summary": AllocSummary(**ov["summary"]),
        "metrics_available": ov["metrics_available"],
        "pod_usage_skipped": ov["pod_usage_skipped"],
        "partial": ov.get("partial", False),
        **_alloc_meta(view),
    }


@router.get("/{cluster_id}/allocation/namespaces/{namespace}")
def allocation_namespace_refresh(cluster_id: UUID, namespace: str, db: Session = Depends(get_db)):
    """단일 네임스페이스만 즉시 재계산(개별 REFRESH). 스냅샷 미경유 — 그 NS 활성 파드만 조회."""
    cluster = _require_cluster(cluster_id, db)
    with _api(cluster) as client:
        core = k8s_client.CoreV1Api(client)
        apps = k8s_client.AppsV1Api(client)
        try:
            pods = _list_all(lambda **kw: core.list_namespaced_pod(namespace, **kw),
                             field_selector=_ACTIVE_FIELD_SELECTOR)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}") from e
        rs_map = _build_rs_owner_map(apps, namespace)
        pusage = _pod_usage(client, namespace)  # best-effort
        s = {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0,
             "pods": 0, "norq": 0, "owners": set(), "has_usage": False}
        for p in pods:
            if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
                continue
            rc, rm, lc, lm = _pod_effective_resources(p.spec)
            s["rc"] += rc; s["rm"] += rm; s["lc"] += lc; s["lm"] += lm; s["pods"] += 1
            if rc == 0 and rm == 0:
                s["norq"] += 1
            s["owners"].add(_top_owner(p, rs_map))
            u = pusage.get((namespace, p.metadata.name))
            if u:
                s["uc"] += u["cpu"]; s["um"] += u["mem"]; s["has_usage"] = True
        s["workload_count"] = len(s["owners"])
        return {"item": _ns_row(namespace, s), "metrics_available": bool(pusage)}


@router.get("/{cluster_id}/allocation/namespaces/{namespace}/workloads")
def allocation_workloads(cluster_id: UUID, namespace: str, db: Session = Depends(get_db)):
    """NS 내 상위 워크로드(Deployment/STS/DS/RS/Job/…) 단위 집계. (요구 4-1)"""
    cluster = _require_cluster(cluster_id, db)
    cid = str(cluster_id)
    with _api(cluster) as client:
        core = k8s_client.CoreV1Api(client)
        apps = k8s_client.AppsV1Api(client)
        try:
            pods = _cached(f"{cid}:nspods:{namespace}",
                           lambda: _list_all(lambda **kw: core.list_namespaced_pod(namespace, **kw),
                                             field_selector=_ACTIVE_FIELD_SELECTOR))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}") from e

        pusage = _cached(f"{cid}:nspu:{namespace}", lambda: _pod_usage(client, namespace))
        rs_map = _cached(f"{cid}:rs:{namespace}", lambda: _build_rs_owner_map(apps, namespace))

        groups: dict[tuple[str, str], dict] = {}
        for p in pods:
            if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
                continue
            kind, name = _top_owner(p, rs_map)
            rc, rm, lc, lm = _pod_effective_resources(p.spec)
            um = pusage.get((namespace, p.metadata.name))
            g = groups.setdefault((kind, name), {
                "rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0,
                "pods": 0, "norq": 0, "has_usage": False,
            })
            g["rc"] += rc; g["rm"] += rm; g["lc"] += lc; g["lm"] += lm
            g["pods"] += 1
            if rc == 0 and rm == 0:
                g["norq"] += 1
            if um:
                g["uc"] += um["cpu"]; g["um"] += um["mem"]; g["has_usage"] = True

        rows: list[WorkloadAllocRow] = []
        for (kind, name), g in groups.items():
            rows.append(WorkloadAllocRow(
                namespace=namespace, kind=kind, name=name,
                pod_count=g["pods"], no_request_pods=g["norq"],
                cpu_req_m=g["rc"], mem_req_b=g["rm"], cpu_lim_m=g["lc"], mem_lim_b=g["lm"],
                cpu_usage_m=(g["uc"] if g["has_usage"] else None),
                mem_usage_b=(g["um"] if g["has_usage"] else None),
            ))
        rows.sort(key=lambda r: r.cpu_req_m, reverse=True)
        return {"count": len(rows), "items": rows, "metrics_available": bool(pusage)}


@router.get("/{cluster_id}/allocation/namespaces/{namespace}/workloads/{kind}/{name}/pods")
def allocation_pods(
    cluster_id: UUID,
    namespace: str,
    kind: str,
    name: str,
    db: Session = Depends(get_db),
):
    """워크로드 소속 파드 + 컨테이너 단위 request/limit/usage. (요구 4-2)"""
    cluster = _require_cluster(cluster_id, db)
    cid = str(cluster_id)
    with _api(cluster) as client:
        core = k8s_client.CoreV1Api(client)
        apps = k8s_client.AppsV1Api(client)
        try:
            pods = _cached(f"{cid}:nspods:{namespace}",
                           lambda: _list_all(lambda **kw: core.list_namespaced_pod(namespace, **kw),
                                             field_selector=_ACTIVE_FIELD_SELECTOR))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}") from e

        pusage = _cached(f"{cid}:nspu:{namespace}", lambda: _pod_usage(client, namespace))
        rs_map = _cached(f"{cid}:rs:{namespace}", lambda: _build_rs_owner_map(apps, namespace))

        rows: list[PodAllocRow] = []
        for p in pods:
            # 활성 phase 만 — 워크로드 목록(allocation_workloads)의 pod_count 와 일치시킨다.
            if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
                continue
            ok, on = _top_owner(p, rs_map)
            if ok != kind or on != name:
                continue
            cmap = (pusage.get((namespace, p.metadata.name)) or {}).get("containers", {})
            cells: list[ContainerAllocCell] = []
            prc = prm = plc = plm = puc = pum = 0
            has_usage = False
            # 사이드카(init, restartPolicy=Always)도 상주 컨테이너이므로 일반 컨테이너와
            # 함께 표시·합산한다(_pod_effective_resources 의 총합과 정합성 유지).
            display_containers = list(p.spec.containers if p.spec else [])
            display_containers += _sidecar_containers(p.spec)
            for c in display_containers:
                res = getattr(c, "resources", None)
                req = (res.requests or {}) if res else {}
                lim = (res.limits or {}) if res else {}
                crc, crm = _cpu_m(req.get("cpu")), _mem_b(req.get("memory"))
                clc, clm = _cpu_m(lim.get("cpu")), _mem_b(lim.get("memory"))
                cu = cmap.get(c.name)
                cells.append(ContainerAllocCell(
                    name=c.name, cpu_req_m=crc, mem_req_b=crm, cpu_lim_m=clc, mem_lim_b=clm,
                    cpu_usage_m=(cu[0] if cu else None), mem_usage_b=(cu[1] if cu else None),
                    has_requests=(crc > 0 or crm > 0),
                ))
                prc += crc; prm += crm; plc += clc; plm += clm
                if cu:
                    puc += cu[0]; pum += cu[1]; has_usage = True
            rows.append(PodAllocRow(
                name=p.metadata.name, namespace=namespace,
                node=(p.spec.node_name if p.spec else None),
                qos=(p.status.qos_class if p.status else None),
                phase=(p.status.phase if p.status else "-") or "-",
                containers=cells,
                cpu_req_m=prc, mem_req_b=prm, cpu_lim_m=plc, mem_lim_b=plm,
                cpu_usage_m=(puc if has_usage else None), mem_usage_b=(pum if has_usage else None),
            ))
        rows.sort(key=lambda r: r.name)
        return {"count": len(rows), "items": rows, "metrics_available": bool(pusage)}
