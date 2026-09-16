"""개발자 액세스 권한 프리셋.

여기 있는 값은 **시작 템플릿**이다. 현장마다 쓰는 CRD(argoproj, cilium, monitoring …)나
사내 정책이 다르므로, 화면은 프리셋을 고른 뒤 규칙 표를 그대로 펼쳐 편집할 수 있어야 한다
(CLAUDE.md UI-First 원칙 — "환경에 따라 달라지는 값은 코드가 아니라 화면에서").

각 프리셋의 ``rules`` 는 K8s PolicyRule 과 같은 모양(snake_case)이며
``RbacService.normalize_rules`` 가 그대로 받는다.
"""
from __future__ import annotations

from typing import Any

# 자주 쓰는 verb 묶음
READ = ["get", "list", "watch"]
WRITE = ["get", "list", "watch", "create", "update", "patch", "delete"]

# 개발자가 자기 네임스페이스에 서비스를 올릴 때 건드리는 워크로드 리소스
_WORKLOAD_RULES: list[dict[str, Any]] = [
    {
        "api_groups": [""],
        "resources": [
            "pods", "services", "endpoints", "configmaps", "secrets",
            "persistentvolumeclaims", "serviceaccounts", "events", "replicationcontrollers",
        ],
        "verbs": WRITE,
    },
    {
        "api_groups": ["apps"],
        "resources": ["deployments", "replicasets", "statefulsets", "daemonsets"],
        "verbs": WRITE,
    },
    {"api_groups": ["apps"], "resources": ["deployments/scale", "statefulsets/scale"], "verbs": WRITE},
    {"api_groups": ["batch"], "resources": ["jobs", "cronjobs"], "verbs": WRITE},
    {
        "api_groups": ["networking.k8s.io"],
        "resources": ["ingresses", "networkpolicies"],
        "verbs": WRITE,
    },
    {"api_groups": ["autoscaling"], "resources": ["horizontalpodautoscalers"], "verbs": WRITE},
    {"api_groups": ["policy"], "resources": ["poddisruptionbudgets"], "verbs": WRITE},
]

# 로그 / 상태 조회 — 배포 후 "왜 안 뜨지" 를 개발자가 스스로 확인하는 최소 집합
_OBSERVE_RULES: list[dict[str, Any]] = [
    {"api_groups": [""], "resources": ["pods/log", "pods/status"], "verbs": ["get", "list"]},
    {"api_groups": [""], "resources": ["events"], "verbs": READ},
    {"api_groups": ["metrics.k8s.io"], "resources": ["pods", "nodes"], "verbs": ["get", "list"]},
]

# 디버깅 — 컨테이너 진입 / 로컬 포트포워드
_DEBUG_RULES: list[dict[str, Any]] = [
    {"api_groups": [""], "resources": ["pods/exec", "pods/attach", "pods/portforward"], "verbs": ["create", "get"]},
    {"api_groups": [""], "resources": ["pods/ephemeralcontainers"], "verbs": ["update", "patch"]},
]

_READONLY_RULES: list[dict[str, Any]] = [
    {
        "api_groups": [""],
        "resources": [
            "pods", "pods/log", "pods/status", "services", "endpoints", "configmaps",
            "persistentvolumeclaims", "events", "replicationcontrollers", "serviceaccounts",
        ],
        "verbs": READ,
    },
    {
        "api_groups": ["apps"],
        "resources": ["deployments", "replicasets", "statefulsets", "daemonsets"],
        "verbs": READ,
    },
    {"api_groups": ["batch"], "resources": ["jobs", "cronjobs"], "verbs": READ},
    {"api_groups": ["networking.k8s.io"], "resources": ["ingresses", "networkpolicies"], "verbs": READ},
    {"api_groups": ["autoscaling"], "resources": ["horizontalpodautoscalers"], "verbs": READ},
    {"api_groups": ["metrics.k8s.io"], "resources": ["pods", "nodes"], "verbs": ["get", "list"]},
]


