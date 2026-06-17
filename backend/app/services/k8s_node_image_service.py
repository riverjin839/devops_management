import os

from kubernetes import client, config
from kubernetes.client.rest import ApiException

from app.models.cluster import Cluster
from app.services.kubeconfig import ensure_kubeconfig_file

# 노드 list 페이지 크기 — 거대 노드(364대 × 수백 이미지) 응답을 페이지 단위로 끊어
# 한 페이지의 read 가 ingress 타임아웃을 넘지 않게 하고 메모리 피크를 낮춘다.
_PAGE_LIMIT = 100
# K8s API 호출 (connect, read) 타임아웃(초). 느린 master 한 대에 물려 무한 대기하는 것을 방지.
_API_TIMEOUT = (
    3.05,
    float(os.getenv("K8S_NODE_IMAGE_READ_TIMEOUT") or 15.0),
)


class NodeImageService:
    """Lists container images cached on each node via the Kubernetes API.

    Equivalent to inspecting `kubectl get nodes -o json` → `.status.images[]`.
    No SSH / crictl access to the node is required.
    """

    def __init__(self, cluster: Cluster):
        self.cluster = cluster
        self._v1: client.CoreV1Api | None = None

    def _get_client(self) -> client.CoreV1Api:
        if self._v1 is not None:
            return self._v1

        # 컨테이너 재시작으로 파일이 사라졌어도 DB content 로 재생성(공용 헬퍼).
        kubeconfig = ensure_kubeconfig_file(self.cluster)
        if kubeconfig and os.path.exists(kubeconfig):
            # 전역 config 를 오염시키지 않는 격리된 ApiClient 사용(백그라운드 스레드 안전).
            api_client = config.new_client_from_config(config_file=kubeconfig)
            self._v1 = client.CoreV1Api(api_client)
        else:
            try:
                config.load_incluster_config()
            except config.ConfigException:
                if kubeconfig:
                    detail = f"kubeconfig 파일을 찾을 수 없습니다: '{kubeconfig}'"
                else:
                    detail = f"클러스터 '{self.cluster.name}'에 kubeconfig가 설정되지 않았습니다"
                raise ValueError(
                    f"{detail}. in-cluster 환경도 아닙니다. "
                    "클러스터 설정에서 kubeconfig를 등록하세요."
                )
            self._v1 = client.CoreV1Api()
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

    def _iter_nodes(self):
        """`_continue` 페이지네이션으로 노드를 페이지 단위로 yield(전량 메모리 적재 회피)."""
        v1 = self._get_client()
        cont = None
        while True:
            kw = {"limit": _PAGE_LIMIT, "_request_timeout": _API_TIMEOUT}
            if cont:
                kw["_continue"] = cont
            resp = v1.list_node(**kw)
            for node in (resp.items or []):
                yield node
            cont = getattr(resp.metadata, "_continue", None) if resp.metadata else None
            if not cont:
                break

    def list_node_images(self, progress=None) -> list[dict]:
        """노드별 캐시 이미지 목록. progress(snapshot_jobs.Progress) 가 주어지면 진행률 보고.

        백그라운드 스냅샷 매니저에서 호출 — 페이지 단위 스트리밍으로 끝까지 수집(무결성)."""
        if progress is not None and progress.total is None:
            # 진행률 분모 추정: 등록된 node_count(있으면). 없으면 불확정(스피너).
            nc = getattr(self.cluster, "node_count", None)
            if nc:
                progress.total = int(nc)
        out: list[dict] = []
        for node in self._iter_nodes():
            if progress is not None:
                progress.processed += 1
                if progress.total is not None and progress.processed > progress.total:
                    progress.total = progress.processed
            labels = node.metadata.labels or {}
            images = []
            total = 0
            for img in node.status.images or []:
                size = int(img.size_bytes or 0)
                names = list(img.names or [])
                images.append({"names": names, "size_bytes": size})
                total += size
            images.sort(key=lambda x: x["size_bytes"], reverse=True)
            out.append(
                {
                    "node": node.metadata.name,
                    "role": self._role_from_labels(labels),
                    "status": self._status_from_node(node),
                    "image_count": len(images),
                    "total_size_bytes": total,
                    "labels": dict(labels),
                    "images": images,
                }
            )
        return out


def map_k8s_error(e: ApiException) -> tuple[int, str]:
    if e.status in (403, 409, 422):
        return e.status, e.reason or "Kubernetes API error"
    if e.status == 404:
        return 404, "Node not found"
    return 500, e.reason or "Failed to call Kubernetes API"
