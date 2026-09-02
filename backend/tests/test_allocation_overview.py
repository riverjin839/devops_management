"""_build_overview / _assemble_overview 단위 테스트 — k8s client·usage monkeypatch (DB/클러스터 불필요)."""
from types import SimpleNamespace as NS

import pytest

from app.routers import k8s_allocation as ka
from app.services.snapshot_jobs import Progress


def _container(cpu_req, mem_req):
    return NS(resources=NS(requests={"cpu": cpu_req, "memory": mem_req}, limits=None),
              name="c", image="img")


def _pod(name, ns, node, cpu_req="100m", mem_req="128Mi", phase="Running"):
    return NS(
        metadata=NS(name=name, namespace=ns, labels={}, owner_references=None, annotations={}),
        spec=NS(node_name=node, containers=[_container(cpu_req, mem_req)]),
        status=NS(phase=phase, container_statuses=[]),
    )


def _node(name, ready=True, unschedulable=False):
    return NS(
        metadata=NS(name=name, labels={}),
        spec=NS(unschedulable=unschedulable),
        status=NS(allocatable={"cpu": "4", "memory": "8Gi", "pods": "110"},
                  capacity={"cpu": "4", "memory": "8Gi", "pods": "110"},
                  conditions=[NS(type="Ready", status="True" if ready else "False")]),
    )


class _Resp:
    def __init__(self, items):
        self.items = items
        self.metadata = NS(_continue=None)


POD_LIST_KWARGS: list[dict] = []


class _Core:
    def __init__(self, c):
        pass

    def list_node(self, **k):
        return _Resp([_node("n1"), _node("n2", unschedulable=True)])

    def list_namespace(self, **k):
        return _Resp([NS(metadata=NS(name="ns1")), NS(metadata=NS(name="ns2"))])

    def list_pod_for_all_namespaces(self, **k):
        POD_LIST_KWARGS.append(dict(k))
        return _Resp([
            _pod("p1", "ns1", "n1"), _pod("p2", "ns1", "n1"), _pod("p3", "ns2", "n2"),
            # 종료 파드 — 상태 카운트에는 들어가고 자원 집계에서는 빠져야 한다
            _pod("done", "ns1", "n1", phase="Succeeded"),
            _pod("boom", "ns2", "n2", phase="Failed"),
        ])


@pytest.fixture
def patched(monkeypatch):
    monkeypatch.setattr(ka, "_api_client", lambda cluster: object())
    monkeypatch.setattr(ka.k8s_client, "CoreV1Api", _Core)
    # node usage(metrics.k8s.io nodes) — 항상 존재
    monkeypatch.setattr(ka, "_node_usage", lambda client: {"n1": (1000, 2 * 1024**3), "n2": (500, 1024**3)})
    # pod usage(metrics.k8s.io pods) — namespace 합산 대상
    monkeypatch.setattr(ka, "_pod_usage", lambda client, namespace=None: {
        ("ns1", "p1"): {"cpu": 50, "mem": 64 * 1024**2, "containers": {}},
        ("ns1", "p2"): {"cpu": 30, "mem": 32 * 1024**2, "containers": {}},
        ("ns2", "p3"): {"cpu": 70, "mem": 16 * 1024**2, "containers": {}},
    })


def test_overview_ns_usage_by_namespace(patched):
    ov = ka._build_overview(object(), Progress())
    per_ns = ov["per_ns"]
    assert set(per_ns) == {"ns1", "ns2"}
    # NS usage 가 namespace 단위로 합산됨(대규모에서도 랭킹 실사용 표시)
    assert per_ns["ns1"]["uc"] == 80 and per_ns["ns1"]["has_usage"] is True
    assert per_ns["ns2"]["uc"] == 70
    assert ov["metrics_available"] is True and ov["pod_usage_skipped"] is False
    # summary usage = 전체 합
    assert ov["summary"]["cpu_usage_m"] == 150
    # 노드행 usage 는 node metrics 에서
    assert ov["node_usage"]["n1"] == (1000, 2 * 1024**3)
    # owners set 은 출력에 없고 workload_count 로 변환됨
    assert "owners" not in per_ns["ns1"] and "workload_count" in per_ns["ns1"]


