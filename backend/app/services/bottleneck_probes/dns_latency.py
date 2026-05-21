"""DnsLatencyProbe — source pod 안에서 dest_service 의 DNS resolution latency 측정.

전략:
 1차: `getent hosts <dest_service>` 3회 — 100ms 미만 측정 (`time` 기반 wall clock)
 2차: 그것도 안 되면 nslookup 시도
 못 하면 manual fallback

CoreDNS metrics endpoint scraping 은 권한 issue 가 복잡 — 일단 pod 안 직접 측정으로.
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Optional

from app.models import StatusEnum
from app.services.bottleneck_probes.base import (
    BottleneckProbeBase, ProbeContext, ProbeResult,
)
from app.services.kubectl_exec import safe_pod_exec


WARN_P95_MS = 50.0
CRIT_P95_MS = 500.0


class DnsLatencyProbe(BottleneckProbeBase):
    PROBE_KEY = "dns_latency"
    PROBE_LABEL = "DNS Latency"
    TIMEOUT_SEC = 5

    async def run(self, ctx: ProbeContext) -> ProbeResult:
        return await asyncio.to_thread(self._do_run, ctx)

    def _do_run(self, ctx: ProbeContext) -> ProbeResult:
        # dest_service 미지정 시: dest_pod 이름을 그대로 시도 (k8s 가 같은 namespace 면 resolve 가능)
        target = ctx.dest_service or ctx.dest_pod
        if not target:
            return ProbeResult(
                status=StatusEnum.pending,
                message="DNS target 미지정 — dest_service 또는 dest_pod 필요",
            )

        v1 = ctx.get_v1()
        samples: list[float] = []
        nxdomain = 0
        last_fallback: Optional[dict] = None

        for i in range(3):
            ms, err, fb = self._one_query(v1, ctx.namespace, ctx.source_pod, target)
            if fb is not None:
                last_fallback = fb
                break
            if err == "nxdomain":
                nxdomain += 1
            elif ms is not None:
                samples.append(ms)

        if last_fallback is not None:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: getent/nslookup 모두 실패",
                manual_fallback=last_fallback,
                recommendation="distroless pod 면 ephemeral container — `kubectl debug` 활용",
            )

        if not samples:
            return ProbeResult(
                status=StatusEnum.critical if nxdomain > 0 else StatusEnum.pending,
                message=("NXDOMAIN — service 이름 잘못됐거나 CoreDNS 응답 실패"
                         if nxdomain > 0 else "DNS 결과 없음"),
                details={"target": target, "nxdomain": nxdomain},
                recommendation=("CoreDNS pod 상태 확인 + service/endpoints 존재 확인"
                                 if nxdomain > 0 else None),
            )

        # p50 / p95 — 3 샘플이라 sort 후 인덱스 직접
        sorted_s = sorted(samples)
        p50 = sorted_s[len(sorted_s) // 2]
        p95 = sorted_s[-1]  # 3개 중 최대 == 100th percentile, p95 근사

        if p95 > CRIT_P95_MS or nxdomain > 0:
            rec = "심각: CoreDNS replica 증설 또는 cache 정책 검토 (`kubectl scale -n kube-system deploy/coredns --replicas=N`)"
            msg = f"critical — p95 {p95:.0f}ms" + (f", NXDOMAIN {nxdomain}" if nxdomain else "")
            return ProbeResult(
                status=StatusEnum.critical, message=msg,
                details={"target": target, "samples_ms": samples, "p50_ms": p50, "p95_ms": p95, "nxdomain": nxdomain},
                recommendation=rec,
            )
        if p95 > WARN_P95_MS:
            return ProbeResult(
                status=StatusEnum.warning,
                message=f"warning — p95 {p95:.0f}ms",
                details={"target": target, "samples_ms": samples, "p50_ms": p50, "p95_ms": p95},
                recommendation="주의: DNS 지연. CoreDNS replica 또는 NodeLocalDNS 도입 검토",
            )
        return ProbeResult(
            status=StatusEnum.healthy,
            message=f"정상 — p95 {p95:.0f}ms ({len(samples)} 샘플)",
            details={"target": target, "samples_ms": samples, "p50_ms": p50, "p95_ms": p95},
        )

    def _one_query(self, v1, ns: str, pod: str, target: str
                   ) -> tuple[Optional[float], Optional[str], Optional[dict]]:
        """한 번 DNS resolve. returns (latency_ms or None, err_tag or None, fallback or None)."""
        t0 = time.time()
        out, fb = safe_pod_exec(v1, ns, pod, ["getent", "hosts", target], timeout=2)
        if fb is not None:
            # getent 실패 — nslookup 시도
            out2, fb2 = safe_pod_exec(v1, ns, pod, ["nslookup", target], timeout=2)
            if fb2 is not None:
                return None, None, fb2
            elapsed = (time.time() - t0) * 1000
            return self._classify(out2, elapsed)
        elapsed = (time.time() - t0) * 1000
        return self._classify(out, elapsed)

    def _classify(self, raw: str | None, elapsed_ms: float
                  ) -> tuple[Optional[float], Optional[str], Optional[dict]]:
        if not raw or not raw.strip():
            return None, "nxdomain", None
        # IP 패턴 찾기
        if re.search(r"\b\d+\.\d+\.\d+\.\d+\b", raw) or "has address" in raw or "Address:" in raw:
            return elapsed_ms, None, None
        if "NXDOMAIN" in raw.upper() or "can't find" in raw or "not found" in raw.lower():
            return None, "nxdomain", None
        # 모호 — IP 없으면 nxdomain 으로 분류
        return None, "nxdomain", None
