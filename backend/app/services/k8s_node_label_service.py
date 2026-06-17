import os
import re

from kubernetes import client, config
from kubernetes.client.rest import ApiException

from app.models.cluster import Cluster

PROTECTED_PREFIXES = ("kubernetes.io/", "k8s.io/")
IMMUTABLE_KEYS = {"kubernetes.io/hostname"}
LABEL_KEY_RE = re.compile(r"^([A-Za-z0-9]([-.A-Za-z0-9_]*[A-Za-z0-9])?)(/[A-Za-z0-9]([-.A-Za-z0-9_]*[A-Za-z0-9])?)?$")
LABEL_VALUE_RE = re.compile(r"^([-.A-Za-z0-9_]{0,63})$")


class NodeLabelService:
    def __init__(self, cluster: Cluster):
        self.cluster = cluster
        self._v1: client.CoreV1Api | None = None

    def _get_client(self) -> client.CoreV1Api:
        if self._v1 is not None:
            return self._v1

        # 중요: 클러스터별로 격리된 Configuration/ApiClient 를 만든다.
        # config.load_kube_config()/load_incluster_config() 를 인자 없이 호출하면
        # 전역(default) Configuration 을 덮어쓰는데, 여러 클러스터 요청이 동시에 들어오면
        # 서로의 전역 설정을 클로버링해서 "A 클러스터를 조회했는데 B 클러스터 노드가 돌아오는"
        # 현상(노드 수가 11↔364 로 튐)이 발생한다. client_configuration 로 격리해 이를 막는다.
        cfg = client.Configuration()
        kubeconfig = self.cluster.kubeconfig_path
        if kubeconfig and os.path.exists(kubeconfig):
            config.load_kube_config(config_file=kubeconfig, client_configuration=cfg)
        else:
            # kubeconfig 없거나 파일 미존재 → in-cluster 서비스 어카운트 시도
            try:
                config.load_incluster_config(client_configuration=cfg)
            except config.ConfigException:
                if kubeconfig:
                    detail = f"kubeconfig 파일을 찾을 수 없습니다: '{kubeconfig}'"
                else:
                    detail = f"클러스터 '{self.cluster.name}'에 kubeconfig_path가 설정되지 않았습니다"
                raise ValueError(
                    f"{detail}. in-cluster 환경도 아닙니다. "
                    "클러스터 설정에서 kubeconfig를 등록하세요."
                )

        self._v1 = client.CoreV1Api(api_client=client.ApiClient(configuration=cfg))
        return self._v1

    @staticmethod
    def _role_from_labels(labels: dict[str, str]) -> str:
        if "node-role.kubernetes.io/control-plane" in labels or "node-role.kubernetes.io/master" in labels:
            return "control-plane"
        for key in labels.keys():
            if key.startswith("node-role.kubernetes.io/"):
                return key.split("/", 1)[1] or "worker"
        return "worker"

    @staticmethod
    def _status_from_node(node: client.V1Node) -> str:
        for cond in node.status.conditions or []:
            if cond.type == "Ready":
                return "ready" if cond.status == "True" else "not-ready"
        return "unknown"

    @staticmethod
    def _taints(node: client.V1Node) -> list[str]:
        taints = node.spec.taints or []
        return [f"{t.key}={t.value}:{t.effect}" if t.value else f"{t.key}:{t.effect}" for t in taints]

    def list_nodes(self) -> list[dict]:
        v1 = self._get_client()
        nodes = v1.list_node().items
        out: list[dict] = []
        for node in nodes:
            labels = node.metadata.labels or {}
            out.append(
                {
                    "name": node.metadata.name,
                    "labels": labels,
                    "taints": self._taints(node),
                    "role": self._role_from_labels(labels),
                    "status": self._status_from_node(node),
                }
            )
        return out

    @staticmethod
    def _validate_label(key: str, value: str) -> None:
        if not LABEL_KEY_RE.match(key):
            raise ValueError(f"Invalid label key: {key}")
        if len(value) > 63 or not LABEL_VALUE_RE.match(value):
            raise ValueError(f"Invalid label value for {key}")
        if key in IMMUTABLE_KEYS:
            raise ValueError(f"Label is immutable: {key}")
        if any(key.startswith(prefix) for prefix in PROTECTED_PREFIXES):
            raise ValueError(f"Protected label prefix is not allowed: {key}")

    @staticmethod
    def _validate_remove(key: str) -> None:
        if key in IMMUTABLE_KEYS:
            raise ValueError(f"Label is immutable: {key}")
        if any(key.startswith(prefix) for prefix in PROTECTED_PREFIXES):
            raise ValueError(f"Protected label prefix is not allowed: {key}")

    def patch_labels(self, node_name: str, add: dict[str, str], remove: list[str]) -> dict:
        for key, value in add.items():
            self._validate_label(key, value)
        for key in remove:
            self._validate_remove(key)

        patch_body = {"metadata": {"labels": {**add}}}
        for key in remove:
            patch_body["metadata"]["labels"][key] = None

        v1 = self._get_client()
        node = v1.patch_node(name=node_name, body=patch_body)
        labels = node.metadata.labels or {}
        return {
            "name": node.metadata.name,
            "labels": labels,
            "taints": self._taints(node),
            "role": self._role_from_labels(labels),
            "status": self._status_from_node(node),
        }


def map_k8s_error(e: ApiException) -> tuple[int, str]:
    if e.status in (403, 409, 422):
        return e.status, e.reason or "Kubernetes API error"
    if e.status == 404:
        return 404, "Node not found"
    return 500, e.reason or "Failed to call Kubernetes API"
