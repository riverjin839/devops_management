"""공통 서비스 카탈로그 — 서비스 타입·호스팅 방식·화면 폼 필드(UI-First: 환경 차이는 params 로, 필드마다 label·help).

``param_fields``      : 인스턴스 ``params`` 에 들어가는 비밀 아닌 설정(수집 대상·경로 등). 화면이 이 정의로 폼을 그린다.
``credentials``       : 쓰는 자격증명 목적(app_api | ssh | ldap_bind)과 안내 — 값은 ``CommonServiceCredential`` 에 암호화 저장.
``discover``          : "K8S 에서 가져오기" 후보 판정 — 컨테이너 이미지·워크로드 이름에 들어가는 문자열.
"""
from __future__ import annotations

from typing import Any

HOST_KINDS = ("k8s", "podman", "external")
CRED_PURPOSES = ("app_api", "ssh", "ldap_bind")

SERVICES: list[dict[str, Any]] = [
    {
        "key": "ldap_ad", "label": "LDAP AD", "icon": "users",
        "description": "디렉터리 서비스(Active Directory). LDAP 읽기 전용 바인드로 rootDSE·도메인 정책 속성을 읽는다.",
        "host_kinds": ["external", "k8s", "podman"], "default_host_kind": "external",
        "endpoint_placeholder": "ldaps://ad.example.local:636",
        "credentials": [{"purpose": "ldap_bind", "label": "LDAP 바인드 계정",
                         "help": "읽기 전용 계정 DN 또는 user@domain 과 비밀번호. 쓰기 권한은 필요 없습니다."}],
        "param_fields": [
            {"key": "base_dn", "label": "도메인 DN", "type": "string", "default": "",
             "help": "도메인 객체 DN(예: DC=corp,DC=example,DC=local). 비우면 rootDSE 의 defaultNamingContext 를 씁니다."},
            {"key": "attributes", "label": "도메인 정책 속성", "type": "list",
             "default": ["minPwdLength", "maxPwdAge", "minPwdAge", "pwdHistoryLength", "pwdProperties",
                         "lockoutThreshold", "lockoutDuration", "lockOutObservationWindow", "msDS-Behavior-Version",
                         "ms-DS-MachineAccountQuota"],
             "help": "도메인 객체에서 읽어 변경을 감시할 속성(쉼표로 구분)."},
            {"key": "timeout_sec", "label": "제한 시간(초)", "type": "int", "default": 10, "help": "LDAP 연결·조회 제한 시간."},
        ],
        "discover": [],
    },
    {
        "key": "keycloak", "label": "KEYCLOAK", "icon": "lock",
        "description": "SSO·인증. 워크로드 설정과 Admin REST API 로 realm 보안 설정을 읽는다.",
        "host_kinds": ["k8s", "podman", "external"], "default_host_kind": "k8s",
        "endpoint_placeholder": "https://keycloak.example.local",
        "credentials": [{"purpose": "app_api", "label": "관리자 API 계정",
                         "help": "master realm 의 읽기 전용 관리자(view-realm) 사용자·비밀번호, 또는 서비스 계정 client_id·client_secret."}],
        "param_fields": [
            {"key": "realms", "label": "감시할 realm", "type": "list", "default": [],
             "help": "설정을 읽을 realm 이름(쉼표로 구분). 비우면 접근 가능한 realm 전부."},
            {"key": "auth_realm", "label": "인증 realm", "type": "string", "default": "master",
             "help": "관리자 토큰을 받는 realm."},
            {"key": "client_id", "label": "토큰 client_id", "type": "string", "default": "admin-cli",
             "help": "토큰 발급 client. 비밀번호 방식은 admin-cli, 서비스 계정은 그 client id(자격증명 사용자 칸은 비움)."},
        ],
        "discover": ["keycloak"],
    },
    {
        "key": "jenkins", "label": "JENKINS", "icon": "wrench",
        "description": "CI. 워크로드 설정과 Jenkins API(시스템 정보·플러그인 버전), JCasC ConfigMap 을 읽는다.",
        "host_kinds": ["k8s", "podman", "external"], "default_host_kind": "k8s",
        "endpoint_placeholder": "https://jenkins.example.local",
        "credentials": [{"purpose": "app_api", "label": "API 토큰",
                         "help": "Jenkins 사용자 이름과 API 토큰(사용자 설정 ▸ API Token). 읽기 권한(Overall/Read)이면 충분합니다."}],
        "param_fields": [
            {"key": "casc_configmap", "label": "JCasC ConfigMap", "type": "string", "default": "",
             "help": "Configuration as Code ConfigMap 이름(K8S 호스팅일 때). 비우면 워크로드에 마운트된 ConfigMap 을 씁니다."},
            {"key": "plugins", "label": "플러그인 버전 수집", "type": "bool", "default": True,
             "help": "설치된 플러그인 이름·버전을 설정으로 수집해 버전 변경을 감지합니다."},
        ],
        "discover": ["jenkins"],
    },
    {
        "key": "argocd", "label": "ARGOCD", "icon": "git-branch",
        "description": "GitOps. argocd-cm·argocd-rbac-cm·argocd-cmd-params-cm ConfigMap 과 API 의 클러스터·저장소 목록을 읽는다.",
        "host_kinds": ["k8s"], "default_host_kind": "k8s",
        "endpoint_placeholder": "https://argocd.example.local",
        "credentials": [{"purpose": "app_api", "label": "API 토큰",
                         "help": "읽기 전용 계정 토큰(argocd account generate-token). 없으면 ConfigMap 만 수집합니다."}],
        "param_fields": [
            {"key": "configmaps", "label": "ConfigMap", "type": "list",
             "default": ["argocd-cm", "argocd-rbac-cm", "argocd-cmd-params-cm"],
             "help": "호스팅 네임스페이스에서 읽을 ConfigMap 이름."},
        ],
        "discover": ["argocd-server", "argoproj/argocd", "argocd"],
    },
    {
        "key": "nexus", "label": "NEXUS", "icon": "box",
        "description": "아티팩트·이미지 저장소. REST API(저장소·blob store·보안 realm)와 Podman 이면 컨테이너·nexus.properties 를 읽는다.",
        "host_kinds": ["podman", "k8s", "external"], "default_host_kind": "podman",
        "endpoint_placeholder": "http://nexus.example.local:8081",
        "credentials": [
            {"purpose": "app_api", "label": "API 계정", "help": "nx-admin 이 아닌 읽기 권한 계정 사용자·비밀번호."},
            {"purpose": "ssh", "label": "SSH(Podman 호스트)", "help": "podman inspect·설정 파일을 읽을 호스트 계정. Podman 호스팅일 때만."},
        ],
        "param_fields": [
            {"key": "data_dir", "label": "데이터 디렉터리(호스트)", "type": "string", "default": "",
             "help": "nexus-data 가 마운트된 호스트 경로. 비우면 컨테이너 마운트(/nexus-data)에서 찾습니다."},
            {"key": "podman_cmd", "label": "podman 명령", "type": "string", "default": "podman",
             "help": "rootless 가 아니면 'sudo podman' 처럼 지정. 한 줄, 제어문자 금지."},
        ],
        "discover": ["sonatype/nexus", "nexus3", "nexus"],
    },
]

