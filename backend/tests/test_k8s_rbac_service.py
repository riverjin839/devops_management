"""K8S 접근 권한(RBAC) 서비스 단위 테스트.

클러스터 없이 검증 가능한 부분만 본다 — 규칙 정규화·이름 검증·가드레일·kubeconfig 조립·
프리셋 무결성. K8s API 를 실제로 때리는 경로는 여기서 다루지 않는다.
"""
import base64
from types import SimpleNamespace

import pytest
import yaml

from app.services.k8s_rbac_presets import BINDING_MODES, PRESET_BY_KEY, PRESETS
from app.services.k8s_rbac_service import (
    RbacService,
    default_access_checks,
    normalize_rules,
    validate_k8s_name,
)


# ── 이름 검증 ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["dev-hjkim", "lake-api", "a", "sa-1", "x" * 253])
def test_validate_name_accepts_dns1123(name):
    assert validate_k8s_name(name) == name


@pytest.mark.parametrize(
    "name",
    ["", "   ", "Dev-HJKim", "-leading", "trailing-", "under_score", "has space", "x" * 254],
)
def test_validate_name_rejects_invalid(name):
    with pytest.raises(ValueError):
        validate_k8s_name(name)


def test_validate_name_strips_surrounding_whitespace():
    assert validate_k8s_name("  dev-hjkim  ") == "dev-hjkim"


# ── 규칙 정규화 ─────────────────────────────────────────────────────────────

def test_normalize_keeps_core_group_empty_string():
    """core 그룹은 빈 문자열이다 — falsy 필터로 날려버리면 규칙이 통째로 깨진다."""
    out = normalize_rules([{"api_groups": [""], "resources": ["pods"], "verbs": ["get"]}])
    assert out[0]["api_groups"] == [""]


def test_normalize_defaults_missing_api_groups_to_core():
    out = normalize_rules([{"resources": ["pods"], "verbs": ["get"]}])
    assert out[0]["api_groups"] == [""]


def test_normalize_drops_blank_entries_and_trims():
    out = normalize_rules(
        [{"api_groups": ["apps"], "resources": [" deployments ", "", "jobs"], "verbs": ["get", " "]}]
    )
    assert out[0]["resources"] == ["deployments", "jobs"]
    assert out[0]["verbs"] == ["get"]


def test_normalize_rejects_rule_without_verbs():
    with pytest.raises(ValueError, match="verb"):
        normalize_rules([{"api_groups": [""], "resources": ["pods"], "verbs": []}])


def test_normalize_rejects_rule_without_resource_or_url():
    with pytest.raises(ValueError, match="nonResourceURL"):
        normalize_rules([{"api_groups": [""], "resources": [], "verbs": ["get"]}])


def test_normalize_rejects_empty_rule_list():
    with pytest.raises(ValueError, match="비어 있"):
        normalize_rules([])


def test_normalize_rejects_non_dict_rule():
    with pytest.raises(ValueError):
        normalize_rules(["not-a-dict"])


def test_normalize_keeps_resource_names_only_when_present():
    with_names = normalize_rules(
        [{"resources": ["secrets"], "verbs": ["get"], "resource_names": ["db-cred"]}]
    )
    assert with_names[0]["resource_names"] == ["db-cred"]
    without = normalize_rules([{"resources": ["secrets"], "verbs": ["get"]}])
    assert "resource_names" not in without[0]


def test_normalize_accepts_non_resource_url_rule():
    out = normalize_rules([{"resources": [], "verbs": ["get"], "non_resource_urls": ["/healthz"]}])
    assert out[0]["non_resource_urls"] == ["/healthz"]


# ── 가드레일 — 빌트인은 못 고친다 ───────────────────────────────────────────

@pytest.mark.parametrize(
    "name,scope",
    [
        ("system:controller:deployment-controller", "cluster"),
        ("kubeadm:get-nodes", "cluster"),
        ("cluster-admin", "cluster"),
        ("admin", "cluster"),
        ("edit", "cluster"),
        ("view", "cluster"),
        ("system:anything", "namespace"),
    ],
)
def test_assert_writable_blocks_builtin_roles(name, scope):
    with pytest.raises(ValueError, match="빌트인"):
        RbacService._assert_writable(name, scope)


