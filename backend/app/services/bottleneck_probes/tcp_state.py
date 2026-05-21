"""TcpStateProbe — source pod 안에서 `ss -tinJ` 실행 → TCP 소켓 상태 분석.

핵심 메트릭:
 - Recv-Q / Send-Q (큐 깊이) — 가장 흔한 병목 신호
 - RTT (avg) / cwnd / retrans / lost

dest_pod 와의 connection 만 필터링 (가능하면). 안 되면 전체 ESTABLISHED 통계.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from app.models import StatusEnum
from app.services.bottleneck_probes.base import (
    BottleneckProbeBase, ProbeContext, ProbeResult,
)
from app.services.kubectl_exec import safe_pod_exec


# Warning / Critical thresholds
WARN_RTT_MS = 100
CRIT_RTT_MS = 500
WARN_RECVQ = 1024
CRIT_RECVQ = 16384
WARN_RETRANS = 0       # 1+ 이면 warning
CRIT_RETRANS = 10


class TcpStateProbe(BottleneckProbeBase):
    PROBE_KEY = "tcp_state"
    PROBE_LABEL = "TCP Socket State"
    TIMEOUT_SEC = 5

    async def run(self, ctx: ProbeContext) -> ProbeResult:
        # asyncio 컨텍스트에서 동기 K8s SDK 호출 — to_thread 로 격리
        return await asyncio.to_thread(self._do_run, ctx)

    def _do_run(self, ctx: ProbeContext) -> ProbeResult:
        v1 = ctx.get_v1()
        # `-J` (JSON) 우선. ss 가 없거나 -J 미지원 시 `-tin` fallback (regex).
        out, fb = safe_pod_exec(
            v1, ctx.namespace, ctx.source_pod, ["ss", "-tinJ"],
            timeout=self.TIMEOUT_SEC,
        )
        if fb is not None:
            # exec 실패 — manual fallback 안내
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: exec 실패 — manual command 참고",
                manual_fallback=fb,
                recommendation="distroless/PSA restricted 인 경우 ephemeral container 또는 node 레벨 ss 사용",
            )

        sockets, parse_warning = self._parse(out or "")
        if not sockets:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: 활성 TCP socket 없음",
                details={"raw_preview": (out or "")[:500], "parse_warning": parse_warning},
            )

        # dest_pod 의 IP 를 찾을 수 있으면 그쪽으로 필터 (best-effort)
        dest_ips = self._lookup_dest_ips(v1, ctx)
        focused = [s for s in sockets if dest_ips and s.get("peer_ip") in dest_ips]
        focused = focused or sockets  # 못 찾으면 전체 통계

        max_recvq = max((s.get("recv_q", 0) for s in focused), default=0)
        max_sendq = max((s.get("send_q", 0) for s in focused), default=0)
        max_rtt = max((s.get("rtt_ms", 0.0) for s in focused), default=0.0)
        total_retrans = sum((s.get("retrans", 0) for s in focused))

        # 판정
        status, msg, rec = self._evaluate(max_rtt, max_recvq, total_retrans, n=len(focused))
        return ProbeResult(
            status=status,
            message=msg,
            details={
                "socket_count": len(focused),
                "filtered_by_dest": bool(dest_ips and focused != sockets),
                "dest_ips": list(dest_ips),
                "max_recv_q": max_recvq,
                "max_send_q": max_sendq,
                "max_rtt_ms": round(max_rtt, 2),
                "total_retrans": total_retrans,
                "samples": focused[:5],
            },
            recommendation=rec,
        )

    # ── parsing ────────────────────────────────────────────────────────

    def _parse(self, raw: str) -> tuple[list[dict[str, Any]], str | None]:
        """`ss -tinJ` (JSON) 우선, fallback regex."""
        raw = (raw or "").strip()
        if not raw:
            return [], "empty"
        # JSON output 시도
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                sockets = []
                for item in data:
                    sockets.append(self._normalize_json_row(item))
                return [s for s in sockets if s], None
        except json.JSONDecodeError:
            pass
        # Fallback — text parse (간단 regex, 정확도 낮음)
        return self._parse_text(raw), "json_parse_failed_fallback_text"

    def _normalize_json_row(self, item: dict) -> dict | None:
        """ss -tinJ 의 한 row → 우리 표준 dict."""
        try:
            peer = (item.get("dst") or "").rsplit(":", 1)
            peer_ip = peer[0] if len(peer) == 2 else None
            return {
                "state": item.get("state"),
                "peer_ip": peer_ip,
                "recv_q": int(item.get("recv-q") or 0),
                "send_q": int(item.get("send-q") or 0),
                "rtt_ms": float(item.get("rtt") or 0.0),
                "retrans": int(item.get("retrans") or 0),
                "cwnd": int(item.get("cwnd") or 0),
            }
        except (ValueError, TypeError):
            return None

    def _parse_text(self, raw: str) -> list[dict[str, Any]]:
        """`ss -tin` text fallback — 핵심 컬럼만."""
        sockets = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("State"):
                continue
            parts = re.split(r"\s+", line)
            if len(parts) < 5:
                continue
            try:
                recv_q = int(parts[1])
                send_q = int(parts[2])
                peer_ip = parts[4].rsplit(":", 1)[0] if ":" in parts[4] else parts[4]
                rtt_match = re.search(r"rtt:([\d.]+)", line)
                retrans_match = re.search(r"retrans:\d+/(\d+)", line)
                sockets.append({
                    "state": parts[0],
                    "peer_ip": peer_ip,
                    "recv_q": recv_q,
                    "send_q": send_q,
                    "rtt_ms": float(rtt_match.group(1)) if rtt_match else 0.0,
                    "retrans": int(retrans_match.group(1)) if retrans_match else 0,
                })
            except (ValueError, IndexError):
                continue
        return sockets

    def _lookup_dest_ips(self, v1, ctx: ProbeContext) -> set[str]:
        """dest_pod 의 podIP 조회 — 실패하면 빈 set."""
        try:
            pod = v1.read_namespaced_pod(name=ctx.dest_pod, namespace=ctx.namespace,
                                          _request_timeout=2)
            ips: set[str] = set()
            if pod.status.pod_ip:
                ips.add(pod.status.pod_ip)
            for p in (pod.status.pod_ips or []):
                if p.ip:
                    ips.add(p.ip)
            return ips
        except Exception:  # noqa: BLE001
            return set()

    def _evaluate(self, rtt: float, recvq: int, retrans: int, n: int) -> tuple[StatusEnum, str, str | None]:
        if rtt > CRIT_RTT_MS or recvq > CRIT_RECVQ or retrans > CRIT_RETRANS:
            reasons = []
            if rtt > CRIT_RTT_MS:
                reasons.append(f"RTT {rtt:.0f}ms")
            if recvq > CRIT_RECVQ:
                reasons.append(f"Recv-Q {recvq}")
            if retrans > CRIT_RETRANS:
                reasons.append(f"retrans {retrans}")
            rec = "심각: 백엔드 pod CPU/메모리/네트워크 정책 확인 + 노드 자원 점검 필요"
            return StatusEnum.critical, f"critical — {', '.join(reasons)} ({n} 소켓)", rec
        if rtt > WARN_RTT_MS or recvq > WARN_RECVQ or retrans > WARN_RETRANS:
            reasons = []
            if rtt > WARN_RTT_MS:
                reasons.append(f"RTT {rtt:.0f}ms")
            if recvq > WARN_RECVQ:
                reasons.append(f"Recv-Q {recvq}")
            if retrans > WARN_RETRANS:
                reasons.append(f"retrans {retrans}")
            rec = "주의: 큐 적체/RTT 증가 — 부하 변동 또는 일시적 네트워크 지연 가능"
            return StatusEnum.warning, f"warning — {', '.join(reasons)} ({n} 소켓)", rec
        return StatusEnum.healthy, f"정상 — RTT {rtt:.0f}ms, Recv-Q {recvq} ({n} 소켓)", None
