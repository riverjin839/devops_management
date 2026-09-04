"""수집기 — _build_overview 재사용(on_pod), quota 맵, usage 폴백 순서, 샘플 행 구성, 스케줄 헬퍼, 소유자 판별."""
from types import SimpleNamespace as NS

import pytest

from app.services.k8s_efficiency import collector as col
from app.services.k8s_efficiency import owners, settings as effcfg


def _container(name, cpu, mem):
    return NS(name=name, resources=NS(requests={"cpu": cpu, "memory": mem}, limits=None))


def _pod(name, ns, owner_kind="Deployment", owner_name="web"):
    return NS(metadata=NS(name=name, namespace=ns, annotations={}, owner_references=None),
              spec=NS(node_name="n1", containers=[_container("web", "500m", "512Mi")], init_containers=None),
              status=NS(phase="Running", container_statuses=[]))


class _FakeDB:
    def __init__(self):
        self.saved = []

    def bulk_save_objects(self, rows):
        self.saved.extend(rows)

    def commit(self):
        pass

    def query(self, *a, **k):
        class _Q:
            def filter(self, *a, **k):
                return self

            def first(self):
                return None
        return _Q()


@pytest.fixture
def patched(monkeypatch):
    def fake_overview(cluster, progress, on_pod=None, publish_interval=None):
        pods = [_pod("web-abc12-x1", "app"), _pod("web-abc12-x2", "app"), _pod("db-0", "app", "StatefulSet", "db")]
        owners_ = [("Deployment", "web"), ("Deployment", "web"), ("StatefulSet", "db")]
        for p, o in zip(pods, owners_):
            progress.processed += 1
            on_pod(p, (500, 512 * 1024 ** 2, 0, 0), o)
        return {
            "summary": {"node_count": 1, "namespace_count": 1, "pod_count": 3},
            "per_ns": {"app": {"pods": 3, "workload_count": 2, "norq": 0, "rc": 1500, "rm": 3 * 512 * 1024 ** 2,
                               "lc": 0, "lm": 0}},
            "partial": False,
        }
    monkeypatch.setattr(col.ka, "_build_overview", fake_overview)
    monkeypatch.setattr(col, "ensure_kubeconfig_file", lambda c: "/tmp/kc")

    class _Ctx:
        def __enter__(self):
            return object()

        def __exit__(self, *a):
            return False
    monkeypatch.setattr(col.ka, "_api", lambda cluster: _Ctx())
    monkeypatch.setattr(col, "_quota_map", lambda client: {"app": {"name": "q", "hard_cpu_m": 4000, "hard_mem_b": None,
                                                                    "used_cpu_m": 1500, "used_mem_b": None}})
    monkeypatch.setattr(col._owners, "workload_meta_map", lambda client, key: {
        ("app", "StatefulSet", "db"): {"managed_by": {"api_version": "starrocks.com/v1", "kind": "StarRocksCluster", "name": "sr"}, "optout": False},
    })
    monkeypatch.setattr(col._owners, "namespace_optouts", lambda client, key: set())
    monkeypatch.setattr(col.ka, "warm_overview_snapshot", lambda *a, **k: None)
    monkeypatch.setattr(col, "get_policy_defaults", lambda db: effcfg.merge_defaults({}))


def test_collect_metrics_source_and_rows(patched, monkeypatch):
    monkeypatch.setattr(col.ka, "_pod_usage", lambda client, ns=None: {
        ("app", "web-abc12-x1"): {"cpu": 100, "mem": 100, "containers": {"web": (100, 100)}},
        ("app", "web-abc12-x2"): {"cpu": 300, "mem": 200, "containers": {"web": (300, 200)}},
    })
    db = _FakeDB()
    logs = []
    res = col.collect_cluster(db, NS(id="cid", name="c"), log=logs.append)
    assert res["usage_source"] == "metrics" and res["namespaces"] == 1 and res["workloads"] == 2
    ns_rows = [r for r in db.saved if r.__class__.__name__ == "K8sNamespaceSample"]
    wl_rows = {(r.kind, r.name): r for r in db.saved if r.__class__.__name__ == "K8sWorkloadSample"}
    assert ns_rows[0].cpu_use_m == 400 and ns_rows[0].quota_hard_cpu_m == 4000 and ns_rows[0].quota_used_cpu_m == 1500
    web = wl_rows[("Deployment", "web")]
    assert web.pod_count == 2 and web.cpu_use_m == 400
    # 컨테이너 파드당 request 는 템플릿 값(500m), usage 는 avg/max
    assert web.containers["web"]["rc"] == 500
    assert web.containers["web"]["uc_avg"] == 200 and web.containers["web"]["uc_max"] == 300
    assert web.pods == ["web-abc12-x1", "web-abc12-x2"]
    db_ = wl_rows[("StatefulSet", "db")]
    assert db_.managed_by["kind"] == "StarRocksCluster" and db_.cpu_use_m is None


def test_collect_falls_back_to_prometheus_then_none(patched, monkeypatch):
    monkeypatch.setattr(col.ka, "_pod_usage", lambda client, ns=None: {})
    monkeypatch.setattr(col._prom, "fetch_instant_usage", lambda cluster: (
        {("app", "db-0"): {"cpu": 50, "mem": 10, "containers": {"web": (50, 10)}}}, None))
    db = _FakeDB()
    res = col.collect_cluster(db, NS(id="cid", name="c"))
    assert res["usage_source"] == "prometheus"
    monkeypatch.setattr(col._prom, "fetch_instant_usage", lambda cluster: ({}, "prometheus_disabled"))
    res = col.collect_cluster(_FakeDB(), NS(id="cid", name="c"))
    assert res["usage_source"] == "none"


def test_owner_of_detects_cr_and_ignores_native():
    m = NS(owner_references=[NS(api_version="starrocks.com/v1", kind="StarRocksCluster", name="sr", controller=True)])
    assert owners.owner_of(m) == {"api_version": "starrocks.com/v1", "kind": "StarRocksCluster", "name": "sr"}
    m = NS(owner_references=[NS(api_version="apps/v1", kind="Deployment", name="d", controller=True)])
    assert owners.owner_of(m) is None
    assert owners.owner_of(NS(owner_references=None)) is None
    assert owners.is_opted_out({"pep.io/rightsize": "off"}, "pep.io/rightsize") is True
    assert owners.is_opted_out({"pep.io/rightsize": "on"}, "pep.io/rightsize") is False


def test_effective_cron_and_overrides():
    sch = {"enabled": True, "default_cron": "*/10 * * * *",
           "clusters": {"c1": {"enabled": False, "cron": None, "last_run_at": None},
                        "c2": {"enabled": True, "cron": "0 * * * *", "last_run_at": "x"}}}
    assert effcfg.effective_cron(sch, "c1") == (False, "*/10 * * * *", None)
    assert effcfg.effective_cron(sch, "c2") == (True, "0 * * * *", "x")
    assert effcfg.effective_cron(sch, "c3") == (True, "*/10 * * * *", None)
    assert effcfg.effective_cron({**sch, "enabled": False}, "c2")[0] is False
