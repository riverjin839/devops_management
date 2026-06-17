"""collect_cluster_topology 단위 테스트 — api_client/Api 생성자 monkeypatch (클러스터/DB 불필요)."""
from types import SimpleNamespace as NS

import pytest

from app.services import service_topology_service as sts


# ── fakes ──────────────────────────────────────────────────────────────────
def _meta(name, ns, labels=None, owners=None):
    return NS(name=name, namespace=ns, labels=labels or {}, owner_references=owners,
              creation_timestamp=None, uid=name, annotations={})


def _deploy(name, ns, sel):
    spec = NS(selector=NS(match_labels=sel),
              template=NS(spec=NS(containers=[], volumes=None, init_containers=None)), replicas=1)
    return NS(metadata=_meta(name, ns, sel), spec=spec, status=NS(ready_replicas=1, replicas=1))


def _svc(name, ns, sel):
    return NS(metadata=_meta(name, ns),
              spec=NS(selector=sel, type="ClusterIP", cluster_ip="10.0.0.1", ports=[]))


def _ing(name, ns, svcname):
    rule = NS(host="h", http=NS(paths=[NS(backend=NS(service=NS(name=svcname)))]))
    return NS(metadata=_meta(name, ns), spec=NS(rules=[rule], default_backend=None))


def _pod(name, ns, labels, owner=None, ready=True):
    owners = [NS(controller=True, kind=owner[0], name=owner[1])] if owner else None
    return NS(metadata=_meta(name, ns, labels, owners),
              spec=NS(node_name="n1", containers=[], volumes=None, init_containers=None),
              status=NS(phase="Running", container_statuses=[NS(ready=ready, restart_count=0)],
                        pod_ip="1.2.3.4"))


class _Resp:
    def __init__(self, items):
        self.items = items
        self.metadata = NS(_continue=None)


_DEPLOYS = [_deploy("web", "ns1", {"app": "web"}), _deploy("api", "ns2", {"app": "api"})]
_SVCS = [_svc("websvc", "ns1", {"app": "web"}), _svc("apisvc", "ns2", {"app": "api"})]
_INGS = [_ing("ing1", "ns1", "websvc")]
_PODS = [_pod("web-1", "ns1", {"app": "web"}, ("ReplicaSet", "web-abc12345")),
         _pod("api-1", "ns2", {"app": "api"}, ("ReplicaSet", "api-abc12345"))]


class _Apps:
    def __init__(self, c): pass
    def list_deployment_for_all_namespaces(self, **k): return _Resp(_DEPLOYS)
    def list_stateful_set_for_all_namespaces(self, **k): return _Resp([])
    def list_daemon_set_for_all_namespaces(self, **k): return _Resp([])
    def list_replica_set_for_all_namespaces(self, **k): return _Resp([])
    def list_namespaced_deployment(self, ns, **k): return _Resp([d for d in _DEPLOYS if d.metadata.namespace == ns])
    def list_namespaced_stateful_set(self, ns, **k): return _Resp([])
    def list_namespaced_daemon_set(self, ns, **k): return _Resp([])
    def list_namespaced_replica_set(self, ns, **k): return _Resp([])


class _Batch:
    def __init__(self, c): pass
    def list_job_for_all_namespaces(self, **k): return _Resp([])
    def list_cron_job_for_all_namespaces(self, **k): return _Resp([])
    def list_namespaced_job(self, ns, **k): return _Resp([])
    def list_namespaced_cron_job(self, ns, **k): return _Resp([])


class _Net:
    def __init__(self, c): pass
    def list_ingress_for_all_namespaces(self, **k): return _Resp(_INGS)
    def list_namespaced_ingress(self, ns, **k): return _Resp([i for i in _INGS if i.metadata.namespace == ns])


class _Core:
    def __init__(self, c): pass
    def list_service_for_all_namespaces(self, **k): return _Resp(_SVCS)
    def list_pod_for_all_namespaces(self, **k): return _Resp(_PODS)
    def list_namespaced_pod(self, ns, **k): return _Resp([p for p in _PODS if p.metadata.namespace == ns])
    def list_namespaced_service(self, ns, **k): return _Resp([s for s in _SVCS if s.metadata.namespace == ns])
    def list_namespaced_config_map(self, ns, **k): return _Resp([])
    def list_namespaced_secret(self, ns, **k): return _Resp([])
    def list_namespaced_persistent_volume_claim(self, ns, **k): return _Resp([])


@pytest.fixture
def patched(monkeypatch):
    monkeypatch.setattr(sts, "api_client", lambda cluster: object())
    monkeypatch.setattr(sts.k8s_client, "AppsV1Api", _Apps)
    monkeypatch.setattr(sts.k8s_client, "CoreV1Api", _Core)
    monkeypatch.setattr(sts.k8s_client, "BatchV1Api", _Batch)
    monkeypatch.setattr(sts.k8s_client, "NetworkingV1Api", _Net)


def test_summary_mode(patched):
    from app.services.snapshot_jobs import Progress
    p = Progress()
    out = sts.collect_cluster_topology(object(), mode="summary", progress=p)
    assert out["mode"] == "summary"
    assert out["namespace_count"] == 2
    names = {n["name"] for n in out["nodes"]}
    assert names == {"ns1", "ns2"}
    assert all(n["kind"] == "Namespace" for n in out["nodes"])
    assert out["edges"] == []
    assert p.processed == 2  # 2 pods streamed
    n1 = next(n for n in out["nodes"] if n["name"] == "ns1")
    assert "1 workloads" in n1["detail"] and "1 svc" in n1["detail"] and "1 ing" in n1["detail"]


def test_detail_mode(patched):
    out = sts.collect_cluster_topology(object(), mode="detail")
    assert out["mode"] == "detail"
    kinds = {n["kind"] for n in out["nodes"]}
    assert "Service" in kinds and "Deployment" in kinds and "Ingress" in kinds
    assert all("group" in n and n["group"] == n["namespace"] for n in out["nodes"])
    etypes = {e["type"] for e in out["edges"]}
    assert "routes" in etypes and "exposes" in etypes
    # 노드 id 는 네임스페이스 포함이라 유니크
    ids = [n["id"] for n in out["nodes"]]
    assert len(ids) == len(set(ids))


def test_partial_failure_yields_warning(patched, monkeypatch):
    class _BadCore(_Core):
        def list_service_for_all_namespaces(self, **k):
            raise RuntimeError("boom")
    monkeypatch.setattr(sts.k8s_client, "CoreV1Api", _BadCore)
    out = sts.collect_cluster_topology(object(), mode="summary")
    assert any("services" in w for w in out["warnings"])
    # 부분 실패여도 그래프는 반환(500 금지)
    assert out["namespace_count"] >= 1