@pytest.mark.parametrize("name", ["pep-dev-hjkim", "app-config-reader", "admin-tools"])
def test_assert_writable_allows_custom_roles(name):
    RbacService._assert_writable(name, "cluster")  # 예외가 나지 않아야 한다


def test_delete_service_account_refuses_default():
    svc = RbacService(SimpleNamespace(name="c1", id="x", api_endpoint="https://k8s:6443"))
    with pytest.raises(ValueError, match="기본 ServiceAccount"):
        svc.delete_service_account("lake-api", "default")


# ── 바인딩 조합 검증 ────────────────────────────────────────────────────────

def _svc():
    return RbacService(SimpleNamespace(name="lake-prod-01", id="x", api_endpoint="https://k8s:6443"))


def test_cluster_role_binding_cannot_reference_namespaced_role():
    """ClusterRoleBinding 이 Role 을 참조하면 K8s 가 거부한다 — 미리 막는다."""
    with pytest.raises(ValueError, match="ClusterRole 만"):
        _svc().create_binding(
            kind="ClusterRoleBinding", name="b", role_kind="Role", role_name="r",
            subjects=[{"kind": "ServiceAccount", "name": "sa", "namespace": "ns"}],
        )


def test_role_binding_requires_namespace():
    with pytest.raises(ValueError, match="네임스페이스"):
        _svc().create_binding(
            kind="RoleBinding", name="b", role_kind="ClusterRole", role_name="r",
            subjects=[{"kind": "ServiceAccount", "name": "sa", "namespace": "ns"}],
        )


def test_binding_requires_subject():
    with pytest.raises(ValueError, match="subject"):
        _svc().create_binding(
            kind="RoleBinding", name="b", namespace="ns",
            role_kind="ClusterRole", role_name="r", subjects=[],
        )


@pytest.mark.parametrize("kind", ["Binding", "rolebinding", ""])
def test_binding_rejects_unknown_kind(kind):
    with pytest.raises(ValueError):
        _svc().create_binding(
            kind=kind, name="b", namespace="ns", role_kind="ClusterRole", role_name="r",
            subjects=[{"kind": "ServiceAccount", "name": "sa", "namespace": "ns"}],
        )


def test_delete_binding_refuses_builtin():
    with pytest.raises(ValueError, match="빌트인"):
        _svc().delete_binding("ClusterRoleBinding", "system:node")


# ── kubeconfig 조립 ─────────────────────────────────────────────────────────

def test_build_kubeconfig_is_valid_and_targets_the_namespace(monkeypatch):
    svc = _svc()
    ca = base64.b64encode(b"--fake-ca--").decode()
    monkeypatch.setattr(svc, "cluster_endpoint", lambda: ("https://10.40.2.11:6443", ca, False))

    doc = yaml.safe_load(svc.build_kubeconfig("lake-api", "dev-hjkim", "tok-123"))

    assert doc["kind"] == "Config"
    assert doc["clusters"][0]["cluster"]["server"] == "https://10.40.2.11:6443"
    assert doc["clusters"][0]["cluster"]["certificate-authority-data"] == ca
    assert doc["users"][0]["user"]["token"] == "tok-123"
    ctx = doc["contexts"][0]["context"]
    # 개발자가 -n 없이 바로 쓰도록 기본 네임스페이스가 박혀 있어야 한다.
    assert ctx["namespace"] == "lake-api"
    assert doc["current-context"] == doc["contexts"][0]["name"]


def test_build_kubeconfig_without_ca_marks_insecure(monkeypatch):
    svc = _svc()
    monkeypatch.setattr(svc, "cluster_endpoint", lambda: ("https://10.40.2.11:6443", None, True))
    doc = yaml.safe_load(svc.build_kubeconfig("lake-api", "dev-hjkim", "tok"))
    assert doc["clusters"][0]["cluster"]["insecure-skip-tls-verify"] is True
    assert "certificate-authority-data" not in doc["clusters"][0]["cluster"]


