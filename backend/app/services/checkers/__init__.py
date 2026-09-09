from app.services.checkers.base import BaseChecker, CheckResult
from app.services.checkers.etcd_checker import EtcdChecker
from app.services.checkers.node_checker import NodeChecker
from app.services.checkers.control_plane_checker import ControlPlaneChecker
from app.services.checkers.system_pod_checker import SystemPodChecker
from app.services.checkers.nexus_checker import NexusChecker
from app.services.checkers.jenkins_checker import JenkinsChecker
from app.services.checkers.argocd_checker import ArgoCDChecker
from app.services.checkers.keycloak_checker import KeycloakChecker

# addon.type → Checker 클래스 매핑
CHECKER_REGISTRY: dict[str, type[BaseChecker]] = {
    "etcd-leader": EtcdChecker,
    "node-check": NodeChecker,
    "control-plane": ControlPlaneChecker,
    "system-pod": SystemPodChecker,
    "nexus": NexusChecker,
    "jenkins": JenkinsChecker,
    "argocd": ArgoCDChecker,
    "keycloak": KeycloakChecker,
}

# addon.type → 실행 기술(exec_tech) 매핑 — 매트릭스 행에 "Addon" 대신 실제 기술 이름을 노출한다.
EXEC_TECH: dict[str, str] = {
    "etcd-leader": "k8s_api",
    "node-check": "k8s_api",
    "control-plane": "k8s_api",
    "system-pod": "k8s_api",
    "argocd": "k8s_api",
    "nexus": "http",
    "jenkins": "http",
    "keycloak": "http",
}

__all__ = [
    "BaseChecker",
    "CheckResult",
    "EtcdChecker",
    "NodeChecker",
    "ControlPlaneChecker",
    "SystemPodChecker",
    "NexusChecker",
    "JenkinsChecker",
    "ArgoCDChecker",
    "KeycloakChecker",
    "CHECKER_REGISTRY",
    "EXEC_TECH",
]