PRESETS: list[dict[str, Any]] = [
    {
        "key": "dev-deploy",
        "name": "개발자 배포 + 로그 (권장)",
        "summary": "자기 네임스페이스에 배포하고 로그·이벤트를 보고 컨테이너에 들어갈 수 있다.",
        "description": (
            "개발자가 LOCAL 의 kubectl/helm/skaffold 로 배포하는 기본 기준. 워크로드 CRUD + "
            "로그/이벤트 조회 + exec/port-forward 까지 포함하고, 노드·네임스페이스 같은 "
            "클러스터 스코프 리소스는 건드리지 못한다."
        ),
        "recommended_binding_mode": "clusterrole-rolebinding",
        "risk": "medium",
        "rules": _WORKLOAD_RULES + _OBSERVE_RULES + _DEBUG_RULES,
    },
    {
        "key": "dev-readonly",
        "name": "조회 전용 (로그 포함)",
        "summary": "배포는 못 하고 리소스·로그만 본다.",
        "description": "장애 확인·모니터링만 필요한 개발자/QA 기준. 쓰기 verb 가 하나도 없다.",
        "recommended_binding_mode": "clusterrole-rolebinding",
        "risk": "low",
        "rules": _READONLY_RULES,
    },
    {
        "key": "dev-debug",
        "name": "디버깅 (조회 + exec/port-forward)",
        "summary": "조회 전용에 컨테이너 진입과 로컬 포트포워드만 더한다.",
        "description": (
            "배포 권한 없이 운영 파드를 들여다봐야 할 때. exec 는 컨테이너 안의 파일·환경변수를 "
            "모두 볼 수 있으므로 조회 전용보다 실질 권한이 훨씬 세다는 점에 유의."
        ),
        "recommended_binding_mode": "clusterrole-rolebinding",
        "risk": "medium",
        "rules": _READONLY_RULES + _DEBUG_RULES,
    },
    {
        "key": "ns-admin",
        "name": "네임스페이스 관리자",
        "summary": "해당 네임스페이스 안의 모든 리소스에 대한 전권.",
        "description": (
            "팀이 네임스페이스를 통째로 소유할 때. RoleBinding 으로 묶으면 권한은 그 "
            "네임스페이스로 한정되지만, 그 안에서 RBAC 까지 바꿀 수 있으니 팀 리드 기준으로 준다."
        ),
        "recommended_binding_mode": "role-per-namespace",
        "risk": "high",
        "rules": [{"api_groups": ["*"], "resources": ["*"], "verbs": ["*"]}],
    },
    {
        "key": "cluster-readonly",
        "name": "클러스터 전체 조회",
        "summary": "노드·네임스페이스·스토리지클래스 등 클러스터 스코프까지 읽기만.",
        "description": (
            "플랫폼 파악이나 조사용. ClusterRoleBinding 과 함께 써야 클러스터 스코프 리소스가 보인다. "
            "secrets 는 일부러 제외했다(읽기만으로도 자격증명이 통째로 새어나간다)."
        ),
        "recommended_binding_mode": "clusterrole-clusterrolebinding",
        "risk": "medium",
        "rules": _READONLY_RULES
        + [
            {
                "api_groups": [""],
                "resources": ["nodes", "namespaces", "persistentvolumes"],
                "verbs": READ,
            },
            {"api_groups": ["storage.k8s.io"], "resources": ["storageclasses"], "verbs": READ},
            {
                "api_groups": ["apiextensions.k8s.io"],
                "resources": ["customresourcedefinitions"],
                "verbs": READ,
            },
        ],
    },
]

PRESET_BY_KEY = {p["key"]: p for p in PRESETS}


BINDING_MODES: list[dict[str, str]] = [
    {
        "key": "clusterrole-rolebinding",
        "name": "ClusterRole + 네임스페이스별 RoleBinding (권장)",
        "description": (
            "권한 정의(ClusterRole)는 하나만 두고, 네임스페이스마다 RoleBinding 으로 붙인다. "
            "여러 네임스페이스에 같은 권한을 줘야 할 때 정의가 갈라지지 않는 표준 방식이며, "
            "권한은 바인딩된 네임스페이스로만 한정된다."
        ),
    },
    {
        "key": "role-per-namespace",
        "name": "네임스페이스별 Role + RoleBinding",
        "description": (
            "네임스페이스마다 Role 을 따로 만든다. 네임스페이스별로 권한을 다르게 가져갈 "
            "예정이거나, ClusterRole 생성 권한이 없는 환경에서 쓴다."
        ),
    },
    {
        "key": "clusterrole-clusterrolebinding",
        "name": "ClusterRole + ClusterRoleBinding (클러스터 전역)",
        "description": (
            "모든 네임스페이스에 권한이 걸린다. 앞으로 생길 네임스페이스까지 포함되므로 "
            "조회 전용이 아니면 권장하지 않는다."
        ),
    },
]
