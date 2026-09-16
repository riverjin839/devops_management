"""K8s RBAC(ServiceAccount / Role / ClusterRole / Binding) 조회·생성·편집 서비스.

개발자가 **자기 LOCAL 에서** 해당 클러스터에 접근해 배포하고 로그를 보려면
"ServiceAccount + (Cluster)Role + Binding + 그 SA 토큰이 박힌 kubeconfig" 네 가지가
모두 있어야 한다. 이 서비스는 그 네 가지를 한 화면에서 만들고 편집하고 회수할 수 있게
K8s API 를 감싼다.

설계 메모
- 클러스터별로 **격리된** ``client.Configuration`` 을 만든다. 인자 없는
  ``config.load_kube_config()`` 는 전역 default Configuration 을 덮어써서, 동시 요청이
  서로의 설정을 클로버링한다(``k8s_node_label_service`` 의 같은 주석 참고).
- 권한 규칙(rules)·프리셋은 **데이터**다. 프리셋은 "시작 템플릿"일 뿐이고 실행 전에 화면에서
  규칙을 그대로 편집할 수 있어야 한다(CLAUDE.md UI-First 원칙).
- ``provision()`` 은 제너레이터다 — 단계마다 로그 이벤트를 흘려보내 라우터가 SSE 로
  실시간 중계한다(실행 버튼 = 상세·실시간 로그).
"""
from __future__ import annotations

import base64
import os
import re
from datetime import datetime, timezone
from typing import Any, Iterator

import yaml
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from app.models.cluster import Cluster
from app.services.kubeconfig import resolve_kubeconfig

# ── 가드레일 ────────────────────────────────────────────────────────────────
# 빌트인 오브젝트를 이 화면에서 지우면 클러스터가 통째로 망가진다. 조회는 허용하되
# 쓰기(수정/삭제)는 막는다.
SYSTEM_NAME_PREFIXES = ("system:", "kubeadm:")
PROTECTED_CLUSTER_ROLES = {"cluster-admin", "admin", "edit", "view"}
PROTECTED_NAMESPACES = {"kube-system", "kube-public", "kube-node-lease"}
# 기본 SA 는 네임스페이스마다 자동 생성되는 것이라 삭제해도 즉시 재생성되고, 그 사이
# 파드 생성이 깨진다.
PROTECTED_SERVICE_ACCOUNTS = {"default"}

DNS1123_RE = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")

# TokenRequest 기본 만료 — 7일. API server 의 --service-account-max-token-expiration
# 보다 크면 서버가 알아서 잘라내고 경고를 남긴다.
DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 3600
MAX_TOKEN_TTL_SECONDS = 365 * 24 * 3600


def map_k8s_error(e: ApiException) -> tuple[int, str]:
    """ApiException → (HTTP status, 사람이 읽을 사유)."""
    body_msg = ""
    try:
        import json as _json

        body_msg = (_json.loads(e.body or "{}") or {}).get("message", "")
    except Exception:  # noqa: BLE001 — 본문 파싱 실패는 reason 으로 폴백
        body_msg = ""
    detail = body_msg or e.reason or "Kubernetes API 호출 실패"
    if e.status in (400, 403, 404, 409, 422):
        return e.status, detail
    return 500, detail


def validate_k8s_name(name: str, field: str = "이름") -> str:
    name = (name or "").strip()
    if not name:
        raise ValueError(f"{field}을(를) 입력하세요.")
    if len(name) > 253:
        raise ValueError(f"{field}이(가) 너무 깁니다(253자 이하).")
    if not DNS1123_RE.match(name):
        raise ValueError(
            f"{field} '{name}' 이(가) K8s 명명 규칙에 맞지 않습니다 — "
            "소문자/숫자/'-' 로만, 처음과 끝은 소문자·숫자여야 합니다."
        )
    return name


def _ts(obj: Any) -> str | None:
    """metadata.creation_timestamp → ISO 문자열."""
    value = getattr(obj, "creation_timestamp", None)
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value) if value else None


def normalize_rules(rules: list[dict] | None) -> list[dict]:
    """UI/프리셋에서 온 규칙 목록을 K8s PolicyRule 모양으로 정규화·검증한다."""
    out: list[dict] = []
    for idx, raw in enumerate(rules or []):
        if not isinstance(raw, dict):
            raise ValueError(f"{idx + 1}번째 규칙의 형식이 올바르지 않습니다.")
        verbs = [str(v).strip() for v in (raw.get("verbs") or []) if str(v).strip()]
        if not verbs:
            raise ValueError(f"{idx + 1}번째 규칙에 verb 가 없습니다.")
        resources = [str(r).strip() for r in (raw.get("resources") or []) if str(r).strip()]
        non_resource_urls = [
            str(u).strip() for u in (raw.get("non_resource_urls") or []) if str(u).strip()
        ]
        if not resources and not non_resource_urls:
            raise ValueError(
                f"{idx + 1}번째 규칙에 resource 또는 nonResourceURL 중 하나는 있어야 합니다."
            )
        rule: dict[str, Any] = {
            # apiGroups 는 core('') 가 빈 문자열이라 falsy 필터를 걸면 안 된다.
            "api_groups": [str(g).strip() for g in (raw.get("api_groups") or [""])],
            "resources": resources,
            "verbs": verbs,
        }
        resource_names = [str(n).strip() for n in (raw.get("resource_names") or []) if str(n).strip()]
        if resource_names:
            rule["resource_names"] = resource_names
        if non_resource_urls:
            rule["non_resource_urls"] = non_resource_urls
            # nonResourceURLs 는 ClusterRole 전용이며 resources 와 함께 쓸 수 없다.
            rule["resources"] = resources
        out.append(rule)
    if not out:
        raise ValueError("권한 규칙이 비어 있습니다 — 최소 한 줄은 필요합니다.")
    return out


