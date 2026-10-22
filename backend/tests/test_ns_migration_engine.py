"""NS 마이그레이션 엔진 — 가짜 DynamicClient 로 수집·비교·적용 분류, 부분 실패, Secret 값 미노출."""
import copy

import pytest

from app.services.ns_migration import engine
from app.services.ns_migration import transform as tf


class _NotFound(Exception):
    status = 404


class _Obj:
    def __init__(self, d):
        self._d = d

    def to_dict(self):
        return copy.deepcopy(self._d)


class _Res:
    def __init__(self, dyn, kind):
        self.dyn, self.kind = dyn, kind
        self.namespaced = kind != "Namespace"

    def get(self, name=None, namespace=None):
        store = self.dyn.store
        if name is None:
            return _Obj({"items": [o for (k, ns, _), o in store.items() if k == self.kind
                                   and (namespace is None or ns == namespace)]})
        key = (self.kind, namespace if self.namespaced else None, name)
        if key not in store:
            raise _NotFound("not found")
        return _Obj(store[key])


class _Resources:
    def __init__(self, dyn):
        self.dyn = dyn

    def get(self, api_version=None, kind=None):
        return _Res(self.dyn, kind)


class FakeDyn:
    def __init__(self, objs, fail=()):
        self.store = {}
        for o in objs:
            m = o["metadata"]
            self.store[(o["kind"], m.get("namespace"), m["name"])] = o
        self.resources = _Resources(self)
        self.applied = []
        self.fail = set(fail)

    def server_side_apply(self, res, body=None, namespace=None, **kw):
        if body["metadata"]["name"] in self.fail:
            raise RuntimeError("admission webhook denied")
        self.applied.append((body["kind"], body["metadata"]["name"], kw.get("dry_run")))
        if not kw.get("dry_run"):
            m = body["metadata"]
            self.store[(body["kind"], m.get("namespace"), m["name"])] = copy.deepcopy(body)


SOURCE = [
    {"kind": "Namespace", "metadata": {"name": "dev", "uid": "x"}},
    {"kind": "ServiceAccount", "metadata": {"name": "default", "namespace": "dev"}},
    {"kind": "ServiceAccount", "metadata": {"name": "app", "namespace": "dev"}},
    {"kind": "ConfigMap", "metadata": {"name": "cfg", "namespace": "dev"}, "data": {"url": "db.dev.svc"}},
    {"kind": "Secret", "metadata": {"name": "pw", "namespace": "dev"}, "type": "Opaque", "data": {"p": "U0VDUkVU"}},
    {"kind": "Deployment", "apiVersion": "apps/v1", "metadata": {"name": "api", "namespace": "dev"},
     "spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": "c", "image": "dev/api:1"}]}}}},
]


@pytest.fixture
def source():
    return FakeDyn(SOURCE)


def _desired(src, spec, target_ns="prod"):
    lines = []
    kinds = tf.normalize_kinds(spec.get("kinds"), spec.get("include_secrets", False))
    objs, skipped = engine.collect(src, "dev", kinds, keep_node_ports=False, log=lines.append)
    return engine.transform_all(objs, spec.get("rules") or [], "dev", target_ns, lines.append), skipped, lines


def test_collect_skips_default_sa_and_gates_secret(source):
    desired, skipped, _ = _desired(source, {"kinds": ["ServiceAccount", "ConfigMap", "Deployment"]})
    names = [(o["kind"], o["metadata"]["name"]) for o, _ in desired]
    assert ("ServiceAccount", "app") in names and ("ServiceAccount", "default") not in names
    assert not any(k == "Secret" for k, _ in names)
    assert names[0] == ("Namespace", "prod")
    assert any(s["name"] == "default" for s in skipped)


def test_plan_on_empty_target_marks_create_without_writes(source):
    desired, _, _ = _desired(source, {"kinds": ["ServiceAccount", "ConfigMap"]})
    target = FakeDyn([])
    lines = []
    items = engine.plan_and_apply(target, desired, target_ns="prod", apply=False, force_conflicts=False, log=lines.append)
    assert {i["action"] for i in items} == {"create"}
    # NS 만 서버 dry-run, namespaced 는 NS 미존재로 생략. 실제 쓰기 없음.
    assert target.applied == [("Namespace", "prod", "All")]
    assert not any(k == "ConfigMap" for k, _, _ in target.store)


def test_apply_then_rerun_is_unchanged(source):
    spec = {"kinds": ["ServiceAccount", "ConfigMap", "Deployment"],
            "rules": [{"type": "image_registry", "from": "dev/", "to": "prod/"}]}
    desired, _, _ = _desired(source, spec)
    target = FakeDyn([])
    items = engine.plan_and_apply(target, desired, target_ns="prod", apply=True, force_conflicts=False, log=lambda _: None)
    assert all(i["status"] == "ok" for i in items)
    dep = target.store[("Deployment", "prod", "api")]
    assert dep["spec"]["template"]["spec"]["containers"][0]["image"] == "prod/api:1"
    assert target.store[("ConfigMap", "prod", "cfg")]["data"]["url"] == "db.prod.svc"
    again = engine.plan_and_apply(target, desired, target_ns="prod", apply=True, force_conflicts=False, log=lambda _: None)
    assert {i["action"] for i in again} == {"unchanged"}


def test_partial_failure_continues(source):
    desired, skipped, _ = _desired(source, {"kinds": ["ServiceAccount", "ConfigMap"]})
    target = FakeDyn([], fail={"app"})
    items = engine.plan_and_apply(target, desired, target_ns="prod", apply=True, force_conflicts=False, log=lambda _: None)
    by = {i["name"]: i for i in items}
    assert by["app"]["status"] == "failed" and "admission" in by["app"]["message"]
    assert by["cfg"]["status"] == "ok"
    s = engine.summarize(items, skipped)
    assert s["failed"] == 1 and s["create"] == 2


def test_secret_values_never_logged(source):
    desired, _, lines = _desired(source, {"kinds": ["Secret"], "include_secrets": True})
    target = FakeDyn([{"kind": "Namespace", "metadata": {"name": "prod"}},
                      {"kind": "Secret", "metadata": {"name": "pw", "namespace": "prod"}, "type": "Opaque",
                       "data": {"p": "T0xE"}}])
    items = engine.plan_and_apply(target, desired, target_ns="prod", apply=False, force_conflicts=False, log=lines.append)
    blob = repr(items) + "\n".join(lines)
    assert "U0VDUkVU" not in blob and "T0xE" not in blob
    assert next(i for i in items if i["kind"] == "Secret")["action"] == "update"
