"""NS 대시보드 보강 엔드포인트 — 이 NS 의 커스텀 리소스 개수 · 이 NS 를 묶는 ClusterRoleBinding."""
import uuid
from types import SimpleNamespace

import pytest
from kubernetes.client.rest import ApiException

from app.routers import k8s_resources as kr
from app.services.k8s_raw import K8sObj
from app.services.swr_cache import SWRCache


def _crd(group, plural, kind, scope="Namespaced"):
    return SimpleNamespace(
        metadata=SimpleNamespace(name=f"{plural}.{group}", creation_timestamp=None),
        spec=SimpleNamespace(
            group=group, scope=scope,
            names=SimpleNamespace(kind=kind, plural=plural),
            versions=[SimpleNamespace(name="v1", served=True, additional_printer_columns=None)],
        ),
    )


@pytest.fixture
def env(monkeypatch):
    calls: list[tuple] = []
    crds = [
        _crd("cert-manager.io", "certificates", "Certificate"),
        _crd("monitoring.coreos.com", "servicemonitors", "ServiceMonitor"),
        _crd("example.io", "widgets", "Widget"),
        _crd("example.io", "clusterthings", "ClusterThing", scope="Cluster"),
    ]
    objects = {
        "certificates": {"items": [{}], "metadata": {"continue": "tok", "remainingItemCount": 41}},
        "servicemonitors": {"items": [], "metadata": {}},
    }

    class Ext:
        def __init__(self, _c):
            pass

        def list_custom_resource_definition(self, **kw):
            return SimpleNamespace(items=crds)

    class Co:
        def __init__(self, _c):
            pass

        def list_namespaced_custom_object(self, group, version, ns, plural, **kw):
            calls.append((plural, ns, kw))
            if plural == "widgets":
                raise ApiException(status=403)
            return objects[plural]

    crbs = K8sObj({"metadata": {}, "items": [
        {"metadata": {"name": "team-a-admin"}, "roleRef": {"kind": "ClusterRole", "name": "admin"},
         "subjects": [{"kind": "ServiceAccount", "name": "deployer", "namespace": "team-a"},
                      {"kind": "ServiceAccount", "name": "x", "namespace": "other"}]},
        {"metadata": {"name": "other-view"}, "roleRef": {"kind": "ClusterRole", "name": "view"},
         "subjects": [{"kind": "ServiceAccount", "name": "y", "namespace": "other"}]},
        {"metadata": {"name": "no-subjects"}, "roleRef": {"kind": "ClusterRole", "name": "view"}},
    ]})

    monkeypatch.setattr(kr.k8s_client, "ApiextensionsV1Api", Ext)
    monkeypatch.setattr(kr.k8s_client, "CustomObjectsApi", Co)
    monkeypatch.setattr(kr.k8s_client, "RbacAuthorizationV1Api", lambda c: SimpleNamespace(list_cluster_role_binding=None))
    monkeypatch.setattr(kr, "raw_call", lambda fn, *a, **kw: crbs)
    monkeypatch.setattr(kr, "_list_cache", SWRCache(fresh=5, stale=30, max_entries=16, store=None, name="t"))
    monkeypatch.setattr(kr, "cache_group", lambda client, cid: str(cid))
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda cluster: object())
    return SimpleNamespace(calls=calls)


def test_custom_resources_probe_only_namespaced_crds_with_limit_1(env):
    out = kr.list_namespace_custom_resources(uuid.uuid4(), "team-a", db=None)
    # cluster-scoped CRD 는 프로브하지 않는다
    assert {p for p, _, _ in env.calls} == {"certificates", "servicemonitors", "widgets"}
    assert all(ns == "team-a" and kw["limit"] == 1 and "_request_timeout" in kw for _, ns, kw in env.calls)
    # 오브젝트가 있는 것만, 개수는 remainingItemCount 로 정확히
    assert [(i["kind"], i["count"]) for i in out["items"]] == [("Certificate", 42)]
    assert out["checked"] == 3 and out["errors"] == 1 and out["unknown"] == 0
    assert out["items"][0]["version"] == "v1" and out["items"][0]["plural"] == "certificates"


def test_custom_resources_cached(env):
    cid = uuid.uuid4()
    kr.list_namespace_custom_resources(cid, "team-a", db=None)
    n = len(env.calls)
    again = kr.list_namespace_custom_resources(cid, "team-a", db=None)
    assert len(env.calls) == n and again["cache"] == "hit"


def test_cluster_role_bindings_filtered_to_namespace_subjects(env):
    out = kr.list_namespace_cluster_role_bindings(uuid.uuid4(), "team-a", db=None)
    assert out.count == 1
    row = out.items[0]
    assert row.name == "team-a-admin"
    assert row.cols == {"role": "ClusterRole/admin", "subjects": "ServiceAccount/deployer"}
    assert [c.key for c in out.columns] == ["role", "subjects"]
