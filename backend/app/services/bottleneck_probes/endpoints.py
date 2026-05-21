"""EndpointsProbe — dest_service 의 EndpointSlice 조회 → ready ratio 확인.

병목 시나리오: "backend service 가 5 pod 중 2개만 ready" — round-robin 시
ready pod 만 트래픽 받음 → 부하 집중.
"""
from __future__ import annotations

import asyncio
from typing import Any

from kubernetes import client

from app.models import StatusEnum
from app.services.bottleneck_probes.base import (
    BottleneckProbeBase, ProbeContext, ProbeResult,
)


class EndpointsProbe(BottleneckProbeBase):
    PROBE_KEY = "endpoints"
    PROBE_LABEL = "Service Endpoints"
    TIMEOUT_SEC = 5

    async def run(self, ctx: ProbeContext) -> ProbeResult:
        return await asyncio.to_thread(self._do_run, ctx)

    def _do_run(self, ctx: ProbeContext) -> ProbeResult:
        if not ctx.dest_service:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: dest_service 미지정",
                recommendation="진단 폼에서 dest_service 입력 시 endpoint 분배 확인 가능",
            )

        try:
            api_client = ctx.get_api_client()
            discovery = client.DiscoveryV1Api(api_client)
            slices = discovery.list_namespaced_endpoint_slice(
                namespace=ctx.namespace,
                label_selector=f"kubernetes.io/service-name={ctx.dest_service}",
                _request_timeout=3,
            )
        except client.ApiException as e:
            return ProbeResult(
                status=StatusEnum.critical,
                message=f"{self.PROBE_LABEL}: K8s API {e.status} — {str(e)[:200]}",
                details={"namespace": ctx.namespace, "service": ctx.dest_service},
                recommendation="RBAC 권한 확인 (discovery.k8s.io get,list endpointslices)",
            )
        except Exception as e:  # noqa: BLE001
            return ProbeResult(
                status=StatusEnum.critical,
                message=f"{self.PROBE_LABEL}: 조회 실패 — {str(e)[:200]}",
                details={"namespace": ctx.namespace, "service": ctx.dest_service},
            )

        if not slices.items:
            return ProbeResult(
                status=StatusEnum.critical,
                message=f"EndpointSlice 0개 — service '{ctx.dest_service}' 가 어떤 pod 도 매칭 안 함",
                details={"namespace": ctx.namespace, "service": ctx.dest_service},
                recommendation="Service selector vs pod label 확인 + pod readinessProbe 통과 여부 확인",
            )

        total = 0
        ready = 0
        addresses: list[dict[str, Any]] = []
        for s in slices.items:
            for ep in (s.endpoints or []):
                total += 1
                is_ready = bool(getattr(ep.conditions, "ready", False)) if ep.conditions else False
                if is_ready:
                    ready += 1
                addresses.append({
                    "addresses": list(ep.addresses or []),
                    "ready": is_ready,
                    "target_ref": (ep.target_ref.name if ep.target_ref else None),
                    "node": getattr(ep, "node_name", None),
                })

        ratio = (ready / total) if total > 0 else 0.0
        status, msg, rec = self._evaluate(ready, total, ratio)
        return ProbeResult(
            status=status,
            message=msg,
            details={
                "namespace": ctx.namespace,
                "service": ctx.dest_service,
                "slice_count": len(slices.items),
                "endpoint_count": total,
                "ready_count": ready,
                "ready_ratio": round(ratio, 3),
                "endpoints": addresses[:20],
            },
            recommendation=rec,
        )

    def _evaluate(self, ready: int, total: int, ratio: float
                  ) -> tuple[StatusEnum, str, str | None]:
        if total == 0:
            return (StatusEnum.critical, "endpoint 0개 — service selector 미스",
                    "Service selector vs pod label 매칭 확인")
        if ready == 0:
            return (StatusEnum.critical,
                    f"ready 0/{total} — 모든 endpoint NotReady",
                    "pod readinessProbe 실패 — `kubectl describe pod -n {ns} ...` 로 원인 확인")
        if ratio < 1.0:
            return (StatusEnum.warning,
                    f"부분 ready — {ready}/{total} ({ratio*100:.0f}%)",
                    f"{total-ready} pod NotReady — 부하 집중 위험. rolling restart 또는 HPA 확인")
        return (StatusEnum.healthy,
                f"정상 — {ready}/{total} ready",
                None)
