"""최근 N시간 OOMKilled / Evicted 이벤트 점검.

Events API 로 `Warning` 타입을 스캔해 reason in {OOMKilling, Evicted, FailedScheduling}
관련 항목을 카운트.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)
from app.services.k8s_paging import iter_all


_TARGET_REASONS = {"OOMKilling", "Evicted", "SystemOOM"}


class OomEventsChecker(DeepCheckerBase):
    check_type = "oom_events"
    display_name = "OOM / Evicted 이벤트"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_count = int(ctx.thresholds.get("warning_count", 1))
        critical_count = int(ctx.thresholds.get("critical_count", 5))
        window_hours = int(ctx.params.get("window_hours", 24))

        v1 = self._v1(ctx)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)

        # 페이지 스트리밍 — 이벤트가 많이 쌓이는 활발한 클러스터에서도 전량을
        # 한 번에 메모리에 올리지 않는다.
        hits: list[dict[str, Any]] = []
        for ev in iter_all(v1.list_event_for_all_namespaces, field_selector="type=Warning"):
            reason = ev.reason or ""
            if reason not in _TARGET_REASONS:
                continue
            last_ts = ev.last_timestamp or ev.event_time or ev.first_timestamp
            if last_ts is None:
                continue
            # event_time 은 microtime, last_timestamp 은 datetime.
            ts = last_ts if isinstance(last_ts, datetime) else datetime.fromtimestamp(
                last_ts.timestamp(), tz=timezone.utc
            )
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                continue
            obj = ev.involved_object
            hits.append({
                "reason": reason,
                "namespace": obj.namespace if obj else None,
                "object": f"{obj.kind}/{obj.name}" if obj else None,
                "message": (ev.message or "")[:300],
                "count": ev.count or 1,
                "last_timestamp": ts.isoformat(),
            })

        total = sum(int(h.get("count") or 1) for h in hits)

        status = StatusEnum.healthy
        if total >= critical_count:
            status = StatusEnum.critical
        elif total >= warning_count:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=(
                f"최근 {window_hours}h OOM/Evicted {total}건 ({len(hits)}종)"
                if hits else f"최근 {window_hours}h OOM/Evicted 없음"
            ),
            details={
                "window_hours": window_hours,
                "warning_count": warning_count,
                "critical_count": critical_count,
                "total_count": total,
                "events": sorted(
                    hits,
                    key=lambda h: h["last_timestamp"],
                    reverse=True,
                )[:50],
            },
        )
