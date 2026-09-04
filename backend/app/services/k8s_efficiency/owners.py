"""워크로드 메타 — 오퍼레이터(CR) 관리 여부 + opt-out annotation.

`_top_owner` 는 파드→(RS→)Deployment 한 단계만 올라가고 group 을 노출하지 않으므로, StarRocks CN
처럼 StatefulSet 이 `StarRocksCluster` CR 에 소유된 경우를 알 수 없다. 여기서 워크로드 자체의
ownerReferences 를 읽어 group ∉ {"", apps, batch} 면 "오퍼레이터 관리"로 분류한다 — 그런
워크로드의 request 를 직접 패치하면 오퍼레이터가 되돌리므로 추천만 하고 적용은 거부한다.

전수 GET 대신 Deployment/StatefulSet/DaemonSet 3개 LIST(페이지 스트리밍)로 한 번에 만든다.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from kubernetes import client as k8s_client

from app.services.k8s_paging import iter_all

logger = logging.getLogger(__name__)

_NATIVE_GROUPS = {"", "apps", "batch"}


def owner_of(meta) -> Optional[dict]:
    refs = getattr(meta, "owner_references", None) or []
    ctrl = next((o for o in refs if getattr(o, "controller", False)), None) or (refs[0] if refs else None)
    if ctrl is None:
        return None
    api_version = getattr(ctrl, "api_version", "") or ""
    group = api_version.split("/", 1)[0] if "/" in api_version else ""
    if group in _NATIVE_GROUPS:
        return None
    return {"api_version": api_version, "kind": getattr(ctrl, "kind", None), "name": getattr(ctrl, "name", None)}


def is_opted_out(annotations: Optional[dict], key: str) -> bool:
    if not annotations or not key:
        return False
    v = str(annotations.get(key, "")).strip().lower()
    return v in ("off", "false", "0", "no", "disabled")


def workload_meta_map(client, optout_key: str) -> dict[tuple[str, str, str], dict[str, Any]]:
    """{(ns, kind, name): {"managed_by": dict|None, "optout": bool}} — Deployment/StatefulSet/DaemonSet."""
    apps = k8s_client.AppsV1Api(client)
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    sources = (
        ("Deployment", lambda **kw: apps.list_deployment_for_all_namespaces(**kw)),
        ("StatefulSet", lambda **kw: apps.list_stateful_set_for_all_namespaces(**kw)),
        ("DaemonSet", lambda **kw: apps.list_daemon_set_for_all_namespaces(**kw)),
    )
    for kind, fn in sources:
        try:
            for w in iter_all(fn):
                m = w.metadata
                ann = dict(m.annotations or {})
                tmpl_ann = {}
                try:
                    tmpl_ann = dict(((w.spec.template.metadata.annotations if w.spec and w.spec.template
                                      and w.spec.template.metadata else None) or {}))
                except Exception:  # noqa: BLE001
                    pass
                out[(m.namespace, kind, m.name)] = {
                    "managed_by": owner_of(m),
                    "optout": is_opted_out(ann, optout_key) or is_opted_out(tmpl_ann, optout_key),
                }
        except Exception as e:  # noqa: BLE001
            logger.warning("workload meta LIST 실패(%s): %s", kind, str(e)[:160])
    return out


def namespace_optouts(client, optout_key: str) -> set[str]:
    core = k8s_client.CoreV1Api(client)
    out: set[str] = set()
    try:
        for ns in iter_all(lambda **kw: core.list_namespace(**kw)):
            if is_opted_out(dict(ns.metadata.annotations or {}), optout_key):
                out.add(ns.metadata.name)
    except Exception as e:  # noqa: BLE001
        logger.warning("namespace LIST 실패: %s", str(e)[:160])
    return out
