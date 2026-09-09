"""노드 조건 점검 — DiskPressure / MemoryPressure / PIDPressure / NetworkUnavailable / NotReady."""
from __future__ import annotations

from typing import Any

from app.models import StatusEnum
from app.services.registered_checks.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


_PRESSURE_TYPES = ("DiskPressure", "MemoryPressure", "PIDPressure", "NetworkUnavailable")


class NodePressureChecker(DeepCheckerBase):
    check_type = "node_pressure"
    display_name = "노드 Pressure / Condition"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_count = int(ctx.thresholds.get("warning_count", 1))
        critical_count = int(ctx.thresholds.get("critical_count", 3))

        v1 = self._v1(ctx)
        nodes = v1.list_node(timeout_seconds=15)

        pressured: list[dict[str, Any]] = []
        not_ready: list[str] = []
        for n in nodes.items:
            name = n.metadata.name if n.metadata else "unknown"
            conditions = (n.status.conditions or []) if n.status else []
            issues: list[str] = []
            for c in conditions:
                if c.type == "Ready":
                    if c.status != "True":
                        not_ready.append(name)
                    continue
                if c.type in _PRESSURE_TYPES and c.status == "True":
                    issues.append(c.type)
            if issues:
                pressured.append({
                    "node": name,
                    "conditions": issues,
                })

        affected_total = len({p["node"] for p in pressured}) + len(set(not_ready))

        status = StatusEnum.healthy
        if affected_total >= critical_count or not_ready:
            status = StatusEnum.critical
        elif affected_total >= warning_count:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=(
                f"NotReady {len(not_ready)}개, Pressure 노드 {len(pressured)}개 "
                f"(condition: {sum(len(p['conditions']) for p in pressured)}건)"
            ),
            details={
                "total_nodes": len(nodes.items),
                "not_ready_nodes": not_ready,
                "pressured": pressured,
                "warning_count": warning_count,
                "critical_count": critical_count,
            },
        )
