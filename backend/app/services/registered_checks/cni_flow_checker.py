"""CNI 흐름 점검 — Cilium Hubble flows.

Cilium 미설치 환경은 pending. Hubble relay 가 존재하면 hubble CLI 로 최근 N초간
drop 패킷 비율을 확인. drop_rate > warning/critical 임계 시 알림.
"""
from __future__ import annotations

import json
from typing import Any

from app.models import StatusEnum
from app.services.registered_checks.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


class CniFlowChecker(DeepCheckerBase):
    check_type = "cni_flow"
    display_name = "CNI 패킷 흐름 (Hubble)"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_drop_pct = float(ctx.thresholds.get("warning_drop_pct", 2))
        critical_drop_pct = float(ctx.thresholds.get("critical_drop_pct", 5))
        last_seconds = int(ctx.params.get("last_seconds", 60))
        flow_limit = int(ctx.params.get("flow_limit", 1000))

        v1 = self._v1(ctx)
        ns_list = ["kube-system", "cilium"]
        cilium_pods: list[str] = []
        for ns in ns_list:
            try:
                pods = v1.list_namespaced_pod(
                    namespace=ns,
                    label_selector="k8s-app=cilium",
                    timeout_seconds=5,
                )
                for p in pods.items:
                    if p.status and p.status.phase == "Running":
                        cilium_pods.append(f"{ns}/{p.metadata.name}")
            except Exception:
                continue

        if not cilium_pods:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="Cilium DaemonSet 미발견 — Hubble flow 점검 생략",
                details={"reason": "cilium_not_installed"},
            )

        # Hubble relay 접근 — hubble observe --last N --output json
        proc = self._kubectl(
            ctx,
            "-n", "kube-system", "exec", "ds/cilium", "--",
            "hubble", "observe",
            "--last", str(flow_limit),
            "--since", f"{last_seconds}s",
            "--output", "json",
            timeout=20,
        )
        if proc.returncode != 0:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="hubble observe 실행 실패 (Relay 미배포 또는 권한)",
                details={"stderr": (proc.stderr or "")[:1000]},
            )

        total = 0
        dropped = 0
        verdicts: dict[str, int] = {}
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            verdict = (
                (ev.get("flow") or {}).get("verdict")
                or ev.get("verdict")
                or "UNKNOWN"
            )
            total += 1
            verdicts[verdict] = verdicts.get(verdict, 0) + 1
            if verdict in ("DROPPED", "ERROR"):
                dropped += 1

        drop_pct = round((dropped / total) * 100, 2) if total else 0.0

        status = StatusEnum.healthy
        if drop_pct >= critical_drop_pct:
            status = StatusEnum.critical
        elif drop_pct >= warning_drop_pct:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=f"{total}건 중 drop {dropped}건 ({drop_pct}%)",
            details={
                "total_flows": total,
                "dropped": dropped,
                "drop_pct": drop_pct,
                "verdicts": verdicts,
                "window_seconds": last_seconds,
            },
        )
