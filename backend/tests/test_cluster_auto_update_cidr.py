"""auto-update — Node CIDR 추정 실패 분기 회귀 테스트.

노드 IP 가 /16 보다 넓게 흩어져 CIDR 추정에 실패하면, 과거에는 정의되지 않은 이름
(`node_ips_only`)을 참조해 NameError 가 났다. 바깥 except 가 이를 "nodes 조회 실패" 로 삼키면서
그 뒤의 hostname / maxPod 갱신까지 조용히 건너뛰었다.
"""
import uuid
from types import SimpleNamespace

import pytest

from app.routers import clusters as clusters_router


def _node(name, ips, master=False, pods="110"):
    labels = {"node-role.kubernetes.io/control-plane": ""} if master else {}
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name, labels=labels),
        status=SimpleNamespace(
            addresses=[SimpleNamespace(type="InternalIP", address=ip) for ip in ips],
            allocatable={"pods": pods},
        ),
    )


class _Query:
    def __init__(self, obj):
        self._obj = obj

    def filter(self, *_a, **_kw):
        return self

    def first(self):
        return self._obj


class _DB:
    def __init__(self, cluster):
        self.cluster = cluster
        self.rolled_back = False

    def query(self, _model):
        return _Query(self.cluster)

    def rollback(self):
        self.rolled_back = True


def _cluster():
    fields = dict(
        id=uuid.uuid4(), name="c1", node_count=None, hostname=None, max_pod=None, cidr=None,
        first_host=None, last_host=None, svc_cidr=None, svc_first_host=None, svc_last_host=None,
        pod_cidr=None, pod_first_host=None, pod_last_host=None, cilium_config=None, bgp_enabled=None,
        as_number=None, k8s_version=None, cilium_version=None, node_ips=None,
        bond0_ip=None, bond0_mac=None, bond1_ip=None, bond1_mac=None,
    )
    return SimpleNamespace(**fields)


@pytest.fixture
def run(monkeypatch):
    def _run(nodes):
        class V1:
            def __init__(self, _c):
                pass

            def list_node(self, **_kw):
                return SimpleNamespace(items=nodes)

            def __getattr__(self, _name):   # 제어플레인 pod·cilium configmap 조회 등 — 이 테스트 범위 밖
                def _fail(*_a, **_kw):
                    raise RuntimeError("not in this test")
                return _fail

        class Other:
            def __init__(self, _c):
                pass

            def __getattr__(self, _name):
                def _fail(*_a, **_kw):
                    raise RuntimeError("not in this test")
                return _fail

        monkeypatch.setattr(clusters_router, "_ensure_kubeconfig_file", lambda c: "/tmp/kc.yaml")
        monkeypatch.setattr(clusters_router.os.path, "exists", lambda _p: True)
        monkeypatch.setattr(clusters_router, "get_api_client_for_path", lambda _p: object())
        monkeypatch.setattr(clusters_router.k8s_client, "CoreV1Api", V1)
        monkeypatch.setattr(clusters_router.k8s_client, "CustomObjectsApi", Other)
        monkeypatch.setattr(clusters_router.k8s_client, "VersionApi", Other)
        cluster = _cluster()
        return clusters_router.auto_update_cluster(cluster.id, dry_run=True, db=_DB(cluster), _=None)
    return _run


def test_scattered_node_ips_warn_and_still_update_hostname_and_max_pod(run):
    # 10.x 와 172.16.x 는 공통 supernet 이 /16 보다 넓다 → CIDR 추정 실패 분기
    out = run([_node("master-1", ["10.0.0.1"], master=True, pods="250"), _node("worker-1", ["172.16.0.9"])])
    warnings = out["warnings"]
    assert not any("nodes 조회 실패" in w for w in warnings), warnings
    assert any("Node CIDR 추정 실패" in w and "노드 IP 2개" in w for w in warnings), warnings
    proposed = out["proposed"]
    assert "cidr" not in proposed
    assert proposed["hostname"] == "master-1"      # 예전엔 NameError 로 이 단계가 통째로 빠졌다
    assert proposed["maxPod"] == 250
    assert proposed["nodeCount"] == 2


def test_nodes_without_ipv4_do_not_warn_about_cidr(run):
    out = run([_node("master-1", [], master=True)])
    assert not any("Node CIDR" in w or "nodes 조회 실패" in w for w in out["warnings"]), out["warnings"]
    assert out["proposed"]["hostname"] == "master-1"


def test_close_node_ips_infer_cidr(run):
    out = run([_node("master-1", ["10.1.2.3"], master=True), _node("worker-1", ["10.1.2.40"])])
    assert out["proposed"]["cidr"].startswith("10.1.2.")
    assert not any("Node CIDR 추정 실패" in w for w in out["warnings"])
