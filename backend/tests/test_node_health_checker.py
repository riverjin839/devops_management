"""NodeHealthChecker 단위 테스트 — _v1 를 가짜 CoreV1Api 로 대체(클러스터/DB 불필요)."""
from types import SimpleNamespace as NS

import pytest

from app.models import StatusEnum
from app.services.deep_checkers.base import DeepCheckContext
from app.services.deep_checkers.node_health_checker import NodeHealthChecker
from app.services.deep_checkers.registry import REGISTRY, get_checker_class, get_step_plan


def _cond(t, s):
    return NS(type=t, status=s)


def _node(name, ready=True, pressure=(), taints=(), unsched=False, cpu="4", mem="8Gi"):
    conds = [_cond("Ready", "True" if ready else "False")]
    for p in pressure:
        conds.append(_cond(p, "True"))
    return NS(
        metadata=NS(name=name, labels={}),
        status=NS(conditions=conds, allocatable={"cpu": cpu, "memory": mem}),
        spec=NS(taints=[NS(key=k) for k in taints], unschedulable=unsched),
    )


def _pod(name, node_name, labels=None, phase="Running", ready=True):
    return NS(
        metadata=NS(name=name, labels=labels or {}),
        spec=NS(node_name=node_name),
        status=NS(phase=phase, container_statuses=[NS(ready=ready)]),
    )


class _FakeV1:
    def __init__(self, nodes, pods):
        self._nodes = nodes
        self._pods = pods

    def list_node(self, field_selector=None, timeout_seconds=None):
        items = self._nodes
        if field_selector and field_selector.startswith("metadata.name="):
            want = field_selector.split("=", 1)[1]
            items = [n for n in self._nodes if n.metadata.name == want]
        return NS(items=items)

    def list_namespaced_pod(self, namespace, timeout_seconds=None):
        return NS(items=self._pods)


def _run(monkeypatch, nodes, pods, **params):
    fake = _FakeV1(nodes, pods)
    monkeypatch.setattr(NodeHealthChecker, "_v1", lambda self, ctx: fake)
    ctx = DeepCheckContext(cluster=None, thresholds={}, params=params)
    return NodeHealthChecker().safe_run(ctx)


def _net_pods(node="worker-1", cni="cilium", kube_proxy=True):
    pods = []
    if cni:
        pods.append(_pod(f"{cni}-abc", node, labels={"k8s-app": cni}))
    if kube_proxy:
        pods.append(_pod("kube-proxy-xyz", node, labels={"k8s-app": "kube-proxy"}))
    return pods


def test_healthy_node(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1")], _net_pods(), node_name="worker-1")
    assert out.status == StatusEnum.healthy
    entry = out.details["nodes"][0]
    assert entry["ok"] is True
    assert entry["networking"]["cni_family"] == "cilium"
    assert entry["networking"]["kube_proxy"] is True


def test_not_ready_is_critical(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1", ready=False)], _net_pods(), node_name="worker-1")
    assert out.status == StatusEnum.critical
    assert out.details["nodes"][0]["ok"] is False


def test_disk_pressure_unhealthy(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1", pressure=("DiskPressure",))], _net_pods(),
               node_name="worker-1")
    entry = out.details["nodes"][0]
    assert entry["ok"] is False
    assert "DiskPressure" in entry["pressure"]
    assert out.status in (StatusEnum.warning, StatusEnum.critical)


def test_blocking_taint_not_ok(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1", taints=("node.kubernetes.io/not-ready",))],
               _net_pods(), node_name="worker-1")
    entry = out.details["nodes"][0]
    assert entry["ok"] is False
    assert "node.kubernetes.io/not-ready" in entry["taints"]


def test_zero_allocatable_not_ok(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1", cpu="0")], _net_pods(), node_name="worker-1")
    entry = out.details["nodes"][0]
    assert entry["allocatable_ok"] is False
    assert entry["ok"] is False


def test_missing_kube_proxy(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1")], _net_pods(kube_proxy=False),
               node_name="worker-1")
    entry = out.details["nodes"][0]
    assert entry["networking"]["kube_proxy"] is False
    assert "kube-proxy" in entry["networking"]["missing"]
    assert entry["ok"] is False


def test_missing_kube_proxy_allowed_when_not_required(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1")], _net_pods(kube_proxy=False),
               node_name="worker-1", require_kube_proxy=False)
    assert out.details["nodes"][0]["ok"] is True


def test_node_not_found_is_pending(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1")], _net_pods(), node_name="ghost")
    assert out.status == StatusEnum.pending
    assert out.details["found"] is False


def test_multiple_cni_calico(monkeypatch):
    out = _run(monkeypatch, [_node("worker-1")], _net_pods(cni="calico-node"),
               node_name="worker-1")
    entry = out.details["nodes"][0]
    assert entry["networking"]["cni"] is True
    assert entry["networking"]["cni_family"] == "calico-node"


def test_all_nodes_scope(monkeypatch):
    nodes = [_node("worker-1"), _node("worker-2", ready=False)]
    pods = _net_pods("worker-1") + _net_pods("worker-2")
    out = _run(monkeypatch, nodes, pods)  # node_name 비움 = 전체
    assert out.details["scope"] == "all"
    assert out.details["total_nodes"] == 2
    assert out.details["unhealthy_count"] == 1
    assert out.status == StatusEnum.critical  # worker-2 NotReady


def test_registry_registered():
    assert "node_health" in REGISTRY
    assert get_checker_class("node_health") is NodeHealthChecker
    assert len(get_step_plan("node_health")) == 4
