"""K8S 자원 집계 NS 롤링 갱신 — Celery 가 **가장 오래된 NS 부터** 시간 예산만큼 다시 모아 Redis NS 누적기
(`allocns:{cid}:{ns}:acc`)를 신선하게 유지하고, 전 NS 가 모이면 개요 스냅샷을 조립해 게시한다.

웹(`/k8s-allocation`)은 게시된 스냅샷을 읽기만 하므로 클러스터 규모와 무관하게 응답이 즉시이고,
데이터 나이는 최대 "NS 개수 / (분당 처리 NS)" 분이다(`ns_oldest_at` 으로 화면에 표시).

- namespace 모드 클러스터(노드 수 ≥ K8S_ALLOC_NS_MODE_MIN_NODES 또는 강제)만 대상 — 소형은 웹의
  전수 집계가 이미 빠르다.
- 조회 전용(list/metrics GET) — 클러스터를 변경하지 않는다.
- 한 NS 실패는 그 NS 의 직전 누적기를 유지하고(없으면 게시 보류) 다음 틱에 다시 시도한다.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Optional

from app.routers import k8s_allocation as ka

logger = logging.getLogger(__name__)


def refresh_cluster(cluster, *, budget_s: Optional[float] = None,
                    min_age_s: Optional[float] = None) -> dict:
    """클러스터 1개 롤링 갱신 1회. 반환: 로그용 요약 dict."""
    budget = ka._ROLLING_BUDGET if budget_s is None else budget_s
    min_age = ka._ROLLING_MIN_AGE if min_age_s is None else min_age_s
    cid = str(cluster.id)
    t0 = time.monotonic()
    if ka._ns_cache is None or not ka._ns_cache.available():
        return {"skipped": "no_shared_store"}

    with ka._api(cluster) as client:
        core = ka.k8s_client.CoreV1Api(client)
        nodes = ka._list_all(lambda **kw: core.list_node(**kw), resource_version="0", raw=ka._RAW_LIST)
        node_base, schedulable_nodes = ka._node_base_of(nodes)
        if not ka._use_namespace_mode(None, len(node_base)):
            return {"skipped": "cluster_mode", "nodes": len(node_base)}
        node_usage = ka._node_usage(client)
        namespaces = [n.metadata.name for n in ka._list_all(
            lambda **kw: core.list_namespace(**kw), resource_version="0", raw=ka._RAW_LIST)]
        pod_selector = None if ka._COUNT_TERMINAL_PODS else ka._ACTIVE_FIELD_SELECTOR

        entries: dict[str, Optional[dict]] = {ns: ka._ns_cache_get(cid, ns) for ns in namespaces}
        now = time.time()

        def _age(ns: str) -> float:
            e = entries.get(ns)
            return now - float(e.get("collected_at") or 0) if e else float("inf")

        # 없는 NS → 가장 오래된 NS 순. min_age 보다 최근 것은 이번 틱에서 건너뛴다.
        due = sorted((ns for ns in namespaces if _age(ns) >= min_age), key=_age, reverse=True)
        refreshed: list[str] = []
        failed: list[str] = []
        deadline = t0 + budget
        workers = max(1, min(ka._NS_WORKERS, len(due) or 1))
        pending = iter(due)
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="alloc-roll") as ex:
            inflight: dict = {}

            def _submit_next() -> bool:
                # 예산이 끝나면 새 NS 는 시작하지 않는다(진행 중인 것은 끝까지 — 절단 결과를 남기지 않게).
                if time.monotonic() >= deadline:
                    return False
                ns = next(pending, None)
                if ns is None:
                    return False
                inflight[ex.submit(ka._collect_ns, client, core, ns, node_base, schedulable_nodes,
                                   pod_selector)] = ns
                return True

            for _ in range(workers):
                if not _submit_next():
                    break
            while inflight:
                done, _ = wait(list(inflight), return_when=FIRST_COMPLETED)
                for f in done:
                    ns = inflight.pop(f)
                    try:
                        local, cut, has_metrics = f.result()
                    except Exception as e:  # noqa: BLE001
                        logger.warning("롤링 갱신: NS %s 수집 실패(직전 값 유지): %s", ns, str(e)[:200])
                        failed.append(ns)
                    else:
                        if cut:
                            failed.append(ns)
                        else:
                            entries[ns] = ka._ns_cache_put(cid, ns, local, has_metrics)
                            refreshed.append(ns)
                    _submit_next()

    missing = [ns for ns in namespaces if not entries.get(ns)]
    published = False
    oldest: Optional[float] = None
    if not missing:
        overview, processed = ka.compose_overview_from_entries(namespaces, entries, node_base, node_usage)
        oldest = overview.get("ns_oldest_at")
        ka.warm_overview_snapshot(cid, overview, processed=processed)
        published = True
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    out = {
        "namespaces": len(namespaces), "due": len(due), "refreshed": len(refreshed),
        "failed": failed[:50], "missing": len(missing), "published": published,
        "oldest_age_s": (int(time.time() - oldest) if oldest else None), "elapsed_ms": elapsed_ms,
    }
    logger.info("k8s alloc rolling cluster=%s %s", cid, out)
    return out
