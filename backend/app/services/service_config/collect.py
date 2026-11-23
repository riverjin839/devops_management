"""서비스 구성 — 컨트롤 플레인 정적 파드 플래그를 노드별로 수집(K8S API, 노드 설정은 바꾸지 않는다).

버전 수집(``versions.py``)은 컴포넌트마다 대표 파드 1개만 저장한다. 서비스 구성은 노드마다 값이 다른지(드리프트)를 봐야 하므로
``kube-system`` 의 컨트롤 플레인 파드(etcd·kube-apiserver·kube-controller-manager·kube-scheduler)를 전부 읽어
``static_pod:{component}:{node}`` 스냅샷으로 남긴다(내용이 같으면 저장하지 않음). 실패는 fail-safe 로 ``errors``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.cluster import Cluster

COMPONENTS = ("etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler")


def container_flags(container: Any) -> dict[str, str]:
    """command + args 의 ``--flag=value`` / ``--flag value`` / ``--flag``(=true)."""
    tokens = [str(t) for t in (list(getattr(container, "command", None) or []) + list(getattr(container, "args", None) or []))]
    out: dict[str, str] = {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--") and len(tok) > 2:
            if "=" in tok:
                k, v = tok[2:].split("=", 1)
                out[k] = v
            elif i + 1 < len(tokens) and not tokens[i + 1].startswith("-"):
                out[tok[2:]] = tokens[i + 1]
                i += 1
            else:
                out[tok[2:]] = "true"
        i += 1
    return out


def _component(pod: Any) -> str | None:
    labels = getattr(pod.metadata, "labels", None) or {}
    comp = labels.get("component")
    if comp in COMPONENTS:
        return comp
    name = pod.metadata.name or ""
    return next((c for c in COMPONENTS if name.startswith(c + "-")), None)


def collect_static_pods(db: Session, cluster: Cluster, source: str = "k8s_api") -> dict[str, Any]:
    """노드별 스냅샷 저장 + 바뀐 값은 변경 이력·변경 알람(``watch.after_store``). 드리프트 알람 동기화는 호출자가 한다."""
    from app.services.service_config import apply as A
    from app.services.service_config import watch as W

    now = datetime.utcnow()
    out: dict[str, Any] = {"changed": 0, "components": [], "errors": []}
    try:
        core, _apps = A.k8s_apis(cluster)
        pods = core.list_namespaced_pod("kube-system", _request_timeout=15)
    except Exception as exc:  # noqa: BLE001 — kubeconfig·연결 실패는 오류 목록으로
        out["errors"].append(f"kube-system 파드 조회 실패: {str(exc)[:200]}")
        return out
    for pod in getattr(pods, "items", None) or []:
        comp = _component(pod)
        node = getattr(pod.spec, "node_name", None)
        containers = getattr(pod.spec, "containers", None) or []
        if not comp or not node or not containers:
            continue
        main = next((c for c in containers if c.name == comp), containers[0])
        image = getattr(main, "image", "") or ""
        version = image.rsplit(":", 1)[1] if ":" in image.rsplit("/", 1)[-1] else None
        data = {"flags": container_flags(main), "image": image, "podName": pod.metadata.name, "node": node,
                "host_ip": getattr(pod.status, "host_ip", None), "source": "k8s_api"}
        changed = W.store_and_watch(db, cluster, f"static_pod:{comp}:{node}", "control_plane", version, data, now, source)
        out["changed"] += int(changed)
        out["components"].append({"component": comp, "node": node, "version": version, "changed": changed})
    if out["changed"]:
        db.commit()
    if not out["components"]:
        out["errors"].append("kube-system 에서 컨트롤 플레인 정적 파드를 찾지 못했습니다(관리형 클러스터는 컨트롤 플레인이 보이지 않습니다).")
    return out
