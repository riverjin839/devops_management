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
import re
import time
from decimal import Decimal
from typing import Any, Callable, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from kubernetes import client as k8s_client
from kubernetes.utils import parse_quantity
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.k8s_resources import _api_client, _require_cluster
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

# K8s API 호출 서버측 타임아웃(connect, read) 초 — 느린 apiserver/metrics 가 프록시
# 타임아웃(502)을 유발하지 않도록 빨리 실패시킨다.
_API_TIMEOUT = (3.05, 30)
_METRICS_TIMEOUT = (3.05, 12)  # metrics-server 는 더 짧게 — 느리면 usage 생략(best-effort)
_PAGE_LIMIT = 1000             # 페이지네이션 페이지 크기(round-trip 수 ↓)
# cluster-wide pod usage(metrics) 는 활성 Pod 가 이 수 이하일 때만 시도(대규모 클러스터 보호).
_POD_USAGE_MAX = 6000
# 전체 스냅샷(전량 페이지네이션 포함) 총 벽시계 예산(초). ingress/proxy 타임아웃(보통 30~60s)
# 보다 짧게 잡아, 초대형 클러스터에서도 502(프록시 타임아웃) 대신 partial 결과로 반드시 응답한다.
_SNAPSHOT_BUDGET = 22.0

# 비싼 집계 스냅샷에 대한 짧은 TTL 캐시(클러스터/네임스페이스 키별 격리).
_CACHE_TTL = 20.0
_CACHE: dict[str, tuple[float, Any]] = {}


def _cached(key: str, producer: Callable[[], Any]) -> Any:
    """key 가 TTL 내면 캐시 반환, 아니면 producer() 실행 후 캐시. 예외는 캐시 안 함."""
    now = time.monotonic()
    hit = _CACHE.get(key)
    if hit is not None and (now - hit[0]) < _CACHE_TTL:
        return hit[1]
    val = producer()
    _CACHE[key] = (now, val)
    return val


def _list_all(list_fn: Callable[..., Any], *, field_selector: Optional[str] = None,
              hard_cap: int = 200_000, deadline: Optional[float] = None,
              report: Optional[list] = None) -> list:
    """`_continue` 페이지네이션으로 전량 수집. 각 페이지에 서버측 타임아웃 적용.

    deadline(monotonic 시각) 지정 시 페이지 사이에서 예산을 초과하면 **수집을 중단**하고
    지금까지 모은 항목만 반환한다(초대형 클러스터에서 프록시 502 대신 partial 응답).
    중단/상한 도달 시 report(있으면)에 True 를 append 해 호출자가 partial 여부를 안다.
    """
    items: list = []
    cont: Optional[str] = None
    truncated = False
    while True:
        kw: dict[str, Any] = {"limit": _PAGE_LIMIT, "_request_timeout": _API_TIMEOUT}
        if field_selector:
            kw["field_selector"] = field_selector
        if cont:
            kw["_continue"] = cont
        resp = list_fn(**kw)
        items.extend(resp.items or [])
        cont = getattr(resp.metadata, "_continue", None) if resp.metadata else None
        if not cont:
            break
        if len(items) >= hard_cap or (deadline is not None and time.monotonic() >= deadline):
            truncated = True
            break
    if truncated and report is not None:
        report.append(True)
    return items


def _strip_hash(rs_name: str) -> str:
    """ReplicaSet 이름에서 pod-template-hash 접미사 제거 → Deployment 이름 추정(폴백)."""
    return re.sub(r"-[a-f0-9]{8,10}$", "", rs_name)


# ── 수량 파싱/표시 ──────────────────────────────────────────────────────────────
def _cpu_m(v) -> int:
    """CPU 수량 문자열 → millicores(int). 빈 값/파싱 실패 시 0."""
    if not v:
        return 0
    try:
        return int(Decimal(parse_quantity(v)) * 1000)
    except Exception:  # noqa: BLE001
        return 0


