"""자원 집계 개요 — 원본 JSON(raw) 순회가 typed 모델 순회와 **같은 결과**를 내는지.

대형 클러스터(376노드·3만 Pod)에서 kubernetes 모델 역직렬화 비용(500 Pod 페이지당 초 단위 CPU)
때문에 집계가 수 분 걸리고 웹 파드가 죽어 "0 Pod 처리됨"에 멈춰 보였다. `K8S_ALLOC_RAW_LIST`
(기본 on)로 노드/NS/Pod 을 원본 JSON 으로 읽는데, 이것이 결과를 바꾸면 안 된다.

같은 JSON 을 (a) ApiClient.deserialize 로 만든 typed 페이지, (b) `_preload_content=False` 원본 바이트
두 경로로 먹여 개요·on_pod 훅(효율화 수집기)·진행 단계가 동일한지 본다. 페이지네이션(continue)도 섞는다.
"""
import copy
import json

import pytest
from kubernetes import client as k8s_client

from app.routers import k8s_allocation as ka
from app.services import k8s_paging
from app.services.k8s_efficiency import collector as col
from app.services.snapshot_jobs import Progress

TS = "2026-09-01T00:00:00Z"


def _ctr(name, req=None, lim=None, **extra):
    c = {"name": name, "image": "registry/app:1"}
    if req is not None or lim is not None:
        c["resources"] = {k: v for k, v in (("requests", req), ("limits", lim)) if v is not None}
    c.update(extra)
    return c


def _pod(name, ns, node, *, phase="Running", owner=None, containers=None, init=None,
         overhead=None, statuses=None):
    meta = {"name": name, "namespace": ns, "uid": f"uid-{name}", "creationTimestamp": TS,
            "labels": {"app": name}, "managedFields": [{"manager": "kubelet", "operation": "Update"}]}
    if owner:
        meta["ownerReferences"] = [{"apiVersion": "apps/v1", "kind": owner[0], "name": owner[1],
                                    "uid": "u", "controller": True}]
    spec = {"nodeName": node, "containers": containers or [_ctr("app", {"cpu": "100m", "memory": "128Mi"})]}
    if init:
        spec["initContainers"] = init
    if overhead:
        spec["overhead"] = overhead
    status = {"phase": phase, "qosClass": "Burstable", "startTime": TS,
              "containerStatuses": statuses or [
                  {"name": "app", "ready": True, "restartCount": 0, "image": "i", "imageID": "",
                   "state": {"running": {"startedAt": TS}}}]}
    return {"apiVersion": "v1", "kind": "Pod", "metadata": meta, "spec": spec, "status": status}


