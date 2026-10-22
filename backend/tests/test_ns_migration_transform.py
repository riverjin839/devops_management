"""NS 마이그레이션 순수 변환 — 정리·제외·치환·마스킹·diff·종류 정렬."""
from app.services.ns_migration import transform as tf


def _deploy(**over):
    obj = {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": "api", "namespace": "dev", "uid": "u1", "resourceVersion": "9",
                     "creationTimestamp": "2026-01-01", "managedFields": [{}], "generation": 3,
                     "annotations": {"deployment.kubernetes.io/revision": "4", "team": "a",
                                     "kubectl.kubernetes.io/last-applied-configuration": "{}"}},
        "spec": {"replicas": 1, "template": {
            "metadata": {"labels": {"app": "api", "pod-template-hash": "abc"}, "creationTimestamp": None},
            "spec": {"containers": [{"name": "c", "image": "dev-reg.local/team/api:1.0",
                                     "env": [{"name": "DB", "value": "db.dev.svc.cluster.local"}]}]}}},
        "status": {"readyReplicas": 1},
    }
    obj.update(over)
    return obj


def test_normalize_kinds_orders_and_gates_secret():
    assert tf.normalize_kinds(["Deployment", "ServiceAccount", "Secret"], False) == ["ServiceAccount", "Deployment"]
    assert "Secret" in tf.normalize_kinds(["ConfigMap"], True)
    assert tf.normalize_kinds([], False) == tf.DEFAULT_KINDS


def test_sanitize_drops_cluster_specific_fields():
    out = tf.sanitize(_deploy(), "Deployment")
    meta = out["metadata"]
    for k in ("uid", "resourceVersion", "creationTimestamp", "managedFields", "generation"):
        assert k not in meta
    assert meta["annotations"] == {"team": "a"}
    assert "status" not in out
    assert out["spec"]["template"]["metadata"]["labels"] == {"app": "api"}


def test_sanitize_service_drops_cluster_ip_and_node_port_unless_kept():
    svc = {"kind": "Service", "apiVersion": "v1", "metadata": {"name": "s"},
           "spec": {"clusterIP": "10.0.0.1", "clusterIPs": ["10.0.0.1"], "type": "NodePort",
                    "ports": [{"port": 80, "nodePort": 30080}]}}
    out = tf.sanitize(svc, "Service")
    assert "clusterIP" not in out["spec"] and "nodePort" not in out["spec"]["ports"][0]
    kept = tf.sanitize(svc, "Service", keep_node_ports=True)
    assert kept["spec"]["ports"][0]["nodePort"] == 30080
    headless = tf.sanitize({**svc, "spec": {"clusterIP": "None", "ports": []}}, "Service")
    assert headless["spec"]["clusterIP"] == "None"


def test_skip_reasons():
    assert tf.skip_reason({"metadata": {"name": "default"}}, "ServiceAccount")
    assert tf.skip_reason({"metadata": {"name": "kube-root-ca.crt"}}, "ConfigMap")
    assert tf.skip_reason({"metadata": {"name": "t"}, "type": "kubernetes.io/service-account-token"}, "Secret")
    assert tf.skip_reason({"metadata": {"name": "r", "ownerReferences": [{"kind": "Deployment", "name": "a"}]}}, "Service")
    assert tf.skip_reason({"metadata": {"name": "app"}, "type": "Opaque"}, "Secret") is None


def test_apply_rules_namespace_registry_replicas_and_dns():
    obj = tf.sanitize(_deploy(), "Deployment")
    rules = [{"type": "image_registry", "from": "dev-reg.local/", "to": "prod-reg.local/"},
             {"type": "replicas", "from": "", "to": "3", "kind": "Deployment"},
             {"type": "label", "from": "env", "to": "prod"}]
    out, notes = tf.apply_rules(obj, rules, "dev", "prod")
    assert out["metadata"]["namespace"] == "prod"
    c = out["spec"]["template"]["spec"]["containers"][0]
    assert c["image"] == "prod-reg.local/team/api:1.0"
    assert c["env"][0]["value"] == "db.prod.svc.cluster.local"
    assert out["spec"]["replicas"] == 3
    assert out["metadata"]["labels"]["env"] == "prod"
    assert len(notes) == 4
    # 원본은 그대로
    assert obj["metadata"]["namespace"] == "dev"


