"""Terminating 상태로 임계 시간 이상 머무는 pod 검출."""
from __future__ import annotations

from datetime import datetime, timezone

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)
from app.services.k8s_paging import iter_all


class StuckTerminatingChecker(DeepCheckerBase):
    check_type = "stuck_terminating"
    display_name = "Stuck Terminating Pods"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_minutes = int(ctx.thresholds.get("warning_minutes", 5))
        critical_minutes = int(ctx.thresholds.get("critical_minutes", 30))

        v1 = self._v1(ctx)
        now = datetime.now(timezone.utc)

        # 페이지 스트리밍 — 대형 클러스터에서 전량을 한 번에 메모리에 올리지 않는다.
        stuck: list[dict[str, object]] = []
        for p in iter_all(v1.list_pod_for_all_namespaces):
            meta = p.metadata
            if meta is None or meta.deletion_timestamp is None:
                continue
            delta = (now - meta.deletion_timestamp).total_seconds() / 60.0
            stuck.append({
                "namespace": meta.namespace,
                "pod": meta.name,
                "minutes_terminating": round(delta, 1),
                "phase": p.status.phase if p.status else None,
            })

        max_minutes = max((s["minutes_terminating"] for s in stuck), default=0)  # type: ignore[type-var]

        status = StatusEnum.healthy
        if any(float(s["minutes_terminating"]) >= critical_minutes for s in stuck):  # type: ignore[arg-type]
            status = StatusEnum.critical
        elif any(float(s["minutes_terminating"]) >= warning_minutes for s in stuck):  # type: ignore[arg-type]
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=(
                f"Terminating {len(stuck)}건, 최장 {max_minutes}분"
                if stuck else "Stuck terminating 없음"
            ),
            details={
                "warning_minutes": warning_minutes,
                "critical_minutes": critical_minutes,
                "stuck_pods": sorted(
                    stuck, key=lambda s: float(s["minutes_terminating"]), reverse=True  # type: ignore[arg-type]
                )[:50],
            },
        )