PODS = [
    _pod("api-7c9f8d4b6-a", "ns1", "n1", owner=("ReplicaSet", "api-7c9f8d4b6")),
    _pod("api-7c9f8d4b6-b", "ns1", "n1", owner=("ReplicaSet", "api-7c9f8d4b6")),
    _pod("db-0", "ns2", "n2", owner=("StatefulSet", "db"),
         containers=[_ctr("db", {"cpu": "1", "memory": "2Gi"}, {"cpu": "2", "memory": "4Gi"})],
         # 네이티브 사이드카(합산) + 일반 init(순차 → max 비교)
         init=[_ctr("log-agent", {"cpu": "50m", "memory": "64Mi"}, restartPolicy="Always"),
               _ctr("migrate", {"cpu": "3", "memory": "1Gi"})]),
    _pod("kata-x", "ns2", "n1", overhead={"cpu": "250m", "memory": "160Mi"}),
    _pod("bare", "ns3", "n1", containers=[_ctr("noreq")]),                       # request 없음
    _pod("crash", "ns3", "n1", owner=("DaemonSet", "agent"), statuses=[
        {"name": "app", "ready": False, "restartCount": 9, "image": "i", "imageID": "",
         "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]),
    _pod("pend", "ns1", None, phase="Pending", statuses=[]),
    _pod("job-done", "ns1", "n1", phase="Succeeded", owner=("Job", "j1")),
    _pod("job-fail", "ns2", "n2", phase="Failed", owner=("Job", "j2")),
]

NODES = [
    {"metadata": {"name": "n1", "labels": {"node-role.kubernetes.io/control-plane": "",
                                           "node-role.kubernetes.io/infra": ""}},
     "spec": {}, "status": {"allocatable": {"cpu": "8", "memory": "16Gi", "pods": "110"},
                            "capacity": {"cpu": "8", "memory": "16Gi", "pods": "110"},
                            "conditions": [{"type": "Ready", "status": "True"}]}},
    {"metadata": {"name": "n2", "labels": {}}, "spec": {"unschedulable": True},
     "status": {"allocatable": {"cpu": "4", "memory": "8Gi", "pods": "110"},
                "capacity": {"cpu": "4", "memory": "8Gi", "pods": "110"},
                "conditions": [{"type": "Ready", "status": "True"}]}},
]
NAMESPACES = [{"metadata": {"name": n}} for n in ("ns1", "ns2", "ns3", "empty")]

_API = k8s_client.ApiClient()


class _RawResp:
    """urllib3 응답 대역 — `_preload_content=False` 경로가 읽는 .data / release_conn 만."""

    def __init__(self, body: bytes):
        self.data = body
        self.released = False

    def release_conn(self):
        self.released = True


class _TypedBody:
    def __init__(self, body: bytes):
        self.data = body


def _page(items, kind, kw):
    """limit/continue 를 흉내 내 한 페이지를 만든다(continue 토큰 = 다음 시작 인덱스)."""
    start = int(kw.get("_continue") or 0)
    limit = kw.get("limit") or len(items)
    chunk = items[start:start + limit]
    nxt = start + limit
    meta = {"continue": str(nxt)} if nxt < len(items) else {}
    body = json.dumps({"apiVersion": "v1", "kind": kind, "metadata": meta, "items": chunk}).encode()
    if kw.get("_preload_content") is False:
        return _RawResp(body)
    return _API.deserialize(_TypedBody(body), f"V1{kind}")


CALLS: list[dict] = []


class _Core:
    def __init__(self, c):
        pass

    def list_node(self, **kw):
        CALLS.append({"fn": "node", **kw})
        return _page(copy.deepcopy(NODES), "NodeList", kw)

    def list_namespace(self, **kw):
        CALLS.append({"fn": "ns", **kw})
        return _page(copy.deepcopy(NAMESPACES), "NamespaceList", kw)

    def list_pod_for_all_namespaces(self, **kw):
        CALLS.append({"fn": "pod", **kw})
        return _page(copy.deepcopy(PODS), "PodList", kw)


@pytest.fixture
def patched(monkeypatch):
    CALLS.clear()
    monkeypatch.setattr(ka, "_api_client", lambda cluster: object())
    monkeypatch.setattr(ka.k8s_client, "CoreV1Api", _Core)
    monkeypatch.setattr(ka, "_node_usage", lambda client: {"n1": (1200, 3 * 1024**3)})
    monkeypatch.setattr(ka, "_pod_usage", lambda client, namespace=None: {
        ("ns1", "api-7c9f8d4b6-a"): {"cpu": 40, "mem": 64 * 1024**2, "containers": {}},
        ("ns2", "db-0"): {"cpu": 300, "mem": 1024**3, "containers": {}},
    })
    monkeypatch.setattr(k8s_paging, "PAGE_LIMIT", 4)   # 9 Pod → 3 페이지(continue 경로 포함)


class _PhaseLog(Progress):
    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if name == "phase" and value:   # dataclass 초기값("") 제외
            self.__dict__.setdefault("phases", []).append(value)


def _run(monkeypatch, raw: bool):
    monkeypatch.setattr(ka, "_RAW_LIST", raw)
    CALLS.clear()
    hook, acc = [], col._WorkloadAcc()

    def on_pod(p, res, owner):
        hook.append((p.metadata.namespace, p.metadata.name, res, owner))
        acc.add(p, res, owner)

    prog = _PhaseLog()
    ov = ka._build_overview(object(), prog, on_pod=on_pod)
    return ov, hook, acc.wl, prog, list(CALLS)


def _norm(ov):
    return json.loads(json.dumps(ov, sort_keys=True, default=list))


def test_raw_overview_matches_typed(patched, monkeypatch):
    typed_ov, typed_hook, typed_wl, _, _ = _run(monkeypatch, raw=False)
    raw_ov, raw_hook, raw_wl, prog, calls = _run(monkeypatch, raw=True)

    assert _norm(raw_ov) == _norm(typed_ov)
    assert raw_hook == typed_hook
    assert raw_wl == typed_wl
    # 원본 JSON 경로로 실제 호출됐는지(노드·NS·Pod 모두) + 페이지네이션이 끝까지 돌았는지
    assert all(c.get("_preload_content") is False for c in calls)
    assert sum(1 for c in calls if c["fn"] == "pod") == 3
    assert prog.processed == len(PODS)


def test_raw_overview_values(patched, monkeypatch):
    """동등성만으로는 둘 다 틀린 경우를 못 잡는다 — 핵심 값을 직접 확인."""
    ov, hook, _, _, _ = _run(monkeypatch, raw=True)
    s = ov["summary"]
    assert s["node_count"] == 2 and s["namespace_count"] == 4
    assert s["pod_count"] == 7                     # 종료 파드(Succeeded/Failed) 제외
    ps = ov["pods_summary"]
    assert ps["total_pods"] == 9
    assert ps["status_counts"]["error"] == 1       # CrashLoopBackOff
    assert ps["status_counts"]["succeeded"] == 1 and ps["status_counts"]["failed"] == 1
    db = next(r for (_ns, n, r, _o) in hook if n == "db-0")
    # max(db 1000 + 사이드카 50, 일반 init 3000) = 3000m — init 가 더 크다
    assert db[0] == 3000
    kata = next(r for (_ns, n, r, _o) in hook if n == "kata-x")
    assert kata[0] == 100 + 250                    # RuntimeClass overhead 가산
    owners = {n: o for (_ns, n, _r, o) in hook}
    assert owners["api-7c9f8d4b6-a"] == ("Deployment", "api")
    assert owners["bare"] == ("Pod", "bare")
    assert ov["per_ns"]["ns3"]["norq"] == 1
    assert ov["node_base"]["n1"]["roles"] == ["control-plane", "infra"]
    assert ov["node_base"]["n2"]["unschedulable"] is True


def test_phases_are_reported_before_each_step(patched, monkeypatch):
    """단계는 시작 **전에** 기록 — 첫 페이지를 기다리는 동안에도 화면이 무엇을 기다리는지 안다."""
    _, _, _, prog, _ = _run(monkeypatch, raw=True)
    assert prog.phases[0] == "nodes"
    assert prog.phases[1:4] == ["pods:1", "pods:2", "pods:3"]
    assert prog.phases[-1] == "pod_metrics"


def test_raw_escape_hatch_uses_typed_models(patched, monkeypatch):
    """K8S_ALLOC_RAW_LIST=0 (롤백용) 이면 모델 역직렬화 경로 그대로."""
    _, _, _, _, calls = _run(monkeypatch, raw=False)
    assert all("_preload_content" not in c for c in calls)
