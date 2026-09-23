"""노드 드릴다운(GET /k8s/{id}/allocation/nodes/{node}/pods) 단위 테스트.

k8s client·metrics·ReplicaSet 맵을 monkeypatch 한다(DB/클러스터 불필요). 검증 포인트:
- NS 단위 metrics/ReplicaSet 을 노드에 걸린 NS 마다 조회하고 cluster-wide metrics 는 치지 않는다.
- ReplicaSet 소유 파드는 RS 맵으로 Deployment 에 정확히 귀속된다.
- 네이티브 사이드카(init + restartPolicy=Always)는 컨테이너 행·합계에 포함된다.
- NS 수가 상한을 넘으면 cluster-wide metrics 1회 + 이름 기반 근사로 떨어지고 owner_approx 로 알린다.
"""
import threading
import uuid
from types import SimpleNamespace as NS

import pytest

from app.routers import k8s_allocation as ka


def _ctr(name, cpu_req="100m", mem_req="128Mi", cpu_lim="200m", mem_lim="256Mi", restart_policy=None):
    return NS(
        name=name,
        restart_policy=restart_policy,
        resources=NS(requests={"cpu": cpu_req, "memory": mem_req},
                     limits={"cpu": cpu_lim, "memory": mem_lim}),
    )


def _pod(name, ns, owner=None, containers=None, init_containers=None, qos="Burstable"):
    refs = [NS(kind=owner[0], name=owner[1], controller=True)] if owner else None
    return NS(
        metadata=NS(name=name, namespace=ns, owner_references=refs),
        spec=NS(node_name="worker-03", containers=containers or [_ctr("app")],
                init_containers=init_containers),
        status=NS(phase="Running", qos_class=qos),
    )


PODS = [
    # ns1: Deployment "api" 의 RS 소유 파드 2개
    _pod("api-7c9f8d4b6-4xq2p", "ns1", owner=("ReplicaSet", "api-7c9f8d4b6")),
    _pod("api-7c9f8d4b6-9hk7d", "ns1", owner=("ReplicaSet", "api-7c9f8d4b6")),
    # ns2: StatefulSet — 사이드카 1개 포함
    _pod("db-0", "ns2", owner=("StatefulSet", "db"),
         containers=[_ctr("db", cpu_req="1", mem_req="2Gi", cpu_lim="2", mem_lim="4Gi")],
         init_containers=[_ctr("log-agent", cpu_req="50m", mem_req="64Mi", restart_policy="Always"),
                          _ctr("init-schema", cpu_req="500m", mem_req="1Gi")],
         qos="Guaranteed"),
]

USAGE = {
    ("ns1", "api-7c9f8d4b6-4xq2p"): {"cpu": 40, "mem": 64 * 1024**2, "containers": {"app": (40, 64 * 1024**2)}},
    ("ns1", "api-7c9f8d4b6-9hk7d"): {"cpu": 30, "mem": 32 * 1024**2, "containers": {"app": (30, 32 * 1024**2)}},
    ("ns2", "db-0"): {"cpu": 310, "mem": 1024**3,
                      "containers": {"db": (300, 1000 * 1024**2), "log-agent": (10, 24 * 1024**2)}},
}


class _Resp:
    def __init__(self, items):
        self.items = items
        self.metadata = NS(_continue=None)


class _Core:
    list_kwargs: list[dict] = []

    def __init__(self, c):
        pass

    def list_pod_for_all_namespaces(self, **k):
        _Core.list_kwargs.append(dict(k))
        return _Resp(PODS)


@pytest.fixture
def calls(monkeypatch):
    rec = {"usage_ns": [], "rs_ns": []}
    lock = threading.Lock()

    def fake_usage(client, namespace=None):
        with lock:
            rec["usage_ns"].append(namespace)
        if namespace is None:
            return dict(USAGE)
        return {k: v for k, v in USAGE.items() if k[0] == namespace}

    def fake_rs(apps, namespace):
        with lock:
            rec["rs_ns"].append(namespace)
        return {("ns1", "api-7c9f8d4b6"): ("Deployment", "api")} if namespace == "ns1" else {}

    _Core.list_kwargs = []
    monkeypatch.setattr(ka, "_require_cluster", lambda cid, db: object())
    monkeypatch.setattr(ka, "_api_client", lambda cluster: object())
    monkeypatch.setattr(ka.k8s_client, "CoreV1Api", _Core)
    monkeypatch.setattr(ka.k8s_client, "AppsV1Api", lambda c: object())
    monkeypatch.setattr(ka, "_pod_usage", fake_usage)
    monkeypatch.setattr(ka, "_build_rs_owner_map", fake_rs)
    return rec


