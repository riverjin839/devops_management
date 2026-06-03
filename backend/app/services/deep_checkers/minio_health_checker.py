"""MinIO 스토리지 health 점검 — ``minio_health``.

MinIO 의 **인증 불필요 health 엔드포인트**만 호출한다(운영 무해, 자격증명 없음):
- ``/minio/health/cluster`` — 200=정상, 503=쿼럼 부족/degraded
- ``/minio/health/live``    — 프로세스 liveness

대상 endpoint 는 ``params.endpoints`` (MinIO base URL 목록) 로 지정한다. 비어있으면
pending 으로 안내(운영자가 등록). 여러 endpoint 면 실패율로 판정.

drive/capacity 같은 상세 지표는 ``mc admin`` / Prometheus 연동이 필요(자격증명) — 후속.
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


class MinioHealthChecker(DeepCheckerBase):
    check_type = "minio_health"
    display_name = "MinIO 스토리지 health"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_pct = float(ctx.thresholds.get("warning_failure_pct", 1))
        critical_pct = float(ctx.thresholds.get("critical_failure_pct", 50))

        endpoints = [str(e).strip() for e in (ctx.params.get("endpoints") or []) if str(e).strip()]
        cluster_path = ctx.params.get("cluster_health_path", "/minio/health/cluster")
        live_path = ctx.params.get("live_health_path", "/minio/health/live")
        timeout = float(ctx.params.get("http_timeout_seconds", 5))
        verify_tls = bool(ctx.params.get("verify_tls", False))

        if not endpoints:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message=(
                    "점검할 MinIO endpoint 가 없습니다. params.endpoints 에 "
                    "MinIO base URL(예: http://minio.tenant.svc:9000) 을 등록하세요."
                ),
                details={"endpoints": []},
            )

        results: list[dict[str, Any]] = []
        fail = 0
        for base in endpoints:
            b = base.rstrip("/")
            cluster = _probe(f"{b}{cluster_path}", timeout=timeout, verify_tls=verify_tls)
            live = _probe(f"{b}{live_path}", timeout=timeout, verify_tls=verify_tls)
            # cluster health 200 이면 정상. 503 = degraded(쿼럼). live 만 살아도 degraded.
            ok = cluster.get("status_code") == 200
            degraded = cluster.get("status_code") == 503
            healthy_flag = ok and not degraded
            if not healthy_flag:
                fail += 1
            results.append({
                "endpoint": b,
                "cluster_ok": ok,
                "degraded": degraded,
                "cluster": cluster,
                "live": live,
            })

        total = len(endpoints)
        fail_pct = round((fail / total) * 100, 2) if total else 0.0

        status = StatusEnum.healthy
        if fail_pct >= critical_pct:
            status = StatusEnum.critical
        elif fail_pct > warning_pct - 1e-9 and fail > 0:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=f"MinIO {total}개 endpoint 중 비정상 {fail} (실패율 {fail_pct}%)",
            details={
                "total": total,
                "failed": fail,
                "failure_pct": fail_pct,
                "results": results,
            },
        )


def _probe(url: str, *, timeout: float, verify_tls: bool) -> dict[str, Any]:
    start = time.time()
    try:
        with httpx.Client(timeout=timeout, verify=verify_tls) as cli:
            resp = cli.get(url)
        return {
            "url": url,
            "ok": 200 <= resp.status_code < 400,
            "status_code": resp.status_code,
            "latency_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:  # noqa: BLE001
        return {"url": url, "ok": False, "error": str(e)[:200]}
