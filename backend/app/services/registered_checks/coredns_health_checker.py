"""CoreDNS / kube-dns 헬스 체크.

* kube-system 의 k8s-app=kube-dns 파드 Ready 비율
* 최근 N 라인 로그에서 "error"|"failed"|"fail to" 비율
"""
from __future__ import annotations

import re

from app.models import StatusEnum
from app.services.registered_checks.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


_ERROR_RE = re.compile(r"(?i)\b(error|failed|fail to|i/o timeout|connection refused)\b")


class CoreDnsHealthChecker(DeepCheckerBase):
    check_type = "coredns_health"
    display_name = "CoreDNS 상태"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_err_rate = float(ctx.thresholds.get("warning_error_rate_pct", 1))
        critical_err_rate = float(ctx.thresholds.get("critical_error_rate_pct", 5))
        log_tail = int(ctx.params.get("log_tail_lines", 500))
        namespace = ctx.params.get("namespace", "kube-system")
        label_selector = ctx.params.get("label_selector", "k8s-app=kube-dns")

        v1 = self._v1(ctx)
        pods = v1.list_namespaced_pod(
            namespace=namespace,
            label_selector=label_selector,
            timeout_seconds=10,
        )
        if not pods.items:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message=f"CoreDNS 파드를 찾지 못했습니다 ({namespace}/{label_selector})",
                details={"reason": "no_coredns_pods"},
            )

        ready = 0
        not_ready: list[str] = []
        for p in pods.items:
            css = (p.status.container_statuses or []) if p.status else []
            is_ready = any(cs.ready for cs in css)
            if is_ready:
                ready += 1
            else:
                not_ready.append(p.metadata.name)

        # 로그 샘플링 — 첫 파드의 tail
        total_lines = 0
        error_lines = 0
        sampled_pod = pods.items[0].metadata.name
        try:
            log = v1.read_namespaced_pod_log(
                name=sampled_pod,
                namespace=namespace,
                tail_lines=log_tail,
                _request_timeout=10,
            )
            for line in (log or "").splitlines():
                total_lines += 1
                if _ERROR_RE.search(line):
                    error_lines += 1
        except Exception:
            pass

        err_rate = round((error_lines / total_lines) * 100, 2) if total_lines else 0.0

        status = StatusEnum.healthy
        msg_parts: list[str] = [f"Ready {ready}/{len(pods.items)}"]
        if not_ready:
            status = StatusEnum.critical
        if err_rate >= critical_err_rate:
            status = StatusEnum.critical
            msg_parts.append(f"에러율 {err_rate}%")
        elif err_rate >= warning_err_rate and status != StatusEnum.critical:
            status = StatusEnum.warning
            msg_parts.append(f"에러율 {err_rate}%")
        else:
            msg_parts.append(f"에러율 {err_rate}%")

        return DeepCheckOutcome(
            status=status,
            message=", ".join(msg_parts),
            details={
                "total_pods": len(pods.items),
                "ready_pods": ready,
                "not_ready_pods": not_ready,
                "sampled_pod": sampled_pod,
                "log_lines": total_lines,
                "error_lines": error_lines,
                "error_rate_pct": err_rate,
            },
        )