def _mem_b(v) -> int:
    """메모리 수량 문자열 → bytes(int). 빈 값/파싱 실패 시 0."""
    if not v:
        return 0
    try:
        return int(Decimal(parse_quantity(v)))
    except Exception:  # noqa: BLE001
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
def _build_overview(cluster, cid: str) -> dict:
    """단일 Pod 순회로 노드/네임스페이스 집계를 모두 계산. 결과는 작은 숫자 dict 만 캐시.

    반환: {node_base, per_node, node_usage, per_ns, summary, ns_total,
           metrics_available, pod_usage_skipped}
    """
    client = _api_client(cluster)
    core = k8s_client.CoreV1Api(client)

    # 전체 스냅샷 벽시계 예산 — 초과 시 Pod 전량 페이지네이션을 중단하고 partial 응답.
    deadline = time.monotonic() + _SNAPSHOT_BUDGET
    partial_flag: list = []

    nodes = _list_all(lambda **kw: core.list_node(**kw), deadline=deadline)
    node_usage = _node_usage(client)
    ns_total = len(_list_all(lambda **kw: core.list_namespace(**kw), deadline=deadline))
    pods = _list_all(lambda **kw: core.list_pod_for_all_namespaces(**kw),
                     field_selector=_ACTIVE_FIELD_SELECTOR,
                     deadline=deadline, report=partial_flag)

    # 노드 base (allocatable/capacity/roles) — raw 객체는 보관 안 함.
    node_base: dict[str, dict] = {}
    for n in nodes:
        labels = n.metadata.labels or {}
        alloc = (n.status.allocatable or {}) if n.status else {}
        cap = (n.status.capacity or {}) if n.status else {}
        node_base[n.metadata.name] = {
            "roles": _node_roles(labels),
            "unschedulable": bool(n.spec.unschedulable) if n.spec else False,
            "cpu_alloc": _cpu_m(alloc.get("cpu")), "mem_alloc": _mem_b(alloc.get("memory")),
            "cpu_cap": _cpu_m(cap.get("cpu")), "mem_cap": _mem_b(cap.get("memory")),
        }

    per_node: dict[str, dict] = {}
    per_ns: dict[str, dict] = {}
    summary = {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "uc": 0, "um": 0, "pods": 0, "norq": 0}
    pod_loc: dict[tuple[str, str], tuple[str, Optional[str]]] = {}  # (ns,pod)->(ns,node)

    for p in pods:
        if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
            continue
        ns = p.metadata.namespace
        node = p.spec.node_name if p.spec else None
        rc, rm, lc, lm = _sum_resources(p.spec.containers if p.spec else [])
        no_req = (rc == 0 and rm == 0)
        owner = _top_owner(p, {})  # 대규모 보호: RS 전량 미조회(해시 strip 근사)

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

        # per-node
        if node and node in node_base:
            ag = per_node.setdefault(node, {"rc": 0, "rm": 0, "lc": 0, "lm": 0,
                                            "uc": 0, "um": 0, "pods": 0, "has_usage": False})
            ag["rc"] += rc; ag["rm"] += rm; ag["lc"] += lc; ag["lm"] += lm
            ag["pods"] += 1

        # summary
        summary["rc"] += rc; summary["rm"] += rm; summary["lc"] += lc; summary["lm"] += lm
        summary["pods"] += 1
        if no_req:
            summary["norq"] += 1

        pod_loc[(ns, p.metadata.name)] = (ns, node)

    partial = bool(partial_flag)
    # cluster-wide pod usage — 대규모/예산초과(partial) 클러스터에서는 생략(드릴다운에서 확인).
    metrics_available = False
    pod_usage_skipped = partial or len(pods) > _POD_USAGE_MAX
    if not pod_usage_skipped:
        pu = _pod_usage(client)
        if pu:
            metrics_available = True
            for (ns, pod), u in pu.items():
                loc = pod_loc.get((ns, pod))
                if not loc:
                    continue
                _, node = loc
                cpu, mem = u["cpu"], u["mem"]
                if ns in per_ns:
                    per_ns[ns]["uc"] += cpu; per_ns[ns]["um"] += mem; per_ns[ns]["has_usage"] = True
                if node and node in per_node:
                    per_node[node]["uc"] += cpu; per_node[node]["um"] += mem
                    per_node[node]["has_usage"] = True
                summary["uc"] += cpu; summary["um"] += mem

    cpu_alloc = sum(nb["cpu_alloc"] for nb in node_base.values())
    mem_alloc = sum(nb["mem_alloc"] for nb in node_base.values())

    # owners set → count (직렬화 불가한 set 제거)
    for s in per_ns.values():
        s["workload_count"] = len(s.pop("owners"))

    return {
        "node_base": node_base,
        "per_node": per_node,
        "node_usage": node_usage,
        "per_ns": per_ns,
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
    }


def _overview(cluster_id: UUID, db: Session) -> dict:
    cluster = _require_cluster(cluster_id, db)
    cid = str(cluster_id)
    try:
        return _cached(f"{cid}:overview", lambda: _build_overview(cluster, cid))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"자원 집계 실패: {str(e)[:200]}") from e