def test_build_kubeconfig_sanitizes_cluster_name(monkeypatch):
    """클러스터 이름에 공백·한글이 있어도 kubeconfig 키로 쓸 수 있어야 한다."""
    svc = RbacService(SimpleNamespace(name="운영 클러스터 #1", id="x", api_endpoint="https://k:6443"))
    monkeypatch.setattr(svc, "cluster_endpoint", lambda: ("https://k:6443", None, False))
    doc = yaml.safe_load(svc.build_kubeconfig("ns", "sa", "tok"))
    name = doc["clusters"][0]["name"]
    assert " " not in name and "#" not in name and name


# ── 권한 점검 목록 ──────────────────────────────────────────────────────────

def test_default_access_checks_cover_deploy_and_logs_per_namespace():
    checks = default_access_checks(["lake-api", "lake-batch"])
    per_ns = {ns: [c for c in checks if c["namespace"] == ns] for ns in ("lake-api", "lake-batch")}
    assert len(per_ns["lake-api"]) == len(per_ns["lake-batch"])
    labels = {c["label"] for c in per_ns["lake-api"]}
    # 요구사항 그대로 — "접근 · 배포 · 로그" 가 전부 확인돼야 한다.
    assert "파드 로그 조회" in labels
    assert "Deployment 생성" in labels
    assert any(c["subresource"] == "log" for c in per_ns["lake-api"])


def test_default_access_checks_empty_for_no_namespaces():
    assert default_access_checks([]) == []


# ── 프리셋 무결성 ───────────────────────────────────────────────────────────

def test_every_preset_has_normalizable_rules():
    """프리셋이 곧 화면의 기본값이라, 하나라도 깨지면 발급이 바로 실패한다."""
    for preset in PRESETS:
        normalized = normalize_rules([dict(r) for r in preset["rules"]])
        assert normalized, preset["key"]


def test_preset_binding_modes_exist_in_catalog():
    known = {m["key"] for m in BINDING_MODES}
    for preset in PRESETS:
        assert preset["recommended_binding_mode"] in known, preset["key"]


def test_preset_keys_are_unique_and_indexed():
    keys = [p["key"] for p in PRESETS]
    assert len(keys) == len(set(keys))
    assert set(PRESET_BY_KEY) == set(keys)


def test_preset_risk_levels_are_known():
    assert {p["risk"] for p in PRESETS} <= {"low", "medium", "high"}


def test_readonly_preset_grants_no_write_verbs():
    """조회 전용이 쓰기를 준다면 프리셋 이름이 거짓말이 된다."""
    write = {"create", "update", "patch", "delete", "deletecollection", "*"}
    for rule in PRESET_BY_KEY["dev-readonly"]["rules"]:
        assert not (set(rule["verbs"]) & write), rule


def test_readonly_preset_can_read_pod_logs():
    resources = {r for rule in PRESET_BY_KEY["dev-readonly"]["rules"] for r in rule["resources"]}
    assert "pods/log" in resources


def test_dev_deploy_preset_covers_deploy_logs_and_exec():
    """'개발자가 LOCAL 에서 접근·배포·로그' 기준을 프리셋이 실제로 만족하는지."""
    rules = PRESET_BY_KEY["dev-deploy"]["rules"]
    resources = {r for rule in rules for r in rule["resources"]}
    assert {"pods", "pods/log", "pods/exec", "services", "configmaps"} <= resources
    deploy_rule = next(r for r in rules if "deployments" in r["resources"])
    assert {"create", "patch", "delete"} <= set(deploy_rule["verbs"])


def test_cluster_readonly_preset_excludes_secrets():
    """클러스터 전역 읽기에 secrets 가 섞이면 자격증명이 통째로 새어나간다."""
    for rule in PRESET_BY_KEY["cluster-readonly"]["rules"]:
        assert "secrets" not in rule["resources"]