SERVICE_KEYS = tuple(s["key"] for s in SERVICES)
_BY_KEY = {s["key"]: s for s in SERVICES}


def meta(service_type: str) -> dict[str, Any]:
    return _BY_KEY.get(service_type) or {"key": service_type, "label": service_type.upper(), "param_fields": [],
                                          "credentials": [], "host_kinds": list(HOST_KINDS), "discover": []}


def normalize_params(service_type: str, params: Any) -> dict[str, Any]:
    """선언된 필드만 남기고 형식을 맞춘다(목록은 쉼표 문자열도 받음). 선언 밖 키는 버린다."""
    src = params if isinstance(params, dict) else {}
    out: dict[str, Any] = {}
    for f in meta(service_type)["param_fields"]:
        k, t, d = f["key"], f["type"], f.get("default")
        v = src.get(k, d)
        if t == "list":
            if isinstance(v, str):
                v = [x.strip() for x in v.split(",") if x.strip()]
            v = [str(x).strip() for x in (v or []) if str(x).strip()][:200]
        elif t == "int":
            try:
                v = int(v)
            except (TypeError, ValueError):
                v = d
        elif t == "bool":
            v = bool(v) if not isinstance(v, str) else v.lower() in ("1", "true", "yes", "on")
        else:
            v = "" if v is None else str(v).strip()[:500]
        out[k] = v
    return out
