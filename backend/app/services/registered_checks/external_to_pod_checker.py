"""외부 서비스 → 내부 Pod 호출 점검.

호출자 (= 외부 서비스) 의 기본값은 **DevOps Management 가 기동된 클러스터** 다.
관리 backend 컨테이너가 직접 httpx 로 대상 클러스터의 외부 endpoint 로 요청을
날린다. 별도 probe pod 가 필요 없어 추가 RBAC 도 없다.

대상 endpoint 우선순위:
1. ``params.endpoints`` (list) — 사용자가 등록한 URL / host:port. 비어있으면 ↓
2. ``cluster.api_endpoint`` + ``params.api_probe_path`` (기본 /healthz).
   pending 으로 떨어지지 않는다.

각 endpoint 는 두 모드 중 하나로 점검:
* URL (http/https) → ``httpx.get`` 으로 HTTP probe (status 2xx/3xx = 성공)
* ``host:port``    → TCP connect (성공/실패만)

실패율 ≥ ``critical_failure_pct`` → critical, ≥ ``warning_failure_pct`` → warning.

in_cluster 모드에서는 cluster 컨텍스트가 없으므로 ``endpoints`` 가 지정되지 않으면
pending 으로 종료.
"""
from __future__ import annotations

import socket
import time
from typing import Any

import httpx

from app.models import StatusEnum
from app.services.registered_checks.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


class ExternalToPodChecker(DeepCheckerBase):
    check_type = "external_to_pod"
    display_name = "외부 → 내부 Pod 호출"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_pct = float(ctx.thresholds.get("warning_failure_pct", 10))
        critical_pct = float(ctx.thresholds.get("critical_failure_pct", 30))

        endpoints = list(ctx.params.get("endpoints") or [])
        api_probe_path = ctx.params.get("api_probe_path", "/healthz")
        timeout = float(ctx.params.get("http_timeout_seconds", 5))
        verify_tls = bool(ctx.params.get("verify_tls", False))
        per_endpoint_retries = int(ctx.params.get("per_endpoint_retries", 0))
        # 호출자(=외부) 표식 — 기본은 "management cluster" (지금 devops 관리 backend 가
        # 기동된 클러스터). UI 에서 다른 origin 라벨로 덮어쓸 수 있음.
        caller_label = ctx.params.get(
            "caller_label", "management-cluster (devops_management)"
        )

        # cluster.api_endpoint 를 기본 대상으로 자동 포함
        if not endpoints and ctx.cluster and ctx.cluster.api_endpoint:
            base = ctx.cluster.api_endpoint.rstrip("/")
            endpoints.append(f"{base}{api_probe_path}")

        if not endpoints:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message=(
                    "probe 대상 endpoint 가 없습니다. params.endpoints 에 URL/host:port 를 "
                    "지정하거나 Cluster.api_endpoint 를 설정하세요."
                ),
                details={"caller": caller_label, "endpoints": []},
            )

        results: list[dict[str, Any]] = []
        succ = 0
        fail = 0

        for raw in endpoints:
            target = str(raw).strip()
            if not target:
                continue
            outcome = _probe_one(
                target,
                timeout=timeout,
                verify_tls=verify_tls,
                retries=per_endpoint_retries,
            )
            outcome["target"] = target
            results.append(outcome)
            if outcome["ok"]:
                succ += 1
            else:
                fail += 1

        total = succ + fail
        if total == 0:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="유효한 endpoint 가 없습니다.",
                details={"caller": caller_label, "raw_endpoints": endpoints},
            )

        fail_pct = round((fail / total) * 100, 2)

        status = StatusEnum.healthy
        if fail_pct >= critical_pct:
            status = StatusEnum.critical
        elif fail_pct >= warning_pct:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=(
                f"{caller_label} → {total}개 endpoint 호출, "
                f"성공 {succ} / 실패 {fail} (실패율 {fail_pct}%)"
            ),
            details={
                "caller": caller_label,
                "total": total,
                "success": succ,
                "failure": fail,
                "failure_pct": fail_pct,
                "warning_pct": warning_pct,
                "critical_pct": critical_pct,
                "timeout_seconds": timeout,
                "verify_tls": verify_tls,
                "results": results,
            },
        )


def _probe_one(
    target: str,
    *,
    timeout: float,
    verify_tls: bool,
    retries: int,
) -> dict[str, Any]:
    """단일 endpoint probe. HTTP(S) URL 이면 GET, 아니면 host:port TCP connect."""
    if target.startswith(("http://", "https://")):
        return _probe_http(target, timeout=timeout, verify_tls=verify_tls, retries=retries)
    return _probe_tcp(target, timeout=timeout, retries=retries)


def _probe_http(
    url: str, *, timeout: float, verify_tls: bool, retries: int
) -> dict[str, Any]:
    last_error: str | None = None
    for attempt in range(retries + 1):
        start = time.time()
        try:
            with httpx.Client(timeout=timeout, verify=verify_tls) as cli:
                resp = cli.get(url)
            elapsed = int((time.time() - start) * 1000)
            ok = 200 <= resp.status_code < 400
            return {
                "kind": "http",
                "ok": ok,
                "status_code": resp.status_code,
                "latency_ms": elapsed,
                "attempt": attempt + 1,
                "body_preview": (resp.text or "")[:200],
            }
        except Exception as e:
            last_error = str(e)[:300]
            continue
    return {
        "kind": "http",
        "ok": False,
        "error": last_error,
        "attempt": retries + 1,
    }


def _probe_tcp(
    target: str, *, timeout: float, retries: int
) -> dict[str, Any]:
    host, _, port_str = target.rpartition(":")
    if not host or not port_str.isdigit():
        # host:port 가 아니면 https URL 로 다시 시도하기보다 그냥 실패 처리.
        return {
            "kind": "tcp",
            "ok": False,
            "error": f"invalid host:port format ({target})",
        }
    port = int(port_str)
    last_error: str | None = None
    for attempt in range(retries + 1):
        start = time.time()
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
            elapsed = int((time.time() - start) * 1000)
            sock.close()
            return {
                "kind": "tcp",
                "ok": True,
                "latency_ms": elapsed,
                "attempt": attempt + 1,
            }
        except Exception as e:
            last_error = str(e)[:300]
            continue
    return {
        "kind": "tcp",
        "ok": False,
        "error": last_error,
        "attempt": retries + 1,
    }

