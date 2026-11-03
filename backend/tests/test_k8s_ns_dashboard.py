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
    rbs = K8sObj({"metadata": {}, "items": [
        {"metadata": {"name": "deployer-edit", "namespace": "team-b"}, "roleRef": {"kind": "ClusterRole", "name": "edit"},
         "subjects": [{"kind": "ServiceAccount", "name": "deployer", "namespace": "team-a"}]},
        {"metadata": {"name": "all-sa-view", "namespace": "team-c"}, "roleRef": {"kind": "Role", "name": "viewer"},
         "subjects": [{"kind": "Group", "name": "system:serviceaccounts:team-a", "apiGroup": "rbac.authorization.k8s.io"}]},
        {"metadata": {"name": "own-ns", "namespace": "team-a"}, "roleRef": {"kind": "Role", "name": "x"},
         "subjects": [{"kind": "ServiceAccount", "name": "deployer", "namespace": "team-a"}]},
        {"metadata": {"name": "unrelated", "namespace": "team-b"}, "roleRef": {"kind": "Role", "name": "x"},
         "subjects": [{"kind": "User", "name": "alice"}]},
    ]})
    lists = {"crb": crbs, "rb": rbs}
    role_reads: list[tuple] = []

    def fake_raw_call(fn, *a, **kw):
        if fn == "read_crole" and a == ("admin",):   # ClusterRoleBinding team-a-admin → ClusterRole/admin
            role_reads.append(("ClusterRole", *a))
            return K8sObj({"rules": [{"apiGroups": ["*"], "resources": ["*"], "verbs": ["*"]}]})
        if fn == "read_crole":       # ClusterRole/edit
            role_reads.append(("ClusterRole", *a))
            return K8sObj({"rules": [
                {"apiGroups": ["apps"], "resources": ["deployments"], "verbs": ["get", "update"]},
                {"nonResourceURLs": ["/healthz"], "verbs": ["get"]},
            ]})
        if fn == "read_role":        # Role/viewer @team-c — 지워진 Role
            role_reads.append(("Role", *a))
            raise ApiException(status=404)
        return lists[fn]

    monkeypatch.setattr(kr.k8s_client, "RbacAuthorizationV1Api",
                        lambda c: SimpleNamespace(list_cluster_role_binding="crb", list_role_binding_for_all_namespaces="rb",
                                                  read_cluster_role="read_crole", read_namespaced_role="read_role"))
    monkeypatch.setattr(kr, "raw_call", fake_raw_call)
    monkeypatch.setattr(kr, "_list_cache", SWRCache(fresh=5, stale=30, max_entries=16, store=None, name="t"))
    monkeypatch.setattr(kr, "cache_group", lambda client, cid: str(cid))
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda cluster: object())
    return SimpleNamespace(calls=calls, role_reads=role_reads)


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


def test_external_role_bindings_from_other_namespaces_only(env):
    out = kr.list_namespace_external_role_bindings(uuid.uuid4(), "team-a", db=None)
    # 이 NS 안의 바인딩(own-ns)·무관 subject(unrelated)는 제외, SA 그룹 subject 는 포함
    assert [(r.namespace, r.name) for r in out.items] == [("team-b", "deployer-edit"), ("team-c", "all-sa-view")]
    assert out.items[0].cols == {"role": "ClusterRole/edit", "subjects": "ServiceAccount/deployer"}
    assert out.items[1].cols["subjects"] == "Group/system:serviceaccounts:team-a"


def test_external_role_bindings_carry_referenced_role_rules(env):
    out = kr.list_namespace_external_role_bindings(uuid.uuid4(), "team-a", db=None)
    edit, viewer = out.items
    # ClusterRole 은 이름으로, Role 은 바인딩 NS 에서 찾는다
    assert sorted(env.role_reads) == [("ClusterRole", "edit"), ("Role", "viewer", "team-c")]
    assert (edit.role_kind, edit.role_name, edit.rules_error) == ("ClusterRole", "edit", None)
    assert [(r.api_groups, r.resources, r.verbs) for r in edit.rules] == [
        (["apps"], ["deployments"], ["get", "update"]), ([], [], ["get"])]
    assert edit.rules[1].non_resource_urls == ["/healthz"]
    # 참조 Role 이 없으면 규칙 대신 사유
    assert viewer.rules is None and "없습니다" in viewer.rules_error


def test_cluster_role_bindings_carry_cluster_role_rules(env):
    out = kr.list_namespace_cluster_role_bindings(uuid.uuid4(), "team-a", db=None)
    (row,) = out.items
    assert env.role_reads == [("ClusterRole", "admin")]
    assert (row.role_kind, row.role_name, row.rules_error) == ("ClusterRole", "admin", None)
    assert [(r.api_groups, r.resources, r.verbs) for r in row.rules] == [(["*"], ["*"], ["*"])]