def _call():
    # 클러스터 id 를 매번 새로 — 20초 드릴다운 캐시가 테스트 사이에 새지 않게.
    return ka.allocation_node_pods(uuid.uuid4(), "worker-03", db=None)


def test_node_selector_scopes_to_node(calls):
    _call()
    sel = _Core.list_kwargs[0]["field_selector"]
    assert sel.startswith("spec.nodeName=worker-03,")
    assert "status.phase!=Succeeded" in sel


def test_per_namespace_fetch_never_cluster_wide(calls):
    res = _call()
    assert sorted(calls["usage_ns"]) == ["ns1", "ns2"]
    assert None not in calls["usage_ns"]
    assert sorted(calls["rs_ns"]) == ["ns1", "ns2"]
    assert res["namespace_count"] == 2
    assert res["metrics_available"] is True
    assert res["owner_approx"] is False


def test_owner_attribution_and_usage(calls):
    rows = {r.name: r for r in _call()["items"]}
    api = rows["api-7c9f8d4b6-4xq2p"]
    assert (api.owner_kind, api.owner_name) == ("Deployment", "api")
    assert api.cpu_req_m == 100 and api.cpu_usage_m == 40
    db = rows["db-0"]
    assert (db.owner_kind, db.owner_name) == ("StatefulSet", "db")
    assert db.qos == "Guaranteed"


def test_native_sidecar_counted_but_plain_init_is_not(calls):
    db = next(r for r in _call()["items"] if r.name == "db-0")
    names = [c.name for c in db.containers]
    assert names == ["db", "log-agent"]          # init-schema(일반 init) 은 상주하지 않으므로 제외
    assert db.cpu_req_m == 1000 + 50             # db + 사이드카
    assert db.cpu_usage_m == 300 + 10
    sidecar = db.containers[1]
    assert sidecar.cpu_usage_m == 10 and sidecar.has_requests


def test_rows_sorted_by_cpu_request_desc(calls):
    names = [r.name for r in _call()["items"]]
    assert names[0] == "db-0"


def test_over_cap_falls_back_to_cluster_wide_and_flags_approx(calls, monkeypatch):
    monkeypatch.setattr(ka, "_NODE_DRILL_NS_MAX", 1)
    res = _call()
    assert calls["usage_ns"] == [None]            # cluster-wide 1회
    assert calls["rs_ns"] == []                   # RS 전량 조회 생략
    assert res["owner_approx"] is True
    api = next(r for r in res["items"] if r.name == "api-7c9f8d4b6-4xq2p")
    # RS 맵 없이도 pod-template-hash strip 으로 Deployment 명을 추정한다
    assert (api.owner_kind, api.owner_name) == ("Deployment", "api")
    assert api.cpu_usage_m == 40


def test_one_namespace_metrics_failure_keeps_others(calls, monkeypatch):
    def flaky_usage(client, namespace=None):
        calls["usage_ns"].append(namespace)
        return {} if namespace == "ns2" else {k: v for k, v in USAGE.items() if k[0] == namespace}

    monkeypatch.setattr(ka, "_pod_usage", flaky_usage)
    rows = {r.name: r for r in _call()["items"]}
    assert rows["api-7c9f8d4b6-4xq2p"].cpu_usage_m == 40
    assert rows["db-0"].cpu_usage_m is None


def test_typical_worker_with_many_daemonset_namespaces_stays_per_namespace(calls, monkeypatch):
    """운영 워커 노드는 DaemonSet 만으로도 NS 가 10개를 넘는다 — 기본 설정에서 이 정도는
    cluster-wide metrics(대형 클러스터에서 타임아웃으로 빈 결과) 로 떨어지면 안 된다."""
    many = [_pod(f"agent-{i}", f"ds-ns-{i:02d}", owner=("DaemonSet", f"agent-{i}")) for i in range(16)]
    monkeypatch.setattr(_Core, "list_pod_for_all_namespaces", lambda self, **k: _Resp(many))
    res = _call()
    assert res["namespace_count"] == 16
    assert None not in calls["usage_ns"]
    assert len(calls["usage_ns"]) == 16
    assert res["owner_approx"] is False
