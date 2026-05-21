"""Pod-to-pod bottleneck probe registry.

신규 Probe 추가:
 1. 신규 모듈 (예: iperf3.py) → BottleneckProbeBase 상속 + PROBE_KEY/LABEL/run() 구현
 2. 본 파일 BOTTLENECK_PROBE_REGISTRY 에 등록
 3. PROBE_CATALOG 에 메타 추가
 4. schemas/bottleneck.py 의 ProbeKey Literal 에 추가
"""
from app.services.bottleneck_probes.base import (
    BottleneckProbeBase,
    ProbeResult,
    ProbeContext,
    make_context,
)
from app.services.bottleneck_probes.tcp_state import TcpStateProbe
from app.services.bottleneck_probes.tcp_perf import TcpPerfProbe
from app.services.bottleneck_probes.dns_latency import DnsLatencyProbe
from app.services.bottleneck_probes.endpoints import EndpointsProbe


BOTTLENECK_PROBE_REGISTRY: dict[str, type[BottleneckProbeBase]] = {
    "tcp_state":   TcpStateProbe,
    "tcp_perf":    TcpPerfProbe,
    "dns_latency": DnsLatencyProbe,
    "endpoints":   EndpointsProbe,
}


PROBE_CATALOG: dict[str, dict] = {
    "tcp_state": {
        "label": "TCP Socket State",
        "axis": "L4 state",
        "needs_exec": True,
        "fallback_cmd": "ss -tin",
        "description": "Recv-Q / Send-Q / RTT / retrans (병목 직접 신호)",
    },
    "tcp_perf": {
        "label": "TCP Perf Counters",
        "axis": "L4 counters",
        "needs_exec": True,
        "fallback_cmd": "cat /proc/net/snmp /proc/net/netstat",
        "description": "RetransSegs / OutSegs / InErrs (2초 간격 diff)",
    },
    "dns_latency": {
        "label": "DNS Latency",
        "axis": "L7 DNS",
        "needs_exec": True,
        "fallback_cmd": "getent hosts <service>",
        "description": "dest_service resolution 3회 평균 (CoreDNS 병목 추정)",
    },
    "endpoints": {
        "label": "Service Endpoints",
        "axis": "K8s control",
        "needs_exec": False,
        "fallback_cmd": None,
        "description": "EndpointSlice ready ratio (부하 분배 / readinessProbe 실패)",
    },
}


def get_probe_class(probe_key: str) -> type[BottleneckProbeBase] | None:
    return BOTTLENECK_PROBE_REGISTRY.get(probe_key)


def worst_status(statuses: list) -> str:
    """4 probe status 중 최악값 — overall 결정.
    우선순위: critical > pending > warning > healthy.
    pending(연결 실패/exec 실패) 을 warning 보다 위에 둬서 운영자에게 명확 신호."""
    from app.models import StatusEnum
    order = {
        StatusEnum.critical: 4,
        StatusEnum.pending: 3,
        StatusEnum.warning: 2,
        StatusEnum.healthy: 1,
    }
    if not statuses:
        return StatusEnum.pending.value
    worst = max(statuses, key=lambda s: order.get(s, 0))
    return worst.value if hasattr(worst, "value") else str(worst)


__all__ = [
    "BottleneckProbeBase",
    "ProbeResult",
    "ProbeContext",
    "make_context",
    "BOTTLENECK_PROBE_REGISTRY",
    "PROBE_CATALOG",
    "get_probe_class",
    "worst_status",
]
