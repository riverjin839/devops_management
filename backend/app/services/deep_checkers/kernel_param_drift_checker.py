"""OS(커널) 파라미터 변경 점검 — ``kernel_param_drift``.

노드별 sysctl/커널 파라미터가 직전 수집 대비 바뀌었는지 점검한다.
**SSH 도 파드 생성도 하지 않는다** — 이미 수집되어 DB 에 쌓인
``ClusterConfigSnapshot`` (component=``kernel_params:{host}``, category=os) 의
연속 스냅샷을 비교만 한다. 따라서 운영 클러스터에 어떤 부하/변경도 주지 않는다.

동작:
1. cluster 의 ``kernel_params:%`` 스냅샷을 host 별로 모아 최신 2개를 비교.
2. 추가/삭제/변경된 파라미터를 ``OsParamChange`` 히스토리 테이블에 기록
   (같은 to_snapshot 쌍은 idempotent — 재실행해도 중복 적재 안 함).
3. 최근(``recent_hours``) 안에 발생한 변경이면 warning/critical 로 판정,
   오래된 변경/무변경은 healthy.

전제: 운영자가 KernelParamsPage(또는 collect-kernel-params)로 파라미터를 한 번
이상 수집해 두어야 비교 대상이 생긴다. 스냅샷이 없으면 pending 으로 안내.

centralized(관리 backend, Celery) 모드 전용 — DB 가 필요하므로 in_cluster/cluster
없는 컨텍스트에서는 pending 으로 종료.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)

_KP_PREFIX = "kernel_params:"


class KernelParamDriftChecker(DeepCheckerBase):
    check_type = "kernel_param_drift"
    display_name = "OS 파라미터 변경 점검"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        if ctx.cluster is None:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="cluster 컨텍스트가 없어 DB 스냅샷을 비교할 수 없습니다 (centralized 모드 전용).",
                details={},
            )

        warning_changes = int(ctx.thresholds.get("warning_changes", 1))
        critical_changes = int(ctx.thresholds.get("critical_changes", 20))
        record_history = bool(ctx.params.get("record_history", True))
        max_report = int(ctx.params.get("max_report", 50))
        recent_hours = int(ctx.params.get("recent_hours", 24))

        from app.database import SessionLocal
        from app.models import ClusterConfigSnapshot, OsParamChange

        db = SessionLocal()
        try:
            snaps = (
                db.query(ClusterConfigSnapshot)
                .filter(
                    ClusterConfigSnapshot.cluster_id == ctx.cluster.id,
                    ClusterConfigSnapshot.component.like(f"{_KP_PREFIX}%"),
                )
                .order_by(
                    ClusterConfigSnapshot.component.asc(),
                    ClusterConfigSnapshot.collected_at.desc(),
                )
                .all()
            )
            if not snaps:
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=(
                        "수집된 OS 파라미터 스냅샷이 없습니다. 먼저 커널 파라미터를 "
                        "수집(KernelParamsPage)한 뒤 다시 실행하세요."
                    ),
                    details={"hint": "collect-kernel-params"},
                )

            # host 별 최신 2개 추출
            by_host: dict[str, list[ClusterConfigSnapshot]] = {}
            for s in snaps:
                host = s.component[len(_KP_PREFIX):]
                lst = by_host.setdefault(host, [])
                if len(lst) < 2:
                    lst.append(s)

            now = datetime.utcnow()
            recent_cutoff = now - timedelta(hours=recent_hours)

            all_changes: list[dict[str, Any]] = []
            recent_change_count = 0
            hosts_without_baseline: list[str] = []
            recorded = 0

            for host, pair in by_host.items():
                if len(pair) < 2:
                    hosts_without_baseline.append(host)
                    continue
                latest, prev = pair[0], pair[1]
                cur_params = (latest.data or {}).get("params", {}) or {}
                old_params = (prev.data or {}).get("params", {}) or {}

                changes = _diff_params(old_params, cur_params)
                if not changes:
                    continue

                is_recent = bool(latest.collected_at and latest.collected_at >= recent_cutoff)
                if is_recent:
                    recent_change_count += len(changes)

                for ch in changes:
                    ch["host"] = host
                    ch["detected_recent"] = is_recent
                all_changes.extend(changes)

                if record_history:
                    recorded += _record_history(
                        db, ctx.cluster.id, host, latest, prev, changes
                    )

            if record_history and recorded:
                db.commit()

            total = len(all_changes)
            hosts_changed = sorted({c["host"] for c in all_changes})

            # 판정: 최근 변경량 기준 (오래된 변경은 healthy 로 가라앉힘)
            if recent_change_count >= critical_changes:
                status = StatusEnum.critical
            elif recent_change_count >= warning_changes:
                status = StatusEnum.warning
            else:
                status = StatusEnum.healthy

            if total == 0:
                msg = f"OS 파라미터 변경 없음 (host {len(by_host)}개 비교)"
            else:
                msg = (
                    f"OS 파라미터 변경 {total}건 (host {len(hosts_changed)}개, "
                    f"최근 {recent_hours}h 내 {recent_change_count}건). 신규 이력 {recorded}건 기록."
                )

            return DeepCheckOutcome(
                status=status,
                message=msg,
                details={
                    "hosts_compared": len(by_host),
                    "hosts_changed": hosts_changed,
                    "hosts_without_baseline": hosts_without_baseline,
                    "total_changes": total,
                    "recent_changes": recent_change_count,
                    "recent_hours": recent_hours,
                    "recorded_history": recorded,
                    "changes": all_changes[:max_report],
                },
            )
        finally:
            db.close()


def _diff_params(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    """두 파라미터 dict 비교 → 변경 목록."""
    out: list[dict[str, Any]] = []
    for key in sorted(set(old.keys()) | set(new.keys())):
        ov = old.get(key)
        nv = new.get(key)
        if ov == nv:
            continue
        if key not in old:
            ctype = "added"
        elif key not in new:
            ctype = "removed"
        else:
            ctype = "changed"
        out.append({
            "param": key,
            "old_value": None if ov is None else str(ov),
            "new_value": None if nv is None else str(nv),
            "change_type": ctype,
        })
    return out


def _record_history(db, cluster_id, host, latest, prev, changes) -> int:
    """변경 목록을 OsParamChange 로 적재 — 같은 to_snapshot 쌍은 중복 방지."""
    from app.models import OsParamChange

    already = (
        db.query(OsParamChange.id)
        .filter(
            OsParamChange.cluster_id == cluster_id,
            OsParamChange.node == host,
            OsParamChange.to_snapshot_id == latest.id,
        )
        .first()
    )
    if already is not None:
        return 0

    n = 0
    for ch in changes:
        db.add(OsParamChange(
            cluster_id=cluster_id,
            node=host,
            param=ch["param"],
            old_value=ch["old_value"],
            new_value=ch["new_value"],
            change_type=ch["change_type"],
            from_snapshot_id=prev.id,
            to_snapshot_id=latest.id,
            detected_at=datetime.utcnow(),
        ))
        n += 1
    return n