# ── 엔드포인트 ───────────────────────────────────────────────────────────────────
@router.get("/{cluster_id}/allocation/nodes")
def allocation_nodes(cluster_id: UUID, db: Session = Depends(get_db)):
    """노드별 allocatable/capacity vs usage vs request/limit + slack. (요구 1·2)"""
    ov = _overview(cluster_id, db)
    node_base = ov["node_base"]
    per_node = ov["per_node"]
    node_usage = ov["node_usage"]

    rows: list[NodeAllocRow] = []
    for name, nb in node_base.items():
        ag = per_node.get(name, {"rc": 0, "rm": 0, "lc": 0, "lm": 0, "pods": 0})
        cpu_alloc, mem_alloc = nb["cpu_alloc"], nb["mem_alloc"]
        u = node_usage.get(name)
        rows.append(NodeAllocRow(
            name=name, roles=nb["roles"], unschedulable=nb["unschedulable"],
            pod_count=ag["pods"],
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
        ))
    rows.sort(key=lambda r: r.name)
    return {"count": len(rows), "items": rows, "metrics_available": bool(node_usage),
            "partial": ov.get("partial", False)}


@router.get("/{cluster_id}/allocation/namespaces")
def allocation_namespaces(cluster_id: UUID, db: Session = Depends(get_db)):
    """네임스페이스별 request/limit/usage 총합 + 클러스터 summary. (요구 3)"""
    ov = _overview(cluster_id, db)
    per_ns = ov["per_ns"]

    rows: list[NamespaceAllocRow] = []
    for ns, s in per_ns.items():
        rows.append(NamespaceAllocRow(
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
        ))
    rows.sort(key=lambda r: r.cpu_req_m, reverse=True)
    return {
        "count": len(rows),
        "items": rows,
        "summary": AllocSummary(**ov["summary"]),
        "metrics_available": ov["metrics_available"],
        "pod_usage_skipped": ov["pod_usage_skipped"],
        "partial": ov.get("partial", False),
    }


@router.get("/{cluster_id}/allocation/namespaces/{namespace}/workloads")
def allocation_workloads(cluster_id: UUID, namespace: str, db: Session = Depends(get_db)):
    """NS 내 상위 워크로드(Deployment/STS/DS/RS/Job/…) 단위 집계. (요구 4-1)"""
    cluster = _require_cluster(cluster_id, db)
    cid = str(cluster_id)
    client = _api_client(cluster)
    core = k8s_client.CoreV1Api(client)
    apps = k8s_client.AppsV1Api(client)
    try:
        pods = _cached(f"{cid}:nspods:{namespace}",
                       lambda: _list_all(lambda **kw: core.list_namespaced_pod(namespace, **kw),
                                         field_selector=_ACTIVE_FIELD_SELECTOR))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}")

    pusage = _cached(f"{cid}:nspu:{namespace}", lambda: _pod_usage(client, namespace))
    rs_map = _cached(f"{cid}:rs:{namespace}", lambda: _build_rs_owner_map(apps, namespace))

    groups: dict[tuple[str, str], dict] = {}
    for p in pods:
        if (p.status.phase if p.status else None) not in _ACTIVE_PHASES:
            continue
        kind, name = _top_owner(p, rs_map)
        rc, rm, lc, lm = _sum_resources(p.spec.containers if p.spec else [])
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
    client = _api_client(cluster)
    core = k8s_client.CoreV1Api(client)
    apps = k8s_client.AppsV1Api(client)
    try:
        pods = _cached(f"{cid}:nspods:{namespace}",
                       lambda: _list_all(lambda **kw: core.list_namespaced_pod(namespace, **kw),
                                         field_selector=_ACTIVE_FIELD_SELECTOR))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"파드 조회 실패: {str(e)[:200]}")

    pusage = _cached(f"{cid}:nspu:{namespace}", lambda: _pod_usage(client, namespace))
    rs_map = _cached(f"{cid}:rs:{namespace}", lambda: _build_rs_owner_map(apps, namespace))

    rows: list[PodAllocRow] = []
    for p in pods:
        ok, on = _top_owner(p, rs_map)
        if ok != kind or on != name:
            continue
        cmap = (pusage.get((namespace, p.metadata.name)) or {}).get("containers", {})
        cells: list[ContainerAllocCell] = []
        prc = prm = plc = plm = puc = pum = 0
        has_usage = False
        for c in (p.spec.containers if p.spec else []):
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
