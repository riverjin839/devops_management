"""Service Topology builder — (cluster, namespace) 단위 자동 발견 그래프 + 트래픽.

`k8s_resources.py` 의 client factory 패턴을 재사용해 워크로드/서비스/인그레스/설정 리소스를
모아 **노드/엣지 스냅샷**을 만든다. Pod 는 기본적으로 소유 워크로드로 collapse 하고,
설정(ConfigMap/Secret/PVC)은 **참조될 때만** 노드로 만든다.

- 모든 SDK 호출은 kind 별 try/except → 실패 시 부분 그래프 + `warnings[]`.
- requests/limits 는 pod spec 에서 직접 파싱, usage 만 Prometheus 로 채운다(라우터에서 병합).
- 트래픽(Phase C)은 Hubble → conntrack → unavailable 3단 폴백.

라우터에서 사용하는 진입점:
    collect_topology(...)   # 동기 — asyncio.to_thread 로 호출
    build_pod_index(...)    # 동기 — pod_name/pod_ip → 워크로드 ID 매핑(트래픽/메트릭 공용)
    build_traffic(...)      # 동기 — 트래픽 엣지 집계
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException
from kubernetes import client as k8s_client, config as k8s_config

from app.models import Cluster
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

_LIST_LIMIT = 1000
_NODE_CAP = 400  # 렌더 가능한 최대 노드 수(초과 시 truncated)

# 워크로드로 취급하는 컨트롤러 kind (렌더되는 최상위 노드).
_WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}


# ── client ────────────────────────────────────────────────────────────────────
def api_client(cluster: Cluster) -> k8s_client.ApiClient:
    kc_path = ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(status_code=422, detail="kubeconfig 가 등록되지 않은 클러스터입니다.")
    try:
        return k8s_config.new_client_from_config(config_file=kc_path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"kubeconfig 로드 실패: {str(e)[:200]}") from e


# ── quantity parsers ────────────────────────────────────────────────────────────
def parse_cpu(q: Optional[str]) -> Optional[float]:
    """k8s CPU quantity → cores(float). '100m'→0.1, '2'→2.0, '500n'→5e-7."""
    if q is None:
        return None
    s = str(q).strip()
    if not s:
        return None
    try:
        if s.endswith("m"):
            return float(s[:-1]) / 1000.0
        if s.endswith("u"):
            return float(s[:-1]) / 1_000_000.0
        if s.endswith("n"):
            return float(s[:-1]) / 1_000_000_000.0
        return float(s)
    except (ValueError, TypeError):
        return None


_MEM_FACTORS = {
    "Ki": 1024, "Mi": 1024 ** 2, "Gi": 1024 ** 3, "Ti": 1024 ** 4, "Pi": 1024 ** 5, "Ei": 1024 ** 6,
    "K": 1000, "M": 1000 ** 2, "G": 1000 ** 3, "T": 1000 ** 4, "P": 1000 ** 5, "E": 1000 ** 6,
    "k": 1000,
}


def parse_mem(q: Optional[str]) -> Optional[int]:
    """k8s memory quantity → bytes(int). '128Mi', '1Gi', '512M', plain bytes."""
    if q is None:
        return None
    s = str(q).strip()
    if not s:
        return None
    for suf, factor in _MEM_FACTORS.items():
        if s.endswith(suf):
            try:
                return int(float(s[: -len(suf)]) * factor)
            except (ValueError, TypeError):
                return None
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return None


def _age_seconds(meta) -> Optional[int]:
    ts = getattr(meta, "creation_timestamp", None)
    if not ts:
        return None
    try:
        return int((datetime.now(timezone.utc) - ts).total_seconds())
    except Exception:  # noqa: BLE001
        return None


def node_id(kind: str, namespace: str, name: str) -> str:
    return f"{kind}/{namespace}/{name}"


# ── owner resolution ────────────────────────────────────────────────────────────
def _owner_ref(meta) -> Optional[tuple[str, str]]:
    refs = getattr(meta, "owner_references", None) or []
    for r in refs:
        if getattr(r, "controller", False) or len(refs) == 1:
            return (r.kind, r.name)
    if refs:
        return (refs[0].kind, refs[0].name)
    return None


def _resolve_pod_workload(
    pod, rs_owner: dict[str, tuple[str, str]], job_owner: dict[str, tuple[str, str]],
) -> tuple[str, str]:
    """Pod → 최상위 워크로드 (kind, name). 오너 체인(RS→Deployment, Job→CronJob) 해석."""
    owner = _owner_ref(pod.metadata)
    if not owner:
        return ("Pod", pod.metadata.name)
    kind, name = owner
    if kind == "ReplicaSet":
        return rs_owner.get(name, ("Deployment", _strip_hash(name)))
    if kind == "Job":
        return job_owner.get(name, ("Job", name))
    return (kind, name)


def _strip_hash(rs_name: str) -> str:
    """ReplicaSet 이름에서 pod-template-hash 접미사 제거 → Deployment 이름 추정(폴백)."""
    return re.sub(r"-[a-f0-9]{8,10}$", "", rs_name)


# ── pod template config refs ─────────────────────────────────────────────────────
def _extract_refs(pod_spec) -> dict[str, set[str]]:
    """pod spec 에서 참조하는 ConfigMap/Secret/PVC 이름 수집."""
    cms: set[str] = set()
    secrets: set[str] = set()
    pvcs: set[str] = set()
    if pod_spec is None:
        return {"configmap": cms, "secret": secrets, "pvc": pvcs}

    for c in (getattr(pod_spec, "containers", None) or []):
        for e in (getattr(c, "env", None) or []):
            vf = getattr(e, "value_from", None)
            if not vf:
                continue
            if getattr(vf, "config_map_key_ref", None):
                cms.add(vf.config_map_key_ref.name)
            if getattr(vf, "secret_key_ref", None):
                secrets.add(vf.secret_key_ref.name)
        for ef in (getattr(c, "env_from", None) or []):
            if getattr(ef, "config_map_ref", None):
                cms.add(ef.config_map_ref.name)
            if getattr(ef, "secret_ref", None):
                secrets.add(ef.secret_ref.name)

    for v in (getattr(pod_spec, "volumes", None) or []):
        if getattr(v, "config_map", None):
            cms.add(v.config_map.name)
        if getattr(v, "secret", None):
            secrets.add(v.secret.secret_name)
        if getattr(v, "persistent_volume_claim", None):
            pvcs.add(v.persistent_volume_claim.claim_name)
        proj = getattr(v, "projected", None)
        if proj:
            for src in (getattr(proj, "sources", None) or []):
                if getattr(src, "config_map", None):
                    cms.add(src.config_map.name)
                if getattr(src, "secret", None):
                    secrets.add(src.secret.name)
    cms.discard(None)
    secrets.discard(None)
    pvcs.discard(None)
    return {"configmap": cms, "secret": secrets, "pvc": pvcs}


def _pod_template_spec(obj, kind: str):
    """컨트롤러 오브젝트에서 pod template spec 추출."""
    try:
        if kind == "CronJob":
            return obj.spec.job_template.spec.template.spec
        return obj.spec.template.spec
    except Exception:  # noqa: BLE001
        return None


def _container_requests(pod_spec) -> dict[str, Optional[float]]:
    """pod spec containers 의 requests/limits 합산 → cpu(cores)/mem(bytes)."""
    cpu_req = mem_req = cpu_lim = mem_lim = 0.0
    has_cpu_req = has_mem_req = has_cpu_lim = has_mem_lim = False
    for c in (getattr(pod_spec, "containers", None) or []) if pod_spec else []:
        res = getattr(c, "resources", None)
        if not res:
            continue
        req = getattr(res, "requests", None) or {}
        lim = getattr(res, "limits", None) or {}
        cv = parse_cpu(req.get("cpu"));  mv = parse_mem(req.get("memory"))
        cl = parse_cpu(lim.get("cpu"));  ml = parse_mem(lim.get("memory"))
        if cv is not None: cpu_req += cv; has_cpu_req = True
        if mv is not None: mem_req += mv; has_mem_req = True
        if cl is not None: cpu_lim += cl; has_cpu_lim = True
        if ml is not None: mem_lim += ml; has_mem_lim = True
    return {
        "cpu_request": round(cpu_req, 4) if has_cpu_req else None,
        "mem_request": int(mem_req) if has_mem_req else None,
        "cpu_limit": round(cpu_lim, 4) if has_cpu_lim else None,
        "mem_limit": int(mem_lim) if has_mem_lim else None,
    }


def _labels_match(selector: dict, labels: dict) -> bool:
    if not selector:
        return False
    return all(labels.get(k) == v for k, v in selector.items())


# ── main collector ──────────────────────────────────────────────────────────────
def collect_topology(
    cluster: Cluster,
    namespace: str,
    *,
    include_pods: bool = False,
    include_orphans: bool = False,
) -> dict[str, Any]:
    """(cluster, namespace) 그래프 스냅샷. 동기 — asyncio.to_thread 로 호출.

    반환: {nodes, edges, warnings, truncated, pod_index, workload_pods}
      - pod_index: {pod_name: workload_id, pod_ip: workload_id}  (트래픽/메트릭 매핑용)
      - workload_pods: {workload_id: [pod_name, ...]}            (Prometheus usage 롤업용)
    """
    client = api_client(cluster)
    apps = k8s_client.AppsV1Api(client)
    core = k8s_client.CoreV1Api(client)
    batch = k8s_client.BatchV1Api(client)
    net = k8s_client.NetworkingV1Api(client)

    warnings: list[str] = []

    def _safe(label: str, fn):
        try:
            return (fn().items or [])
        except Exception as e:  # noqa: BLE001
            warnings.append(f"{label} 조회 실패: {str(e)[:120]}")
            return []

    deployments = _safe("deployments", lambda: apps.list_namespaced_deployment(namespace, limit=_LIST_LIMIT))
    statefulsets = _safe("statefulsets", lambda: apps.list_namespaced_stateful_set(namespace, limit=_LIST_LIMIT))
    daemonsets = _safe("daemonsets", lambda: apps.list_namespaced_daemon_set(namespace, limit=_LIST_LIMIT))
    replicasets = _safe("replicasets", lambda: apps.list_namespaced_replica_set(namespace, limit=_LIST_LIMIT))
    jobs = _safe("jobs", lambda: batch.list_namespaced_job(namespace, limit=_LIST_LIMIT))
    cronjobs = _safe("cronjobs", lambda: batch.list_namespaced_cron_job(namespace, limit=_LIST_LIMIT))
    pods = _safe("pods", lambda: core.list_namespaced_pod(namespace, limit=_LIST_LIMIT))
    services = _safe("services", lambda: core.list_namespaced_service(namespace, limit=_LIST_LIMIT))
    ingresses = _safe("ingresses", lambda: net.list_namespaced_ingress(namespace, limit=_LIST_LIMIT))
    configmaps = _safe("configmaps", lambda: core.list_namespaced_config_map(namespace, limit=_LIST_LIMIT))
    secrets = _safe("secrets", lambda: core.list_namespaced_secret(namespace, limit=_LIST_LIMIT))
    pvcs = _safe("pvcs", lambda: core.list_namespaced_persistent_volume_claim(namespace, limit=_LIST_LIMIT))

    # 오너 해석 맵: ReplicaSet→Deployment, Job→CronJob
    rs_owner: dict[str, tuple[str, str]] = {}
    for rs in replicasets:
        o = _owner_ref(rs.metadata)
        if o:
            rs_owner[rs.metadata.name] = o
    job_owner: dict[str, tuple[str, str]] = {}
    for j in jobs:
        o = _owner_ref(j.metadata)
        if o:
            job_owner[j.metadata.name] = o

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    edge_ids: set[str] = set()
    workload_pods: dict[str, list[str]] = {}
    pod_name_index: dict[str, str] = {}
    pod_ip_index: dict[str, str] = {}
    # (pod labels, workload_id) — Service selector 매칭을 실제 pod 라벨로 정확히.
    pod_label_workloads: list[tuple[dict, str]] = []

    def add_edge(source: str, target: str, etype: str, label: str = "", detail: str = "") -> None:
        if source not in nodes or target not in nodes:
            return
        eid = f"{source}|{etype}|{target}"
        if eid in edge_ids:
            return
        edge_ids.add(eid)
        edges.append({"id": eid, "source": source, "target": target,
                      "type": etype, "label": label, "detail": detail, "manual_id": None})

    # 1) 워크로드 노드 등록 + requests/limits
    def _register_workload(obj, kind: str) -> str:
        name = obj.metadata.name
        nid = node_id(kind, namespace, name)
        spec = _pod_template_spec(obj, kind)
        res = _container_requests(spec)
        nodes[nid] = {
            "id": nid, "kind": kind, "name": name, "namespace": namespace,
            "status": "healthy", "pod_count": 0, "ready_count": 0, "restart_count": 0,
            "ghost": False, "age_seconds": _age_seconds(obj.metadata),
            "selector": _safe_selector(obj, kind),
            "labels": (obj.metadata.labels or {}),
            "metrics": {
                "cpu": {"usage": None, "request": res["cpu_request"], "limit": res["cpu_limit"]},
                "mem": {"usage": None, "request": res["mem_request"], "limit": res["mem_limit"]},
            },
            "_refs": _extract_refs(spec),
        }
        workload_pods.setdefault(nid, [])
        return nid

    for d in deployments:   _register_workload(d, "Deployment")
    for s in statefulsets:  _register_workload(s, "StatefulSet")
    for ds in daemonsets:   _register_workload(ds, "DaemonSet")
    for cj in cronjobs:     _register_workload(cj, "CronJob")
    for j in jobs:
        # CronJob 소유 Job 은 CronJob 으로 흡수(owns 엣지로 표현), 독립 Job 만 별도 노드
        if j.metadata.name not in job_owner:
            _register_workload(j, "Job")

    # CronJob → Job owns 엣지
    for j in jobs:
        owner = job_owner.get(j.metadata.name)
        if owner and owner[0] == "CronJob":
            cj_id = node_id("CronJob", namespace, owner[1])
            job_id = node_id("Job", namespace, j.metadata.name)
            if cj_id in nodes and job_id not in nodes:
                _register_workload(j, "Job")  # CronJob 의 실제 Job 도 보여준다
            add_edge(cj_id, job_id, "owns", label="job")

    # 2) Pod 처리 — 워크로드로 collapse(+ 집계), 독립 pod 는 노드로
    for p in pods:
        wl_kind, wl_name = _resolve_pod_workload(p, rs_owner, job_owner)
        wl_id = node_id(wl_kind, namespace, wl_name)
        # 워크로드 노드가 없으면(예: 독립 pod) Pod 노드로 등록
        if wl_id not in nodes:
            if wl_kind == "Pod":
                wl_id = node_id("Pod", namespace, p.metadata.name)
                if wl_id not in nodes:
                    nodes[wl_id] = {
                        "id": wl_id, "kind": "Pod", "name": p.metadata.name, "namespace": namespace,
                        "status": "healthy", "pod_count": 0, "ready_count": 0, "restart_count": 0,
                        "ghost": False, "age_seconds": _age_seconds(p.metadata),
                        "selector": {}, "labels": (p.metadata.labels or {}),
                        "metrics": {"cpu": {"usage": None, "request": None, "limit": None},
                                    "mem": {"usage": None, "request": None, "limit": None}},
                        "_refs": _extract_refs(p.spec),
                    }
                    workload_pods.setdefault(wl_id, [])
            else:
                continue  # 컨트롤러가 namespace 밖이거나 없음 — 스킵

        node = nodes[wl_id]
        st = p.status
        cs = (st.container_statuses or []) if st else []
        ready = sum(1 for c in cs if c.ready)
        restarts = sum((c.restart_count or 0) for c in cs)
        node["pod_count"] += 1
        node["ready_count"] += 1 if (ready == len(cs) and len(cs) > 0) else 0
        node["restart_count"] += restarts
        workload_pods.setdefault(wl_id, []).append(p.metadata.name)
        pod_name_index[p.metadata.name] = wl_id
        pod_ip = (st.pod_ip if st else None)
        if pod_ip:
            pod_ip_index[pod_ip] = wl_id
        pod_label_workloads.append((p.metadata.labels or {}, wl_id))

        # include_pods 시 개별 Pod 노드 + owns 엣지
        if include_pods and node["kind"] != "Pod":
            pid = node_id("Pod", namespace, p.metadata.name)
            nodes[pid] = {
                "id": pid, "kind": "Pod", "name": p.metadata.name, "namespace": namespace,
                "status": _pod_status(ready, len(cs), restarts), "pod_count": 1,
                "ready_count": 1 if (ready == len(cs) and len(cs) > 0) else 0,
                "restart_count": restarts, "ghost": False, "age_seconds": _age_seconds(p.metadata),
                "selector": {}, "labels": (p.metadata.labels or {}),
                "metrics": {"cpu": {"usage": None, "request": None, "limit": None},
                            "mem": {"usage": None, "request": None, "limit": None}},
                "_refs": {"configmap": set(), "secret": set(), "pvc": set()},
            }
            add_edge(wl_id, pid, "owns", label="pod")

    # 워크로드 상태 확정
    for n in nodes.values():
        if n["kind"] in _WORKLOAD_KINDS:
            n["status"] = _pod_status(n["ready_count"], n["pod_count"], n["restart_count"])

    # 3) 설정 노드(참조 시 생성) + uses_config/uses_secret/mounts_pvc 엣지
    cm_names = {c.metadata.name for c in configmaps}
    secret_names = {s.metadata.name for s in secrets}
    pvc_objs = {pv.metadata.name: pv for pv in pvcs}

    def _ensure_config_node(kind: str, name: str, exists: bool) -> str:
        nid = node_id(kind, namespace, name)
        if nid not in nodes:
            nodes[nid] = {
                "id": nid, "kind": kind, "name": name, "namespace": namespace,
                "status": "healthy" if exists else "warning", "pod_count": 0, "ready_count": 0,
                "restart_count": 0, "ghost": not exists, "age_seconds": None,
                "selector": {}, "labels": {},
                "metrics": {"cpu": {"usage": None, "request": None, "limit": None},
                            "mem": {"usage": None, "request": None, "limit": None}},
                "_refs": {"configmap": set(), "secret": set(), "pvc": set()},
            }
        return nid

    for nid in list(nodes.keys()):
        refs = nodes[nid].get("_refs") or {}
        for cm in refs.get("configmap", set()):
            cid = _ensure_config_node("ConfigMap", cm, cm in cm_names)
            add_edge(nid, cid, "uses_config", label="config")
        for sec in refs.get("secret", set()):
            sid = _ensure_config_node("Secret", sec, sec in secret_names)
            add_edge(nid, sid, "uses_secret", label="secret")
        for pvc in refs.get("pvc", set()):
            exists = pvc in pvc_objs
            pid = _ensure_config_node("PersistentVolumeClaim", pvc, exists)
            if exists:
                pv = pvc_objs[pvc]
                cap = ((pv.status.capacity or {}).get("storage") if pv.status else None)
                nodes[pid]["status"] = (pv.status.phase if pv.status else "healthy") or "healthy"
                nodes[pid]["detail"] = cap or ""
            add_edge(nid, pid, "mounts_pvc", label="pvc")

    # include_orphans: 미참조 ConfigMap/Secret/PVC 도 노드로
    if include_orphans:
        for c in configmaps:
            _ensure_config_node("ConfigMap", c.metadata.name, True)
        for s in secrets:
            _ensure_config_node("Secret", s.metadata.name, True)
        for pv in pvcs:
            _ensure_config_node("PersistentVolumeClaim", pv.metadata.name, True)

    # 4) Service → 워크로드 routes 엣지 (selector 매칭)
    for svc in services:
        selector = (svc.spec.selector or {}) if svc.spec else {}
        if not selector:
            continue
        sid = node_id("Service", namespace, svc.metadata.name)
        nodes[sid] = {
            "id": sid, "kind": "Service", "name": svc.metadata.name, "namespace": namespace,
            "status": "healthy", "pod_count": 0, "ready_count": 0, "restart_count": 0,
            "ghost": False, "age_seconds": _age_seconds(svc.metadata),
            "selector": selector, "labels": (svc.metadata.labels or {}),
            "detail": f"{svc.spec.type} · {svc.spec.cluster_ip or '-'}" if svc.spec else "",
            "metrics": {"cpu": {"usage": None, "request": None, "limit": None},
                        "mem": {"usage": None, "request": None, "limit": None}},
            "_refs": {"configmap": set(), "secret": set(), "pvc": set()},
        }
        # 실제 pod 라벨에 selector 가 매칭되는 워크로드로 routes 엣지(중복은 add_edge 가 dedupe).
        matched: set[str] = set()
        for labels, wl_id in pod_label_workloads:
            if wl_id not in matched and _labels_match(selector, labels):
                matched.add(wl_id)
                add_edge(sid, wl_id, "routes", label="selects")
        # pod 가 하나도 없을 때(스케일 0 등)는 워크로드 자체 selector 로 폴백.
        if not matched:
            for n in list(nodes.values()):
                if n["kind"] in _WORKLOAD_KINDS and _labels_match(selector, n.get("selector") or {}):
                    add_edge(sid, n["id"], "routes", label="selects")

    # 5) Ingress → Service exposes 엣지
    for ing in ingresses:
        iid = node_id("Ingress", namespace, ing.metadata.name)
        hosts = [r.host for r in (ing.spec.rules or []) if getattr(r, "host", None)] if ing.spec else []
        nodes[iid] = {
            "id": iid, "kind": "Ingress", "name": ing.metadata.name, "namespace": namespace,
            "status": "healthy", "pod_count": 0, "ready_count": 0, "restart_count": 0,
            "ghost": False, "age_seconds": _age_seconds(ing.metadata),
            "selector": {}, "labels": (ing.metadata.labels or {}),
            "detail": ", ".join(hosts) or "-",
            "metrics": {"cpu": {"usage": None, "request": None, "limit": None},
                        "mem": {"usage": None, "request": None, "limit": None}},
            "_refs": {"configmap": set(), "secret": set(), "pvc": set()},
        }
        backend_svcs: set[str] = set()
        for rule in (ing.spec.rules or []) if ing.spec else []:
            http = getattr(rule, "http", None)
            for path in (getattr(http, "paths", None) or []) if http else []:
                be = getattr(path, "backend", None)
                svc = getattr(be, "service", None) if be else None
                if svc and getattr(svc, "name", None):
                    backend_svcs.add(svc.name)
        default_be = getattr(ing.spec, "default_backend", None) if ing.spec else None
        if default_be and getattr(default_be, "service", None):
            backend_svcs.add(default_be.service.name)
        for svc_name in backend_svcs:
            add_edge(iid, node_id("Service", namespace, svc_name), "exposes", label="route")

    # _refs / _internal 정리 + truncated
    truncated = len(nodes) > _NODE_CAP
    out_nodes = []
    for n in list(nodes.values())[:_NODE_CAP]:
        n.pop("_refs", None)
        n.pop("selector", None)
        n.pop("labels", None)
        out_nodes.append(n)
    if truncated:
        warnings.append(f"노드 {len(nodes)}개 중 {_NODE_CAP}개만 표시(truncated)")
    valid_ids = {n["id"] for n in out_nodes}
    out_edges = [e for e in edges if e["source"] in valid_ids and e["target"] in valid_ids]

    return {
        "nodes": out_nodes,
        "edges": out_edges,
        "warnings": warnings,
        "truncated": truncated,
        "pod_name_index": pod_name_index,
        "pod_ip_index": pod_ip_index,
        "workload_pods": workload_pods,
    }


def _safe_selector(obj, kind: str) -> dict:
    try:
        sel = obj.spec.selector
        if kind == "DaemonSet" or kind in ("Deployment", "StatefulSet"):
            return (sel.match_labels or {}) if sel else {}
    except Exception:  # noqa: BLE001
        pass
    return {}


def _pod_status(ready: int, total: int, restarts: int) -> str:
    if total == 0:
        return "warning"
    if ready == 0:
        return "critical"
    if ready < total:
        return "warning"
    if restarts > 5:
        return "warning"
    return "healthy"


# ── traffic (Phase C) ────────────────────────────────────────────────────────────
def build_traffic(
    cluster: Cluster,
    kc_path: str,
    namespace: str,
    *,
    since_seconds: int = 60,
    limit: int = 2000,
    hubble_installed: bool = False,
    pod_name_index: Optional[dict[str, str]] = None,
    pod_ip_index: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """트래픽 엣지 집계. Hubble → conntrack → unavailable 3단 폴백."""
    pod_name_index = pod_name_index or {}
    pod_ip_index = pod_ip_index or {}

    if hubble_installed:
        try:
            return _traffic_from_hubble(kc_path, namespace, since_seconds, limit, pod_name_index)
        except Exception as e:  # noqa: BLE001
            logger.warning("hubble traffic 실패, conntrack 폴백: %s", e)

    # conntrack 폴백
    try:
        res = _traffic_from_conntrack(kc_path, namespace, limit, pod_ip_index)
        if res is not None:
            return res
    except Exception as e:  # noqa: BLE001
        logger.warning("conntrack traffic 실패: %s", e)

    return {"status": "unavailable", "source": None,
            "reason": "Hubble Relay 가 없고 conntrack 스냅샷도 수집할 수 없습니다.", "edges": []}


def _agg_key(src: str, dst: str) -> str:
    return f"{src}=>{dst}"


def _traffic_from_hubble(kc_path, namespace, since_seconds, limit, pod_name_index) -> dict:
    from app.services.hubble_client import HubbleFilter, fetch_flows

    agg: dict[str, dict] = {}

    def _ingest(result: dict) -> None:
        for fl in (result.get("flows") or []):
            src = fl.get("source") or {}
            dst = fl.get("destination") or {}
            s_id = pod_name_index.get(src.get("pod_name") or "")
            d_id = pod_name_index.get(dst.get("pod_name") or "")
            if not s_id or not d_id or s_id == d_id:
                continue
            key = _agg_key(s_id, d_id)
            entry = agg.setdefault(key, {"source": s_id, "target": d_id, "flow_count": 0,
                                         "dropped_count": 0, "protocols": set(), "ports": set()})
            entry["flow_count"] += 1
            if fl.get("verdict") == "DROPPED":
                entry["dropped_count"] += 1
            l4 = fl.get("l4") or {}
            if l4.get("protocol"):
                entry["protocols"].add(l4["protocol"])
            dp = l4.get("destination_port")
            if dp:
                entry["ports"].add(int(dp))

    # from + to namespace 각각 조회 후 dedupe(집계 키 동일)
    _ingest(fetch_flows(kc_path, HubbleFilter(from_namespace=namespace, since_seconds=since_seconds, limit=limit)))
    _ingest(fetch_flows(kc_path, HubbleFilter(to_namespace=namespace, since_seconds=since_seconds, limit=limit)))

    edges = [{
        "source": e["source"], "target": e["target"], "flow_count": e["flow_count"],
        "dropped_count": e["dropped_count"], "protocols": sorted(e["protocols"]),
        "ports": sorted(e["ports"])[:10],
    } for e in agg.values()]
    return {"status": "ok", "source": "hubble", "reason": None, "edges": edges}


_IP_RE = re.compile(r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)")


def _traffic_from_conntrack(kc_path, namespace, limit, pod_ip_index) -> Optional[dict]:
    """cilium-dbg bpf ct list global 스냅샷에서 pod IP 쌍 → 워크로드 엣지 추출(best-effort)."""
    from app.services.cilium_trace_service import bpf_inspect

    res = bpf_inspect(kc_path, kind="ct")
    if res.get("error"):
        return None

    agg: dict[str, dict] = {}

    def _add_pair(ip_port_a: tuple[str, int], ip_port_b: tuple[str, int]) -> None:
        s_id = pod_ip_index.get(ip_port_a[0])
        d_id = pod_ip_index.get(ip_port_b[0])
        if not s_id or not d_id or s_id == d_id:
            return
        key = _agg_key(s_id, d_id)
        entry = agg.setdefault(key, {"source": s_id, "target": d_id, "flow_count": 0,
                                     "dropped_count": 0, "protocols": set(), "ports": set()})
        entry["flow_count"] += 1
        if ip_port_b[1]:
            entry["ports"].add(ip_port_b[1])

    parsed = res.get("parsed")
    keys: list[str] = []
    if isinstance(parsed, dict):
        keys = list(parsed.keys())
    elif isinstance(parsed, list):
        keys = [str(x) for x in parsed]
    else:
        keys = (res.get("raw") or "").splitlines()

    for k in keys[: max(limit, 100)]:
        matches = _IP_RE.findall(str(k))
        if len(matches) >= 2:
            a = (matches[0][0], int(matches[0][1]))
            b = (matches[1][0], int(matches[1][1]))
            _add_pair(a, b)

    edges = [{
        "source": e["source"], "target": e["target"], "flow_count": e["flow_count"],
        "dropped_count": e["dropped_count"], "protocols": sorted(e["protocols"]),
        "ports": sorted(e["ports"])[:10],
    } for e in agg.values()]
    if not edges:
        return {"status": "unavailable", "source": "conntrack",
                "reason": "conntrack 스냅샷에서 이 네임스페이스 pod 간 활성 연결을 찾지 못했습니다.", "edges": []}
    return {"status": "ok", "source": "conntrack", "reason": None, "edges": edges}