def test_rule_scoped_by_kind_and_name():
    obj = tf.sanitize(_deploy(), "Deployment")
    out, _ = tf.apply_rules(obj, [{"type": "replicas", "to": "5", "kind": "StatefulSet"},
                                  {"type": "replicas", "to": "2", "name": "other"}], "dev", "dev")
    assert out["spec"]["replicas"] == 1


def test_rolebinding_subject_namespace_and_namespace_rename():
    rb = {"kind": "RoleBinding", "metadata": {"name": "rb", "namespace": "dev"},
          "subjects": [{"kind": "ServiceAccount", "name": "app", "namespace": "dev"},
                       {"kind": "ServiceAccount", "name": "x", "namespace": "other"}]}
    out, _ = tf.apply_rules(rb, [], "dev", "prod")
    assert [s["namespace"] for s in out["subjects"]] == ["prod", "other"]
    ns, _ = tf.apply_rules({"kind": "Namespace", "metadata": {"name": "dev", "labels": {
        "kubernetes.io/metadata.name": "dev"}}}, [], "dev", "prod")
    assert ns["metadata"]["name"] == "prod" and "namespace" not in ns["metadata"]
    assert ns["metadata"]["labels"]["kubernetes.io/metadata.name"] == "prod"


def test_string_rule_does_not_touch_secret_data():
    sec = {"kind": "Secret", "metadata": {"name": "s", "annotations": {"url": "dev.example.com"}},
           "data": {"k": "ZGV2LmV4YW1wbGUuY29t"}}
    out, _ = tf.apply_rules(sec, [{"type": "string", "from": "dev.", "to": "prod."}], "dev", "dev")
    assert out["metadata"]["annotations"]["url"] == "prod.example.com"
    assert out["data"]["k"] == "ZGV2LmV4YW1wbGUuY29t"


def test_mask_secret_hides_values_keeps_keys():
    out = tf.mask_secret({"kind": "Secret", "data": {"a": "c2VjcmV0"}, "stringData": {"b": "x"}})
    assert out["data"] == {"a": tf.MASK} and out["stringData"] == {"b": tf.MASK}


def test_diff_create_unchanged_update():
    desired = tf.sanitize(_deploy(), "Deployment")
    assert tf.diff(None, desired) == ("create", "")
    # 서버 기본값(추가 필드)은 diff 잡음이 되지 않는다.
    current = _deploy()
    current["spec"]["strategy"] = {"type": "RollingUpdate"}
    assert tf.diff(current, desired)[0] == "unchanged"
    current["spec"]["replicas"] = 2
    action, text = tf.diff(current, desired)
    assert action == "update" and "-  replicas: 2" in text and "+  replicas: 1" in text


def test_diff_secret_never_shows_values():
    desired = {"kind": "Secret", "apiVersion": "v1", "metadata": {"name": "s"}, "data": {"pw": "TkVX"}}
    current = {"kind": "Secret", "apiVersion": "v1", "metadata": {"name": "s"}, "data": {"pw": "T0xE"}}
    action, text = tf.diff(current, desired)
    assert action == "update"
    assert "TkVX" not in text and "T0xE" not in text and tf.MASK in text


def test_bundle_yaml_multi_doc():
    text = tf.bundle_yaml([{"kind": "Namespace", "metadata": {"name": "a"}},
                           {"kind": "ConfigMap", "metadata": {"name": "b"}}], "# hdr")
    assert text.startswith("# hdr\n") and text.count("\n---\n") == 1
