"""적용/롤백 — patch 본문, before 캡처, dry-run 전달, 부분 실패 → partial, 롤백 target 구성, 자동화 캡."""
from types import SimpleNamespace as NS

import pytest

from app.services.k8s_efficiency import apply as ap
from app.services.k8s_efficiency.automation import capped_target, in_maintenance_window
from app.services.k8s_efficiency.runs import RunLogger


def test_workload_patch_body_and_jsonpath():
    body = ap.workload_patch_body("app", {"cpu": "250m"}, {"cpu": "250m"})
    assert body == {"spec": {"template": {"spec": {"containers": [{"name": "app", "resources": {
        "requests": {"cpu": "250m"}, "limits": {"cpu": "250m"}}}]}}}}
    assert ap.jsonpath_body("spec.starRocksCnSpec.replicas", 3) == {"spec": {"starRocksCnSpec": {"replicas": 3}}}
    assert ap.jsonpath_get({"spec": {"starRocksCnSpec": {"replicas": 2}}}, "spec.starRocksCnSpec.replicas") == 2
    assert ap.jsonpath_get({"spec": {}}, "spec.x.y") is None


def test_targets_from_recommendations_groups_cpu_and_memory():
    recs = [
        NS(id="r1", namespace="app", kind="Deployment", name="web", container="web", resource="cpu",
           target_req=250, target_lim=250),
        NS(id="r2", namespace="app", kind="Deployment", name="web", container="web", resource="memory",
           target_req=256 * 1024 ** 2, target_lim=None),
    ]
    t = ap.targets_from_recommendations(recs)
    assert len(t) == 1
    assert t[0]["requests"] == {"cpu": "250m", "memory": "256Mi"}
    assert t[0]["limits"] == {"cpu": "250m"}
    assert sorted(t[0]["recommendation_ids"]) == ["r1", "r2"]


class _FakeDB:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def query(self, *a, **k):
        class _Q:
            def filter(self, *a, **k):
                return self

            def update(self, *a, **k):
                return 0
        return _Q()


class _Res:
    def __init__(self, requests, limits):
        self.requests = requests
        self.limits = limits


class _Apps:
    def __init__(self, fail_name=None):
        self.patched = []
        self.fail_name = fail_name

    def read_namespaced_deployment(self, n, ns):
        return NS(spec=NS(template=NS(spec=NS(containers=[
            NS(name="web", resources=_Res({"cpu": "1", "memory": "1Gi"}, {"cpu": "1"})),
        ]))))

    def patch_namespaced_deployment(self, n, ns, body, **kw):
        if n == self.fail_name:
            raise RuntimeError("boom")
        self.patched.append((n, ns, body, kw))
        return None


@pytest.fixture
def fake_k8s(monkeypatch):
    apps = _Apps(fail_name="bad")
    monkeypatch.setattr(ap.k8s_client, "AppsV1Api", lambda c: apps)
    monkeypatch.setattr(ap.k8s_client, "CoreV1Api", lambda c: NS())
    monkeypatch.setattr(ap.k8s_client, "CustomObjectsApi", lambda c: NS())
    import app.routers.k8s_resources as kr
    monkeypatch.setattr(kr, "_api_client", lambda cluster: NS(close=lambda: None))
    return apps


def _run(targets, dry_run=False):
    return NS(id="run1", run_type="rightsize_apply", trigger="manual", dry_run=dry_run, targets=targets,
              steps=[], log_lines="", run_state="queued", started_at=None, finished_at=None, duration_ms=0,
              error=None, summary=None, before=None, after=None)


def test_execute_run_captures_before_and_dry_run_flag(fake_k8s):
    run = _run([{"type": "workload", "namespace": "app", "kind": "Deployment", "name": "web", "container": "web",
                 "requests": {"cpu": "250m"}, "recommendation_ids": ["r1"]}], dry_run=True)
    ap.execute_run(_FakeDB(), run, cluster=NS(name="c"))
    assert run.run_state == "succeeded"
    assert run.before["0"] == {"requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"cpu": "1"}}
    n, ns, body, kw = fake_k8s.patched[0]
    assert kw == {"dry_run": "All"}
    assert body["spec"]["template"]["spec"]["containers"][0]["resources"]["requests"] == {"cpu": "250m"}
    assert "dry-run" in run.log_lines
    assert [s["status"] for s in run.steps] == ["success"]


def test_execute_run_partial_on_one_failure(fake_k8s):
    run = _run([
        {"type": "workload", "namespace": "app", "kind": "Deployment", "name": "web", "container": "web", "requests": {"cpu": "250m"}},
        {"type": "workload", "namespace": "app", "kind": "Deployment", "name": "bad", "container": "web", "requests": {"cpu": "250m"}},
    ])
    ap.execute_run(_FakeDB(), run, cluster=NS(name="c"))
    assert run.run_state == "partial"
    assert [s["status"] for s in run.steps] == ["success", "failed"]
    assert "boom" in run.log_lines
    assert run.summary == {"ok": 1, "failed": 1, "dry_run": False}


def test_rollback_targets_from_before():
    run = NS(targets=[{"type": "workload", "namespace": "app", "kind": "Deployment", "name": "web", "container": "web",
                       "requests": {"cpu": "250m"}}],
             before={"0": {"requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"cpu": "1"}}})
    rb = ap.rollback_targets(run)
    assert rb == [{"type": "workload", "namespace": "app", "kind": "Deployment", "name": "web", "container": "web",
                   "requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"cpu": "1"}}]


def test_automation_cap_and_window():
    assert capped_target(1000, 100, 20) == 800     # 1회 최대 20% 감소
    assert capped_target(1000, 900, 20) == 900
    assert in_maintenance_window(None) is True
    assert in_maintenance_window("not a cron") is False


def test_run_logger_records_steps_and_lines():
    run = NS(steps=[], log_lines="", run_state="queued", started_at=None, finished_at=None, duration_ms=0,
             error=None, summary=None, before=None, after=None)
    rl = RunLogger(_FakeDB(), run)
    rl.start()
    rl.step("a", "running", None, label="A")
    rl.log("hello")
    rl.step("a", "success", "done")
    rl.finish("succeeded", summary={"x": 1})
    assert run.run_state == "succeeded" and run.summary == {"x": 1}
    assert run.steps[0]["status"] == "success" and run.steps[0]["label"] == "A" and "duration_ms" in run.steps[0]
    assert "hello" in run.log_lines