def rule_to_dict(rule: Any) -> dict:
    return {
        "api_groups": list(getattr(rule, "api_groups", None) or [""]),
        "resources": list(getattr(rule, "resources", None) or []),
        "verbs": list(getattr(rule, "verbs", None) or []),
        "resource_names": list(getattr(rule, "resource_names", None) or []),
        "non_resource_urls": list(getattr(rule, "non_resource_urls", None) or []),
    }


class RbacService:
    """한 클러스터에 대한 RBAC 조회/편집 진입점."""

    def __init__(self, cluster: Cluster):
        self.cluster = cluster
        self._cfg: client.Configuration | None = None
        self._api_client: client.ApiClient | None = None
        self._kubeconfig_path: str | None = None

    # ── 클라이언트 ─────────────────────────────────────────────────────────
    def _configuration(self) -> client.Configuration:
        if self._cfg is not None:
            return self._cfg
        cfg = client.Configuration()
        path, reason = resolve_kubeconfig(self.cluster)
        if path and os.path.exists(path):
            config.load_kube_config(config_file=path, client_configuration=cfg)
            self._kubeconfig_path = path
        else:
            try:
                config.load_incluster_config(client_configuration=cfg)
            except config.ConfigException:
                raise ValueError(
                    reason
                    or f"클러스터 '{self.cluster.name}' 의 kubeconfig 를 찾을 수 없고 "
                    "in-cluster 환경도 아닙니다."
                )
        self._cfg = cfg
        return cfg

    def _client(self) -> client.ApiClient:
        if self._api_client is None:
            self._api_client = client.ApiClient(configuration=self._configuration())
        return self._api_client

    @property
    def core(self) -> client.CoreV1Api:
        return client.CoreV1Api(api_client=self._client())

    @property
    def rbac(self) -> client.RbacAuthorizationV1Api:
        return client.RbacAuthorizationV1Api(api_client=self._client())

    @property
    def authz(self) -> client.AuthorizationV1Api:
        return client.AuthorizationV1Api(api_client=self._client())

    # ── 네임스페이스 ───────────────────────────────────────────────────────
    def list_namespaces(self) -> list[dict]:
        items = self.core.list_namespace().items
        return [
            {
                "name": ns.metadata.name,
                "status": (ns.status.phase if ns.status else None) or "Unknown",
                "labels": ns.metadata.labels or {},
                "created_at": _ts(ns.metadata),
            }
            for ns in items
        ]

    # ── ServiceAccount ────────────────────────────────────────────────────
    def list_service_accounts(self, namespace: str | None = None) -> list[dict]:
        if namespace:
            items = self.core.list_namespaced_service_account(namespace).items
        else:
            items = self.core.list_service_account_for_all_namespaces().items
        # 바인딩 요약을 붙이려면 전체 바인딩을 한 번만 읽어 인덱싱한다(SA 수만큼 조회 금지).
        binding_index = self._binding_index()
        out: list[dict] = []
        for sa in items:
            key = (sa.metadata.namespace, sa.metadata.name)
            out.append(
                {
                    "name": sa.metadata.name,
                    "namespace": sa.metadata.namespace,
                    "labels": sa.metadata.labels or {},
                    "annotations": sa.metadata.annotations or {},
                    "secrets": [s.name for s in (sa.secrets or []) if getattr(s, "name", None)],
                    "created_at": _ts(sa.metadata),
                    "bindings": binding_index.get(key, []),
                    "managed_by_pep": (sa.metadata.labels or {}).get("app.kubernetes.io/managed-by")
                    == "pep",
                }
            )
        out.sort(key=lambda r: (r["namespace"] or "", r["name"]))
        return out

    def _binding_index(self) -> dict[tuple[str, str], list[dict]]:
        """(namespace, sa_name) → 그 SA 를 subject 로 가진 바인딩 요약 목록."""
        index: dict[tuple[str, str], list[dict]] = {}

        def _add(subjects, entry: dict) -> None:
            for sub in subjects or []:
                if getattr(sub, "kind", None) != "ServiceAccount":
                    continue
                key = (getattr(sub, "namespace", None) or "", getattr(sub, "name", "") or "")
                index.setdefault(key, []).append(entry)

        try:
            for rb in self.rbac.list_role_binding_for_all_namespaces().items:
                _add(
                    rb.subjects,
                    {
                        "kind": "RoleBinding",
                        "name": rb.metadata.name,
                        "namespace": rb.metadata.namespace,
                        "role_kind": rb.role_ref.kind,
                        "role_name": rb.role_ref.name,
                    },
                )
        except ApiException:
            pass  # 조회 권한이 없어도 SA 목록 자체는 보여준다
        try:
            for crb in self.rbac.list_cluster_role_binding().items:
                _add(
                    crb.subjects,
                    {
                        "kind": "ClusterRoleBinding",
                        "name": crb.metadata.name,
                        "namespace": None,
                        "role_kind": crb.role_ref.kind,
                        "role_name": crb.role_ref.name,
                    },
                )
        except ApiException:
            pass
        return index

    def create_service_account(
        self,
        namespace: str,
        name: str,
        labels: dict[str, str] | None = None,
        annotations: dict[str, str] | None = None,
    ) -> dict:
        namespace = validate_k8s_name(namespace, "네임스페이스")
        name = validate_k8s_name(name, "ServiceAccount 이름")
        body = client.V1ServiceAccount(
            metadata=client.V1ObjectMeta(
                name=name,
                namespace=namespace,
                labels={**(labels or {}), "app.kubernetes.io/managed-by": "pep"},
                annotations=annotations or None,
            )
        )
        sa = self.core.create_namespaced_service_account(namespace=namespace, body=body)
        return {
            "name": sa.metadata.name,
            "namespace": sa.metadata.namespace,
            "labels": sa.metadata.labels or {},
            "annotations": sa.metadata.annotations or {},
            "secrets": [],
            "created_at": _ts(sa.metadata),
            "bindings": [],
            "managed_by_pep": True,
        }

    def delete_service_account(self, namespace: str, name: str) -> None:
        if name in PROTECTED_SERVICE_ACCOUNTS:
            raise ValueError(
                f"'{name}' 은(는) 네임스페이스 기본 ServiceAccount 라 삭제할 수 없습니다."
            )
        self.core.delete_namespaced_service_account(name=name, namespace=namespace)

    # ── Role / ClusterRole ────────────────────────────────────────────────
    @staticmethod
    def _role_row(obj: Any, scope: str) -> dict:
        rules = [rule_to_dict(r) for r in (obj.rules or [])]
        name = obj.metadata.name
        return {
            "name": name,
            "namespace": obj.metadata.namespace if scope == "namespace" else None,
            "scope": scope,
            "rules": rules,
            "rule_count": len(rules),
            "labels": obj.metadata.labels or {},
            "created_at": _ts(obj.metadata),
            "builtin": name in PROTECTED_CLUSTER_ROLES
            or name.startswith(SYSTEM_NAME_PREFIXES),
        }

    def list_roles(self, namespace: str | None = None) -> list[dict]:
        if namespace:
            items = self.rbac.list_namespaced_role(namespace).items
        else:
            items = self.rbac.list_role_for_all_namespaces().items
        rows = [self._role_row(r, "namespace") for r in items]
        rows.sort(key=lambda r: (r["namespace"] or "", r["name"]))
        return rows

    def list_cluster_roles(self, include_system: bool = False) -> list[dict]:
        items = self.rbac.list_cluster_role().items
        rows = [self._role_row(r, "cluster") for r in items]
        if not include_system:
            rows = [r for r in rows if not r["name"].startswith(SYSTEM_NAME_PREFIXES)]
        rows.sort(key=lambda r: r["name"])
        return rows

    def get_role(self, namespace: str, name: str) -> dict:
        return self._role_row(self.rbac.read_namespaced_role(name=name, namespace=namespace), "namespace")

    def get_cluster_role(self, name: str) -> dict:
        return self._role_row(self.rbac.read_cluster_role(name=name), "cluster")

    @staticmethod
    def _assert_writable(name: str, scope: str) -> None:
        if name.startswith(SYSTEM_NAME_PREFIXES) or (
            scope == "cluster" and name in PROTECTED_CLUSTER_ROLES
        ):
            raise ValueError(
                f"'{name}' 은(는) 쿠버네티스 빌트인 롤이라 이 화면에서 수정·삭제할 수 없습니다."
            )

    def upsert_role(
        self, namespace: str, name: str, rules: list[dict], labels: dict[str, str] | None = None
    ) -> dict:
        namespace = validate_k8s_name(namespace, "네임스페이스")
        name = validate_k8s_name(name, "Role 이름")
        self._assert_writable(name, "namespace")
        policy_rules = [client.V1PolicyRule(**r) for r in normalize_rules(rules)]
        meta = client.V1ObjectMeta(
            name=name,
            namespace=namespace,
            labels={**(labels or {}), "app.kubernetes.io/managed-by": "pep"},
        )
        body = client.V1Role(metadata=meta, rules=policy_rules)
        try:
            obj = self.rbac.replace_namespaced_role(name=name, namespace=namespace, body=body)
        except ApiException as e:
            if e.status != 404:
                raise
            obj = self.rbac.create_namespaced_role(namespace=namespace, body=body)
        return self._role_row(obj, "namespace")

    def upsert_cluster_role(
        self, name: str, rules: list[dict], labels: dict[str, str] | None = None
    ) -> dict:
        name = validate_k8s_name(name, "ClusterRole 이름")
        self._assert_writable(name, "cluster")
        policy_rules = [client.V1PolicyRule(**r) for r in normalize_rules(rules)]
        meta = client.V1ObjectMeta(
            name=name, labels={**(labels or {}), "app.kubernetes.io/managed-by": "pep"}
        )
        body = client.V1ClusterRole(metadata=meta, rules=policy_rules)
        try:
            obj = self.rbac.replace_cluster_role(name=name, body=body)
        except ApiException as e:
            if e.status != 404:
                raise
            obj = self.rbac.create_cluster_role(body=body)
        return self._role_row(obj, "cluster")

    def delete_role(self, namespace: str, name: str) -> None:
        self._assert_writable(name, "namespace")
        self.rbac.delete_namespaced_role(name=name, namespace=namespace)

    def delete_cluster_role(self, name: str) -> None:
        self._assert_writable(name, "cluster")
        self.rbac.delete_cluster_role(name=name)

    # ── Binding ───────────────────────────────────────────────────────────
    @staticmethod
    def _binding_row(obj: Any, kind: str) -> dict:
        name = obj.metadata.name
        return {
            "kind": kind,
            "name": name,
            "namespace": obj.metadata.namespace if kind == "RoleBinding" else None,
            "role_kind": obj.role_ref.kind,
            "role_name": obj.role_ref.name,
            "subjects": [
                {
                    "kind": s.kind,
                    "name": s.name,
                    "namespace": getattr(s, "namespace", None),
                    "api_group": getattr(s, "api_group", None),
                }
                for s in (obj.subjects or [])
            ],
            "labels": obj.metadata.labels or {},
            "created_at": _ts(obj.metadata),
            "builtin": name.startswith(SYSTEM_NAME_PREFIXES),
        }

    def list_bindings(self, namespace: str | None = None, include_system: bool = False) -> list[dict]:
        rows: list[dict] = []
        if namespace:
            items = self.rbac.list_namespaced_role_binding(namespace).items
        else:
            items = self.rbac.list_role_binding_for_all_namespaces().items
        rows.extend(self._binding_row(rb, "RoleBinding") for rb in items)
        # ClusterRoleBinding 은 네임스페이스가 없다 — 특정 ns 필터일 때는 그 ns 의 SA 를
        # subject 로 가진 것만 남긴다(그 ns 개발자에게 실제로 영향 주는 것들).
        crbs = [self._binding_row(crb, "ClusterRoleBinding") for crb in self.rbac.list_cluster_role_binding().items]
        if namespace:
            crbs = [
                b
                for b in crbs
                if any(s["kind"] == "ServiceAccount" and s["namespace"] == namespace for s in b["subjects"])
            ]
        rows.extend(crbs)
        if not include_system:
            rows = [r for r in rows if not r["builtin"]]
        rows.sort(key=lambda r: (r["kind"], r["namespace"] or "", r["name"]))
        return rows

    def create_binding(
        self,
        kind: str,
        name: str,
        role_kind: str,
        role_name: str,
        subjects: list[dict],
        namespace: str | None = None,
        labels: dict[str, str] | None = None,
    ) -> dict:
        name = validate_k8s_name(name, "Binding 이름")
        if kind not in ("RoleBinding", "ClusterRoleBinding"):
            raise ValueError("kind 는 RoleBinding 또는 ClusterRoleBinding 이어야 합니다.")
        if role_kind not in ("Role", "ClusterRole"):
            raise ValueError("roleKind 는 Role 또는 ClusterRole 이어야 합니다.")
        if kind == "ClusterRoleBinding" and role_kind == "Role":
            raise ValueError("ClusterRoleBinding 은 ClusterRole 만 참조할 수 있습니다.")
        if kind == "RoleBinding" and not namespace:
            raise ValueError("RoleBinding 에는 네임스페이스가 필요합니다.")
        if not subjects:
            raise ValueError("subject(대상)가 최소 하나 필요합니다.")

        subject_objs = []
        for s in subjects:
            s_kind = (s.get("kind") or "ServiceAccount").strip()
            if s_kind not in ("ServiceAccount", "User", "Group"):
                raise ValueError(f"지원하지 않는 subject kind: {s_kind}")
            subject_objs.append(
                client.V1Subject(
                    kind=s_kind,
                    name=validate_k8s_name(s.get("name", ""), "subject 이름")
                    if s_kind == "ServiceAccount"
                    else (s.get("name") or "").strip(),
                    namespace=(s.get("namespace") or None) if s_kind == "ServiceAccount" else None,
                    api_group="" if s_kind == "ServiceAccount" else "rbac.authorization.k8s.io",
                )
            )
        role_ref = client.V1RoleRef(
            api_group="rbac.authorization.k8s.io", kind=role_kind, name=role_name
        )
        merged_labels = {**(labels or {}), "app.kubernetes.io/managed-by": "pep"}
        if kind == "RoleBinding":
            body = client.V1RoleBinding(
                metadata=client.V1ObjectMeta(name=name, namespace=namespace, labels=merged_labels),
                role_ref=role_ref,
                subjects=subject_objs,
            )
            obj = self._replace_or_create_role_binding(namespace, name, body)
            return self._binding_row(obj, "RoleBinding")
        body = client.V1ClusterRoleBinding(
            metadata=client.V1ObjectMeta(name=name, labels=merged_labels),
            role_ref=role_ref,
            subjects=subject_objs,
        )
        obj = self._replace_or_create_cluster_role_binding(name, body)
        return self._binding_row(obj, "ClusterRoleBinding")

    def _replace_or_create_role_binding(self, namespace: str, name: str, body: Any) -> Any:
        try:
            return self.rbac.replace_namespaced_role_binding(name=name, namespace=namespace, body=body)
        except ApiException as e:
            if e.status == 404:
                return self.rbac.create_namespaced_role_binding(namespace=namespace, body=body)
            if e.status in (409, 422):
                # roleRef 는 immutable — 참조 롤이 바뀌면 지우고 다시 만든다.
                self.rbac.delete_namespaced_role_binding(name=name, namespace=namespace)
                return self.rbac.create_namespaced_role_binding(namespace=namespace, body=body)
            raise

    def _replace_or_create_cluster_role_binding(self, name: str, body: Any) -> Any:
        try:
            return self.rbac.replace_cluster_role_binding(name=name, body=body)
        except ApiException as e:
            if e.status == 404:
                return self.rbac.create_cluster_role_binding(body=body)
            if e.status in (409, 422):
                self.rbac.delete_cluster_role_binding(name=name)
                return self.rbac.create_cluster_role_binding(body=body)
            raise

    def delete_binding(self, kind: str, name: str, namespace: str | None = None) -> None:
        if name.startswith(SYSTEM_NAME_PREFIXES):
            raise ValueError(f"'{name}' 은(는) 빌트인 바인딩이라 삭제할 수 없습니다.")
        if kind == "RoleBinding":
            if not namespace:
                raise ValueError("RoleBinding 삭제에는 네임스페이스가 필요합니다.")
            self.rbac.delete_namespaced_role_binding(name=name, namespace=namespace)
        elif kind == "ClusterRoleBinding":
            self.rbac.delete_cluster_role_binding(name=name)
        else:
            raise ValueError("kind 는 RoleBinding 또는 ClusterRoleBinding 이어야 합니다.")

    # ── 토큰 / kubeconfig ─────────────────────────────────────────────────
    def issue_token(self, namespace: str, name: str, expiration_seconds: int) -> dict:
        """TokenRequest API 로 SA 의 단기 토큰을 발급한다(K8s 1.22+)."""
        ttl = max(600, min(int(expiration_seconds or DEFAULT_TOKEN_TTL_SECONDS), MAX_TOKEN_TTL_SECONDS))
        body = client.AuthenticationV1TokenRequest(
            api_version="authentication.k8s.io/v1",
            kind="TokenRequest",
            spec=client.V1TokenRequestSpec(audiences=[], expiration_seconds=ttl),
        )
        resp = self.core.create_namespaced_service_account_token(
            name=name, namespace=namespace, body=body
        )
        expiration = getattr(resp.status, "expiration_timestamp", None)
        return {
            "token": resp.status.token,
            "expires_at": expiration.astimezone(timezone.utc).isoformat()
            if isinstance(expiration, datetime)
            else None,
            "requested_ttl_seconds": ttl,
            "mode": "ephemeral",
        }

    def issue_long_lived_token(self, namespace: str, name: str) -> dict:
        """만료 없는 Secret 기반 토큰(K8s 1.24+ 에서는 수동 Secret 생성이 필요)."""
        secret_name = f"{name}-pep-token"
        body = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name=secret_name,
                namespace=namespace,
                annotations={"kubernetes.io/service-account.name": name},
                labels={"app.kubernetes.io/managed-by": "pep"},
            ),
            type="kubernetes.io/service-account-token",
        )
        try:
            self.core.create_namespaced_secret(namespace=namespace, body=body)
        except ApiException as e:
            if e.status != 409:
                raise
        # 컨트롤러가 토큰을 채울 때까지 잠깐 기다린다(보통 1초 이내).
        import time

        token = ""
        for _ in range(10):
            secret = self.core.read_namespaced_secret(name=secret_name, namespace=namespace)
            raw = (secret.data or {}).get("token")
            if raw:
                token = base64.b64decode(raw).decode("utf-8")
                break
            time.sleep(0.5)
        if not token:
            raise ValueError(
                f"Secret '{secret_name}' 에 토큰이 채워지지 않았습니다 — "
                "TokenController 가 비활성인 클러스터일 수 있습니다. 단기 토큰을 사용하세요."
            )
        return {
            "token": token,
            "expires_at": None,
            "requested_ttl_seconds": None,
            "mode": "long_lived",
            "secret_name": secret_name,
        }

    def cluster_endpoint(self) -> tuple[str, str | None, bool]:
        """(API server URL, CA 인증서 base64 | None, insecure 여부)."""
        path = self._kubeconfig_path
        if path is None:
            self._configuration()
            path = self._kubeconfig_path
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    kc = yaml.safe_load(f) or {}
                contexts = {c.get("name"): c.get("context", {}) for c in kc.get("contexts") or []}
                ctx = contexts.get(kc.get("current-context")) or next(iter(contexts.values()), {})
                target = ctx.get("cluster")
                for entry in kc.get("clusters") or []:
                    if target and entry.get("name") != target:
                        continue
                    spec = entry.get("cluster") or {}
                    ca = spec.get("certificate-authority-data")
                    ca_file = spec.get("certificate-authority")
                    if not ca and ca_file and os.path.exists(ca_file):
                        with open(ca_file, "rb") as cf:
                            ca = base64.b64encode(cf.read()).decode("ascii")
                    return (
                        spec.get("server") or self.cluster.api_endpoint,
                        ca,
                        bool(spec.get("insecure-skip-tls-verify")),
                    )
            except Exception:  # noqa: BLE001 — 파싱 실패 시 in-cluster/등록값으로 폴백
                pass
        host = os.environ.get("KUBERNETES_SERVICE_HOST")
        port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
        sa_ca = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
        if host and os.path.exists(sa_ca):
            with open(sa_ca, "rb") as cf:
                return f"https://{host}:{port}", base64.b64encode(cf.read()).decode("ascii"), False
        return self.cluster.api_endpoint, None, True

    def build_kubeconfig(
        self, namespace: str, sa_name: str, token: str, context_name: str | None = None
    ) -> str:
        server, ca_data, insecure = self.cluster_endpoint()
        cluster_key = re.sub(r"[^a-zA-Z0-9._-]+", "-", self.cluster.name).strip("-") or "cluster"
        user_key = f"{sa_name}-{namespace}"
        ctx = context_name or f"{user_key}@{cluster_key}"
        cluster_spec: dict[str, Any] = {"server": server}
        if ca_data:
            cluster_spec["certificate-authority-data"] = ca_data
        else:
            cluster_spec["insecure-skip-tls-verify"] = True if insecure else False
        return yaml.safe_dump(
            {
                "apiVersion": "v1",
                "kind": "Config",
                "clusters": [{"name": cluster_key, "cluster": cluster_spec}],
                "users": [{"name": user_key, "user": {"token": token}}],
                "contexts": [
                    {
                        "name": ctx,
                        "context": {
                            "cluster": cluster_key,
                            "user": user_key,
                            "namespace": namespace,
                        },
                    }
                ],
                "current-context": ctx,
                "preferences": {},
            },
            sort_keys=False,
            allow_unicode=True,
        )

    # ── 권한 점검 (SubjectAccessReview) ───────────────────────────────────
    def access_review(
        self, namespace: str, sa_name: str, checks: list[dict], sa_namespace: str | None = None
    ) -> list[dict]:
        """"이 SA 가 이 네임스페이스에서 X 를 할 수 있나" 를 API server 에 직접 물어본다.

        규칙을 눈으로 읽어 추측하는 대신 실제 인가 결과를 받아오므로, 여러 바인딩이
        겹친 상태에서도 개발자가 정말 배포·로그 조회를 할 수 있는지 확정할 수 있다.
        """
        user = f"system:serviceaccount:{sa_namespace or namespace}:{sa_name}"
        out: list[dict] = []
        for chk in checks:
            attrs = client.V1ResourceAttributes(
                namespace=chk.get("namespace") or namespace or None,
                verb=chk.get("verb"),
                group=chk.get("group") or "",
                resource=chk.get("resource"),
                subresource=chk.get("subresource") or None,
            )
            review = client.V1SubjectAccessReview(
                spec=client.V1SubjectAccessReviewSpec(
                    user=user,
                    groups=["system:serviceaccounts", f"system:serviceaccounts:{sa_namespace or namespace}"],
                    resource_attributes=attrs,
                )
            )
            try:
                resp = self.authz.create_subject_access_review(body=review)
                status = resp.status
                out.append(
                    {
                        "label": chk.get("label") or f"{chk.get('verb')} {chk.get('resource')}",
                        "namespace": chk.get("namespace") or namespace,
                        "verb": chk.get("verb"),
                        "resource": chk.get("resource"),
                        "subresource": chk.get("subresource"),
                        "allowed": bool(getattr(status, "allowed", False)),
                        "reason": getattr(status, "reason", None),
                    }
                )
            except ApiException as e:
                _, detail = map_k8s_error(e)
                out.append(
                    {
                        "label": chk.get("label") or f"{chk.get('verb')} {chk.get('resource')}",
                        "namespace": chk.get("namespace") or namespace,
                        "verb": chk.get("verb"),
                        "resource": chk.get("resource"),
                        "subresource": chk.get("subresource"),
                        "allowed": False,
                        "reason": f"점검 실패: {detail}",
                    }
                )
        return out

    # ── 프로비저닝 (SA + Role/ClusterRole + Binding 한 번에) ──────────────
    def provision(self, spec: dict) -> Iterator[dict]:
        """개발자 액세스 일괄 생성. 단계마다 로그 이벤트를 yield 한다.

        이벤트 모양: ``{"type": "log"|"step"|"result"|"error", ...}``
        """
        started = datetime.now(timezone.utc)

        def log(message: str, level: str = "info") -> dict:
            return {
                "type": "log",
                "level": level,
                "ts": datetime.now(timezone.utc).isoformat(),
                "message": message,
            }

        namespace = validate_k8s_name(spec.get("namespace", ""), "주 네임스페이스")
        sa_name = validate_k8s_name(spec.get("service_account", ""), "ServiceAccount 이름")
        extra_namespaces = [
            validate_k8s_name(n, "추가 네임스페이스")
            for n in (spec.get("extra_namespaces") or [])
            if str(n).strip()
        ]
        binding_mode = spec.get("binding_mode") or "clusterrole-rolebinding"
        if binding_mode not in ("role-per-namespace", "clusterrole-rolebinding", "clusterrole-clusterrolebinding"):
            raise ValueError(f"알 수 없는 binding_mode: {binding_mode}")
        rules = normalize_rules(spec.get("rules"))
        role_name = (spec.get("role_name") or f"pep-{sa_name}").strip()
        validate_k8s_name(role_name, "Role 이름")
        target_namespaces = [namespace] + [n for n in extra_namespaces if n != namespace]
        created: list[dict] = []
        dry_run = bool(spec.get("dry_run"))

        yield log(
            f"클러스터 '{self.cluster.name}' 에 개발자 액세스 생성을 시작합니다"
            f"{' (모의 실행 — 실제 변경 없음)' if dry_run else ''}."
        )
        yield log(
            f"대상: ServiceAccount {namespace}/{sa_name} · 네임스페이스 {', '.join(target_namespaces)} "
            f"· 방식 {binding_mode} · 규칙 {len(rules)}줄"
        )

        # 0) 네임스페이스 존재 확인
        yield {"type": "step", "name": "namespace-check", "status": "running"}
        existing_ns = {ns["name"] for ns in self.list_namespaces()}
        missing = [n for n in target_namespaces if n not in existing_ns]
        if missing:
            if not spec.get("create_namespace"):
                raise ValueError(
                    f"존재하지 않는 네임스페이스: {', '.join(missing)} — "
                    "'없으면 생성' 을 켜거나 이름을 확인하세요."
                )
            for n in missing:
                if dry_run:
                    yield log(f"[dry-run] 네임스페이스 '{n}' 생성 예정")
                    continue
                self.core.create_namespace(
                    body=client.V1Namespace(metadata=client.V1ObjectMeta(name=n))
                )
                created.append({"kind": "Namespace", "name": n, "namespace": None})
                yield log(f"네임스페이스 '{n}' 생성 완료")
        else:
            yield log(f"네임스페이스 {len(target_namespaces)}개 모두 존재 확인")
        yield {"type": "step", "name": "namespace-check", "status": "done"}

        # 1) ServiceAccount
        yield {"type": "step", "name": "service-account", "status": "running"}
        if dry_run:
            yield log(f"[dry-run] ServiceAccount {namespace}/{sa_name} 생성 예정")
        else:
            try:
                self.create_service_account(namespace, sa_name)
                created.append({"kind": "ServiceAccount", "name": sa_name, "namespace": namespace})
                yield log(f"ServiceAccount {namespace}/{sa_name} 생성 완료")
            except ApiException as e:
                if e.status != 409:
                    raise
                yield log(f"ServiceAccount {namespace}/{sa_name} 이(가) 이미 있어 재사용합니다.", "warn")
        yield {"type": "step", "name": "service-account", "status": "done"}

        # 2) 권한 오브젝트 (Role / ClusterRole)
        yield {"type": "step", "name": "role", "status": "running"}
        if binding_mode == "role-per-namespace":
            for n in target_namespaces:
                if dry_run:
                    yield log(f"[dry-run] Role {n}/{role_name} 적용 예정 ({len(rules)}줄)")
                    continue
                self.upsert_role(n, role_name, rules)
                created.append({"kind": "Role", "name": role_name, "namespace": n})
                yield log(f"Role {n}/{role_name} 적용 완료 ({len(rules)}줄)")
        else:
            if dry_run:
                yield log(f"[dry-run] ClusterRole {role_name} 적용 예정 ({len(rules)}줄)")
            else:
                self.upsert_cluster_role(role_name, rules)
                created.append({"kind": "ClusterRole", "name": role_name, "namespace": None})
                yield log(f"ClusterRole {role_name} 적용 완료 ({len(rules)}줄)")
        yield {"type": "step", "name": "role", "status": "done"}

        # 3) 바인딩
        yield {"type": "step", "name": "binding", "status": "running"}
        subject = [{"kind": "ServiceAccount", "name": sa_name, "namespace": namespace}]
        binding_name = (spec.get("binding_name") or f"pep-{sa_name}").strip()
        validate_k8s_name(binding_name, "Binding 이름")
        if binding_mode == "clusterrole-clusterrolebinding":
            if dry_run:
                yield log(f"[dry-run] ClusterRoleBinding {binding_name} 적용 예정 (클러스터 전역)")
            else:
                self.create_binding(
                    kind="ClusterRoleBinding",
                    name=binding_name,
                    role_kind="ClusterRole",
                    role_name=role_name,
                    subjects=subject,
                )
                created.append({"kind": "ClusterRoleBinding", "name": binding_name, "namespace": None})
                yield log(
                    f"ClusterRoleBinding {binding_name} 적용 완료 — 이 SA 는 **모든 네임스페이스**에서 "
                    "위 권한을 갖습니다.",
                    "warn",
                )
        else:
            role_kind = "Role" if binding_mode == "role-per-namespace" else "ClusterRole"
            for n in target_namespaces:
                if dry_run:
                    yield log(f"[dry-run] RoleBinding {n}/{binding_name} → {role_kind}/{role_name} 적용 예정")
                    continue
                self.create_binding(
                    kind="RoleBinding",
                    name=binding_name,
                    role_kind=role_kind,
                    role_name=role_name,
                    subjects=subject,
                    namespace=n,
                )
                created.append({"kind": "RoleBinding", "name": binding_name, "namespace": n})
                yield log(f"RoleBinding {n}/{binding_name} → {role_kind}/{role_name} 적용 완료")
        yield {"type": "step", "name": "binding", "status": "done"}

        # 4) 권한 검증 — 정말로 배포/로그가 되는지 API server 에 확인
        review: list[dict] = []
        if spec.get("verify", True) and not dry_run:
            yield {"type": "step", "name": "verify", "status": "running"}
            checks = default_access_checks(target_namespaces)
            review = self.access_review(namespace, sa_name, checks, sa_namespace=namespace)
            allowed = sum(1 for r in review if r["allowed"])
            for r in review:
                yield log(
                    f"{'✔' if r['allowed'] else '✘'} [{r['namespace']}] {r['label']}"
                    + (f" — {r['reason']}" if r.get("reason") and not r["allowed"] else ""),
                    "info" if r["allowed"] else "warn",
                )
            yield log(f"권한 점검 {allowed}/{len(review)} 통과")
            yield {"type": "step", "name": "verify", "status": "done"}

        # 5) kubeconfig 발급
        kubeconfig = None
        token_info: dict | None = None
        if spec.get("issue_kubeconfig", True) and not dry_run:
            yield {"type": "step", "name": "kubeconfig", "status": "running"}
            if spec.get("long_lived_token"):
                token_info = self.issue_long_lived_token(namespace, sa_name)
                yield log(
                    f"만료 없는 Secret 토큰 발급 완료 ({token_info.get('secret_name')}) — "
                    "유출 시 회수는 Secret 삭제로 합니다.",
                    "warn",
                )
            else:
                token_info = self.issue_token(
                    namespace, sa_name, int(spec.get("token_ttl_seconds") or DEFAULT_TOKEN_TTL_SECONDS)
                )
                yield log(f"단기 토큰 발급 완료 — 만료 {token_info.get('expires_at') or '미상'}")
            kubeconfig = self.build_kubeconfig(namespace, sa_name, token_info["token"])
            yield log("kubeconfig 생성 완료 — 개발자 PC 의 ~/.kube/config 로 저장해 사용하세요.")
            yield {"type": "step", "name": "kubeconfig", "status": "done"}

        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        yield log(f"완료 — {elapsed:.1f}초, 생성/갱신 오브젝트 {len(created)}개")
        yield {
            "type": "result",
            "namespace": namespace,
            "service_account": sa_name,
            "namespaces": target_namespaces,
            "binding_mode": binding_mode,
            "role_name": role_name,
            "binding_name": binding_name,
            "created": created,
            "access_review": review,
            "kubeconfig": kubeconfig,
            "token_expires_at": (token_info or {}).get("expires_at"),
            "dry_run": dry_run,
            "elapsed_seconds": round(elapsed, 2),
        }


def default_access_checks(namespaces: list[str]) -> list[dict]:
    """"개발자가 LOCAL 에서 접근·배포·로그" 기준을 그대로 옮긴 검증 목록."""
    base = [
        {"label": "파드 조회", "verb": "list", "group": "", "resource": "pods"},
        {"label": "파드 로그 조회", "verb": "get", "group": "", "resource": "pods", "subresource": "log"},
        {"label": "Deployment 생성", "verb": "create", "group": "apps", "resource": "deployments"},
        {"label": "Deployment 수정", "verb": "patch", "group": "apps", "resource": "deployments"},
        {"label": "Service 생성", "verb": "create", "group": "", "resource": "services"},
        {"label": "ConfigMap 생성", "verb": "create", "group": "", "resource": "configmaps"},
        {"label": "파드 exec", "verb": "create", "group": "", "resource": "pods", "subresource": "exec"},
    ]
    return [{**chk, "namespace": ns} for ns in namespaces for chk in base]
