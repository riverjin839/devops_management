"""K8s LIST `_continue` 페이지네이션 공용 헬퍼.

대규모 전수 순회(자원 집계 / 서비스 토폴로지 등)에서 공유한다. 페이지 단위 스트리밍으로
전량 메모리 적재(→ OOM → 워커 강제종료 → 502)를 피하고, `continue` 토큰 만료(410 Gone,
etcd compaction)를 graceful 하게 partial 처리한다.
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable, Optional


def _envf(name: str, default: float) -> float:
    try:
        v = os.getenv(name)
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


# K8s API 호출 서버측 타임아웃(connect, read) 초 — 한 페이지의 read 가 게이트웨이 타임아웃을
# 넘지 않도록 짧게.
API_READ_TIMEOUT = _envf("K8S_ALLOC_API_READ_TIMEOUT", 12.0)
API_TIMEOUT = (3.05, API_READ_TIMEOUT)
PAGE_LIMIT = 1000  # 페이지네이션 페이지 크기(round-trip 수 ↓)


def iter_all(list_fn: Callable[..., Any], *, field_selector: Optional[str] = None,
             hard_cap: int = 200_000, deadline: Optional[float] = None,
             report: Optional[list] = None):
    """`_continue` 페이지네이션을 **페이지 단위로 스트리밍**(yield)한다.

    전량을 메모리에 모으지 않으므로(한 번에 한 페이지만 유지) 수만 Pod 클러스터에서도
    OOM 을 피한다. deadline(monotonic) 지정 시 페이지 사이에서 예산 초과하면 중단하고,
    상한/예산 초과 시 report(있으면)에 True 를 append 한다.
    """
    seen = 0
    cont: Optional[str] = None
    while True:
        kw: dict[str, Any] = {"limit": PAGE_LIMIT, "_request_timeout": API_TIMEOUT}
        if field_selector:
            kw["field_selector"] = field_selector
        if cont:
            kw["_continue"] = cont
        try:
            resp = list_fn(**kw)
        except Exception:  # noqa: BLE001
            # 첫 페이지 실패면 진짜 오류 → 호출자가 처리하도록 전파.
            # 이후 페이지 실패(예: continue 토큰 만료 410 Gone)는 graceful: partial 처리.
            if seen == 0:
                raise
            if report is not None:
                report.append(True)
            break
        for it in (resp.items or []):
            yield it
            seen += 1
        cont = getattr(resp.metadata, "_continue", None) if resp.metadata else None
        if not cont:
            break
        if seen >= hard_cap or (deadline is not None and time.monotonic() >= deadline):
            if report is not None:
                report.append(True)
            break


def list_all(list_fn: Callable[..., Any], *, field_selector: Optional[str] = None,
             hard_cap: int = 200_000, deadline: Optional[float] = None,
             report: Optional[list] = None) -> list:
    """`iter_all` 을 전량 리스트로 수집(소형 컬렉션용)."""
    return list(iter_all(list_fn, field_selector=field_selector, hard_cap=hard_cap,
                         deadline=deadline, report=report))
