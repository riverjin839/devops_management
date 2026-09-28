"""화면용 K8s 목록 캐시(SWR)와 **쓰기 시 자동 무효화** — 무효화 단위는 대상 apiserver(host).

`/k8s-manage` 목록(리소스·노드·파드·객체 이벤트)은 `list_cache` 로 짧게 캐시한다. 클러스터 상태를
바꾸는 쓰기가 어디서 일어나든(탐색기의 scale/delete, K8S 효율화 적용, 노드 라벨 편집, RBAC 발급,
노드 이미지 배포 Job, 배치잡의 kubectl delete …) 그 apiserver 의 목록 캐시를 무효화해야 "방금 바꾼 게
안 보이는" 일이 없다.

- 풀 클라이언트(`HardenedApiClient`)를 거치는 쓰기(POST/PUT/PATCH/DELETE)는 **자동으로** 무효화된다
  (`note_write`). 권한 검토(…reviews)·토큰 발급(…/token)처럼 목록에 보이는 상태를 바꾸지 않는 POST 는 제외.
- 풀을 거치지 않는 쓰기(kubectl/helm 서브프로세스)는 `invalidate_kubeconfig(path)` 를 명시적으로 부른다.
- 세대 값은 Redis 에 있어 다른 replica·Celery 워커에서 일어난 쓰기도 모든 API 프로세스의 캐시를 무효화한다.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from app.services.swr_cache import SWRCache

logger = logging.getLogger(__name__)


def _store():
    try:
        from app.services.snapshot_jobs import _RedisStore
        return _RedisStore(prefix="k8slist")
    except Exception:  # noqa: BLE001
        return None


list_cache = SWRCache(
    fresh=float(os.getenv("K8S_LIST_CACHE_FRESH", "5")),
    stale=float(os.getenv("K8S_LIST_CACHE_STALE", "30")),
    max_entries=int(os.getenv("K8S_LIST_CACHE_MAX", "256")),
    store=_store(),
    name="k8s-list",
)

# 목록에 보이는 상태를 바꾸지 않는 POST — 무효화 대상에서 제외(불필요한 캐시 미스 방지)
_NON_MUTATING_SUFFIXES = (
    "/selfsubjectaccessreviews", "/subjectaccessreviews", "/localsubjectaccessreviews",
    "/selfsubjectrulesreviews", "/selfsubjectreviews", "/tokenreviews", "/token",
)
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def cache_group(api_client: Any, fallback: Any = None) -> str:
    """캐시 그룹 키 = apiserver host. 알 수 없으면(테스트 더블 등) fallback(보통 cluster_id)."""
    host = getattr(getattr(api_client, "configuration", None), "host", None)
    return str(host or fallback or "")


def is_mutating(method: str, url: str) -> bool:
    if (method or "").upper() not in _WRITE_METHODS:
        return False
    path = (url or "").split("?", 1)[0].rstrip("/")
    return not path.endswith(_NON_MUTATING_SUFFIXES)


def invalidate_host(host: Optional[str]) -> None:
    """그 apiserver 의 목록 캐시 전부 무효화(모든 replica). 실패는 삼킨다 — 캐시는 TTL 로도 회복된다."""
    if not host:
        return
    try:
        list_cache.bump(host)
    except Exception as e:  # noqa: BLE001
        logger.debug("k8s list cache 무효화 실패 host=%s: %s", host, e)


def note_write(host: Optional[str], method: str, url: str) -> None:
    """풀 클라이언트의 모든 요청 후 호출 — 쓰기면 무효화."""
    if is_mutating(method, url):
        invalidate_host(host)


def invalidate_kubeconfig(kubeconfig_path: Optional[str]) -> None:
    """풀을 거치지 않는 쓰기(kubectl/helm 서브프로세스) 뒤에 호출 — kubeconfig 로 host 를 찾아 무효화."""
    if not kubeconfig_path:
        return
    try:
        from app.services.k8s_client_pool import get_api_client_for_path
        invalidate_host(get_api_client_for_path(kubeconfig_path).configuration.host)
    except Exception as e:  # noqa: BLE001
        logger.debug("k8s list cache 무효화(kubeconfig) 실패: %s", e)