def test_assemble_overview_non_destructive(patched):
    # 부분 publish 가 accumulator(owners set)를 파괴하지 않아야 한다
    per_ns = {"ns1": {"rc": 1, "rm": 1, "lc": 0, "lm": 0, "uc": 0, "um": 0,
                      "pods": 1, "norq": 0, "owners": {("Pod", "p1")}, "has_usage": False}}
    out = ka._assemble_overview({}, {}, per_ns, {}, {"rc": 1, "rm": 1, "lc": 0, "lm": 0,
                                                     "uc": 0, "um": 0, "pods": 1, "norq": 0},
                                2, metrics_available=False, pod_usage_skipped=True, partial=True)
    assert out["per_ns"]["ns1"]["workload_count"] == 1
    # 원본 owners 보존(파괴 금지)
    assert per_ns["ns1"]["owners"] == {("Pod", "p1")}
    # 반환 복사본은 독립(원본 변형이 publish 결과에 영향 없음)
    per_ns["ns1"]["pods"] = 999
    assert out["per_ns"]["ns1"]["pods"] == 1


def test_progress_partial_published(patched, monkeypatch):
    # 매 pod 마다 publish 되도록 간격 0 으로
    monkeypatch.setattr(ka, "_PARTIAL_PUBLISH_INTERVAL", 0.0)
    prog = Progress()
    ka._build_overview(object(), prog)
    assert prog.processed == 5  # 종료 파드 포함 전수 순회
    assert prog.partial is not None and "pods_summary" in prog.partial


def test_pods_summary_derived_from_same_walk(patched):
    """POD 상태 카운트/용량이 별도 전수 조회 없이 같은 스냅샷에서 나온다(구 pods-summary 대체)."""
    POD_LIST_KWARGS.clear()
    ov = ka._build_overview(object(), Progress())
    ps = ov["pods_summary"]
    assert ps["total_pods"] == 5
    assert ps["status_counts"]["running"] == 3
    assert ps["status_counts"]["succeeded"] == 1 and ps["status_counts"]["failed"] == 1
    # 자원 집계는 활성 파드만
    assert ov["summary"]["pod_count"] == 3
    # 종료 파드까지 세려면 서버측 phase 필터가 빠져 있어야 하고, Pod 순회에 RV=0 은 절대 없어야 한다
    assert len(POD_LIST_KWARGS) == 1
    assert "field_selector" not in POD_LIST_KWARGS[0]
    assert "resource_version" not in POD_LIST_KWARGS[0]
    payload = ka._pods_summary_payload(ov)
    # n2 는 cordoned → schedulable 은 n1 만(110 슬롯) — n1 의 비종료 파드 2개 점유
    assert payload["capacity"]["nodes_total"] == 2
    assert payload["capacity"]["nodes_schedulable"] == 1
    assert payload["capacity"]["allocatable_pods"] == 220
    assert payload["capacity"]["schedulable_allocatable_pods"] == 110
    assert payload["capacity"]["schedulable_free_slots"] == 108
    assert payload["status_counts"]["running"] == 3


def test_on_pod_hook_receives_active_pods_only(patched):
    seen = []
    ka._build_overview(object(), Progress(), on_pod=lambda p, res, owner: seen.append((p.metadata.name, res, owner)))
    names = sorted(n for n, _, _ in seen)
    assert names == ["p1", "p2", "p3"]
    assert seen[0][1][0] == 100 and seen[0][2] == ("Pod", seen[0][0])


def test_overview_is_json_serializable(patched):
    import json
    ov = ka._build_overview(object(), Progress())
    json.dumps(ov)  # Redis 공유 스토어 저장 가능해야 한다
