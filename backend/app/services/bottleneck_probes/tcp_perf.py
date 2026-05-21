"""TcpPerfProbe — `/proc/net/snmp` + `/proc/net/netstat` 1차 + 2초 + 2차 → diff.

retrans_rate = (RetransSegs 증가분) / (OutSegs 증가분)
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from app.models import StatusEnum
from app.services.bottleneck_probes.base import (
    BottleneckProbeBase, ProbeContext, ProbeResult,
)
from app.services.kubectl_exec import safe_pod_exec


WARN_RETRANS_RATE = 0.01   # 1%
CRIT_RETRANS_RATE = 0.05   # 5%


class TcpPerfProbe(BottleneckProbeBase):
    PROBE_KEY = "tcp_perf"
    PROBE_LABEL = "TCP Perf Counters"
    TIMEOUT_SEC = 6  # 2초 sleep 포함

    async def run(self, ctx: ProbeContext) -> ProbeResult:
        return await asyncio.to_thread(self._do_run, ctx)

    def _do_run(self, ctx: ProbeContext) -> ProbeResult:
        v1 = ctx.get_v1()
        cmd = ["cat", "/proc/net/snmp", "/proc/net/netstat"]

        out1, fb = safe_pod_exec(v1, ctx.namespace, ctx.source_pod, cmd, timeout=3)
        if fb is not None:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: exec 실패 — manual command 참고",
                manual_fallback=fb,
                recommendation="distroless 면 ephemeral container 사용. PSA restricted 면 ServiceAccount 권한 검토",
            )
        # 2초 sleep — 짧지만 보통 retrans 변화 감지에 충분
        import time
        time.sleep(2.0)
        out2, fb2 = safe_pod_exec(v1, ctx.namespace, ctx.source_pod, cmd, timeout=3)
        if fb2 is not None:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: 2차 exec 실패",
                manual_fallback=fb2,
            )

        snap1 = self._parse_proc_net(out1 or "")
        snap2 = self._parse_proc_net(out2 or "")
        if not snap1 or not snap2:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: /proc/net 파싱 실패",
                details={"snap1_preview": (out1 or "")[:300]},
            )

        diff = {k: snap2.get(k, 0) - snap1.get(k, 0) for k in snap1 if k in snap2}
        out_segs = diff.get("OutSegs", 0)
        retrans = diff.get("RetransSegs", 0)
        in_errs = diff.get("InErrs", 0)
        lost = diff.get("TCPLostRetransmit", 0)
        syn_retrans = diff.get("TCPSynRetrans", 0)

        rate = (retrans / out_segs) if out_segs > 0 else 0.0
        status, msg, rec = self._evaluate(rate, in_errs, out_segs, retrans)

        return ProbeResult(
            status=status,
            message=msg,
            details={
                "interval_sec": 2.0,
                "diff": diff,
                "out_segs": out_segs,
                "retrans_segs": retrans,
                "retrans_rate": round(rate, 4),
                "in_errs": in_errs,
                "tcp_lost_retransmit": lost,
                "tcp_syn_retrans": syn_retrans,
            },
            recommendation=rec,
        )

    def _parse_proc_net(self, raw: str) -> dict[str, int]:
        """/proc/net/snmp + /proc/net/netstat 의 Tcp:/TcpExt: 행 파싱.

        Format:
            Tcp: RtoAlgorithm RtoMin ... OutSegs RetransSegs InErrs OutRsts
            Tcp: 1 200 ... 12345 3 0 5
        헤더와 값 두 줄 묶음. 동일 prefix (Tcp: / TcpExt:) 가 헤더+값 페어.
        """
        out: dict[str, int] = {}
        lines = (raw or "").splitlines()
        prev: dict[str, list[str]] = {}
        for line in lines:
            line = line.strip()
            if not line:
                continue
            m = re.match(r"^(Tcp|TcpExt|Udp|IcmpMsg|Ip):\s+(.+)$", line)
            if not m:
                continue
            section = m.group(1) + ":"
            parts = m.group(2).split()
            # 헤더(첫 토큰이 알파벳 시작) vs 값(숫자)
            is_header = parts and not parts[0].lstrip("-").isdigit()
            if is_header:
                prev[section] = parts
            else:
                headers = prev.get(section)
                if headers and len(headers) == len(parts):
                    for h, v in zip(headers, parts):
                        try:
                            out[h] = int(v)
                        except ValueError:
                            pass
        return out

    def _evaluate(self, rate: float, in_errs: int, out_segs: int, retrans: int
                  ) -> tuple[StatusEnum, str, str | None]:
        if out_segs == 0:
            return (
                StatusEnum.pending,
                f"트래픽 없음 — 2초 간격 OutSegs 0 (idle pair?)",
                "트래픽 발생 시점에 다시 시도",
            )
        if rate > CRIT_RETRANS_RATE or in_errs > 0:
            rec = "심각: 네트워크 손실 — NetworkPolicy / cilium policy / MTU mismatch / NIC 오류 점검"
            return (
                StatusEnum.critical,
                f"critical — retrans {rate*100:.1f}% ({retrans}/{out_segs}), InErrs {in_errs}",
                rec,
            )
        if rate > WARN_RETRANS_RATE:
            return (
                StatusEnum.warning,
                f"warning — retrans {rate*100:.1f}% ({retrans}/{out_segs})",
                "주의: 네트워크 손실 의심. cilium hubble flow drop 확인",
            )
        return (
            StatusEnum.healthy,
            f"정상 — retrans {rate*100:.2f}% ({retrans}/{out_segs}), 손실 없음",
            None,
        )
