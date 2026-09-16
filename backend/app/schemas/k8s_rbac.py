"""K8s RBAC 관리 화면(`/k8s-rbac`)용 Pydantic 스키마."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


# ── 공통 ───────────────────────────────────────────────────────────────────
class PolicyRuleModel(BaseModel):
    api_groups: list[str] = Field(default_factory=lambda: [""])
    resources: list[str] = Field(default_factory=list)
    verbs: list[str] = Field(default_factory=list)
    resource_names: list[str] = Field(default_factory=list)
    non_resource_urls: list[str] = Field(default_factory=list)


class NamespaceInfo(BaseModel):
    name: str
    status: str = "Unknown"
    labels: dict[str, str] = Field(default_factory=dict)
    created_at: Optional[str] = None


class NamespaceListResponse(BaseModel):
    data: list[NamespaceInfo]


# ── ServiceAccount ────────────────────────────────────────────────────────
class BindingSummary(BaseModel):
    kind: str
    name: str
    namespace: Optional[str] = None
    role_kind: str
    role_name: str


class ServiceAccountInfo(BaseModel):
    name: str
    namespace: str
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    secrets: list[str] = Field(default_factory=list)
    created_at: Optional[str] = None
    bindings: list[BindingSummary] = Field(default_factory=list)
    managed_by_pep: bool = False


class ServiceAccountListResponse(BaseModel):
    data: list[ServiceAccountInfo]


class ServiceAccountCreateRequest(BaseModel):
    namespace: str
    name: str
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)


class ServiceAccountResponse(BaseModel):
    message: str
    data: ServiceAccountInfo


# ── Role / ClusterRole ────────────────────────────────────────────────────
class RoleInfo(BaseModel):
    name: str
    namespace: Optional[str] = None
    scope: Literal["namespace", "cluster"]
    rules: list[PolicyRuleModel] = Field(default_factory=list)
    rule_count: int = 0
    labels: dict[str, str] = Field(default_factory=dict)
    created_at: Optional[str] = None
    builtin: bool = False


class RoleListResponse(BaseModel):
    data: list[RoleInfo]


class RoleUpsertRequest(BaseModel):
    """Role/ClusterRole 생성·편집 공통 본문 (이름/네임스페이스는 경로에서 받는다)."""

    rules: list[PolicyRuleModel]
    labels: dict[str, str] = Field(default_factory=dict)


class RoleResponse(BaseModel):
    message: str
    data: RoleInfo


# ── Binding ───────────────────────────────────────────────────────────────
class SubjectModel(BaseModel):
    kind: Literal["ServiceAccount", "User", "Group"] = "ServiceAccount"
    name: str
    namespace: Optional[str] = None
    api_group: Optional[str] = None


class BindingInfo(BaseModel):
    kind: Literal["RoleBinding", "ClusterRoleBinding"]
    name: str
    namespace: Optional[str] = None
    role_kind: str
    role_name: str
    subjects: list[SubjectModel] = Field(default_factory=list)
    labels: dict[str, str] = Field(default_factory=dict)
    created_at: Optional[str] = None
    builtin: bool = False


class BindingListResponse(BaseModel):
    data: list[BindingInfo]


class BindingCreateRequest(BaseModel):
    kind: Literal["RoleBinding", "ClusterRoleBinding"] = "RoleBinding"
    name: str
    namespace: Optional[str] = None
    role_kind: Literal["Role", "ClusterRole"] = "ClusterRole"
    role_name: str
    subjects: list[SubjectModel]
    labels: dict[str, str] = Field(default_factory=dict)


class BindingResponse(BaseModel):
    message: str
    data: BindingInfo


# ── 프리셋 ─────────────────────────────────────────────────────────────────
class PresetInfo(BaseModel):
    key: str
    name: str
    summary: str
    description: str
    recommended_binding_mode: str
    risk: Literal["low", "medium", "high"]
    rules: list[PolicyRuleModel]


class BindingModeInfo(BaseModel):
    key: str
    name: str
    description: str


class PresetCatalogResponse(BaseModel):
    presets: list[PresetInfo]
    binding_modes: list[BindingModeInfo]


# ── 프로비저닝 ─────────────────────────────────────────────────────────────
class ProvisionRequest(BaseModel):
    """개발자 액세스 일괄 생성 요청.

    `namespace` 가 개발자의 주 배포 네임스페이스, `extra_namespaces` 가 "다른 네임스페이스도
    권한이 필요할 때" 추가로 같은 권한을 붙일 네임스페이스다.
    """

    namespace: str
    service_account: str
    extra_namespaces: list[str] = Field(default_factory=list)
    binding_mode: Literal[
        "clusterrole-rolebinding", "role-per-namespace", "clusterrole-clusterrolebinding"
    ] = "clusterrole-rolebinding"
    rules: list[PolicyRuleModel]
    role_name: Optional[str] = None
    binding_name: Optional[str] = None
    preset_key: Optional[str] = None
    create_namespace: bool = False
    verify: bool = True
    issue_kubeconfig: bool = True
    long_lived_token: bool = False
    token_ttl_seconds: int = 7 * 24 * 3600
    dry_run: bool = False


class ProvisionCreatedObject(BaseModel):
    kind: str
    name: str
    namespace: Optional[str] = None


class AccessReviewEntry(BaseModel):
    label: str
    namespace: Optional[str] = None
    verb: Optional[str] = None
    resource: Optional[str] = None
    subresource: Optional[str] = None
    allowed: bool = False
    reason: Optional[str] = None


class ProvisionLogLine(BaseModel):
    level: str = "info"
    ts: Optional[str] = None
    message: str


class ProvisionResult(BaseModel):
    namespace: str
    service_account: str
    namespaces: list[str] = Field(default_factory=list)
    binding_mode: str
    role_name: str
    binding_name: str
    created: list[ProvisionCreatedObject] = Field(default_factory=list)
    access_review: list[AccessReviewEntry] = Field(default_factory=list)
    kubeconfig: Optional[str] = None
    token_expires_at: Optional[str] = None
    dry_run: bool = False
    elapsed_seconds: float = 0.0
    logs: list[ProvisionLogLine] = Field(default_factory=list)


# ── 토큰 / kubeconfig ─────────────────────────────────────────────────────
class KubeconfigRequest(BaseModel):
    namespace: str
    service_account: str
    long_lived_token: bool = False
    token_ttl_seconds: int = 7 * 24 * 3600
    context_name: Optional[str] = None


class KubeconfigResponse(BaseModel):
    kubeconfig: str
    expires_at: Optional[str] = None
    mode: str = "ephemeral"
    server: str
    namespace: str
    service_account: str


# ── 권한 점검 ──────────────────────────────────────────────────────────────
class AccessCheckItem(BaseModel):
    label: Optional[str] = None
    namespace: Optional[str] = None
    verb: str
    group: str = ""
    resource: str
    subresource: Optional[str] = None


class AccessReviewRequest(BaseModel):
    namespace: str
    service_account: str
    namespaces: list[str] = Field(default_factory=list)
    checks: list[AccessCheckItem] = Field(default_factory=list)


class AccessReviewResponse(BaseModel):
    data: list[AccessReviewEntry]
