"""DeepCheckService — DB 정의를 읽어 체커를 실행하고 결과를 DeepCheckResult 로 저장.

Phase 2의 핵심: 하드코딩된 클래스 호출이 아니라
``DeepCheckDefinition.enabled=True`` 인 정의를 registry 로 인스턴스화한다.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.models import (
    Cluster,
    DailyCheckLog,
    DeepCheckDefinition,
    DeepCheckResult,
)
from app.services.deep_checkers import (
    DeepCheckContext,
    DeepCheckOutcome,
    get_checker_class,
)

logger = logging.getLogger(__name__)

# 회차 자동 연결 시, 이보다 오래된 DailyCheckLog 에는 붙이지 않는다(엉뚱한 과거
# 회차에 deep 결과가 매달려 리뷰/트렌드가 왜곡되는 것을 방지).
_AUTO_LINK_MAX_AGE_HOURS = 6


def purge_expired_results(db: Session, *, max_batches: int = 50, batch_size: int = 5000) -> dict[str, Any]:
    """deep_check_results 리텐션 정리 — check_matrix 와 동일한 보관일수 설정을 공유.

    task_time_limit(5분) 보호를 위해 청크 단위 삭제 + 배치 상한.
    """
    from app.services.check_matrix_service import get_settings

    retention_days = get_settings(db)["retention_days"]
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    total_deleted = 0
    for _ in range(max_batches):
        ids = [
            row[0]
            for row in db.query(DeepCheckResult.id)
            .filter(DeepCheckResult.checked_at < cutoff)
            .limit(batch_size)
            .all()
        ]
        if not ids:
            break
        db.query(DeepCheckResult).filter(DeepCheckResult.id.in_(ids)).delete(
            synchronize_session=False,
        )
        db.commit()
        total_deleted += len(ids)
    return {"deleted": total_deleted, "retention_days": retention_days}


class DeepCheckService:
    def __init__(self, db: Session):
        self.db = db

    # ──────────────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────────────

    async def run_for_cluster(
        self,
        cluster_id: str | UUID,
        *,
        in_cluster: bool = False,
        daily_check_log_id: Optional[str | UUID] = None,
    ) -> tuple[int, str | None]:
        """클러스터에 활성화된 deep check 들을 실행하고 DB 에 저장.

        Returns: (실행된 체크 개수, 연결된 daily_check_log_id 문자열 or None)
        """
        cluster = self.db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None and not in_cluster:
            raise ValueError(f"Cluster not found: {cluster_id}")

        # 글로벌 정의 + 해당 클러스터 정의 모두 enabled=True 만
        defs = (
            self.db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.enabled == True)  # noqa: E712
            .filter(
                (DeepCheckDefinition.cluster_id.is_(None))
                | (DeepCheckDefinition.cluster_id == cluster_id)
            )
            .order_by(DeepCheckDefinition.sort_order.asc())
            .all()
        )

        # daily_check_log_id 미지정 시 최근 1건과 연결 — 단, 너무 오래된 회차에는
        # 붙이지 않는다(deep check 가 daily check 보다 먼저 돌면 과거 회차에 오연결됨).
        log_id = daily_check_log_id
        if log_id is None and cluster is not None:
            latest = (
                self.db.query(DailyCheckLog)
                .filter(DailyCheckLog.cluster_id == cluster.id)
                .order_by(desc(DailyCheckLog.checked_at))
                .first()
            )
            if latest is not None and latest.checked_at is not None:
                age = datetime.utcnow() - latest.checked_at
                if age <= timedelta(hours=_AUTO_LINK_MAX_AGE_HOURS):
                    log_id = latest.id
                else:
                    logger.info(
                        "run_for_cluster: 최신 DailyCheckLog 가 %s 시간 전이라 자동연결 skip (cluster=%s)",
                        round(age.total_seconds() / 3600, 1), cluster.id,
                    )

        executed = 0
        for d in defs:
            outcome = await asyncio.to_thread(self._run_one, d, cluster, in_cluster)
            _details = dict(outcome.details or {})
            _steps = getattr(outcome, "steps", []) or []
            if _steps:
                _details["_steps"] = _steps
            row = DeepCheckResult(
                cluster_id=cluster.id if cluster else d.cluster_id,
                daily_check_log_id=log_id,
                definition_id=d.id,
                check_type=d.check_type,
                status=outcome.status,
                message=outcome.message,
                details=_details,
                duration_ms=outcome.duration_ms,
                checked_at=datetime.utcnow(),
            )
            self.db.add(row)
            executed += 1

        if executed:
            self.db.commit()
        return executed, str(log_id) if log_id else None

    def run_definition_once(
        self,
        definition_id: str | UUID,
        *,
        cluster: Cluster | None = None,
        in_cluster: bool = False,
        persist: bool = False,
    ) -> dict[str, Any]:
        """단일 정의를 1회 실행 — UI 의 "Test now" 미리보기용."""
        d = (
            self.db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.id == definition_id)
            .first()
        )
        if d is None:
            raise ValueError(f"DeepCheckDefinition not found: {definition_id}")

        if cluster is None and d.cluster_id is not None:
            cluster = self.db.query(Cluster).filter(Cluster.id == d.cluster_id).first()

        outcome = self._run_one(d, cluster, in_cluster)
        from app.services.deep_checkers.registry import get_step_plan
        steps = getattr(outcome, "steps", []) or []
        # 실행 단계 로그를 details 에도 보존(영속화/조회 일관) — 스키마 변경 없음.
        details = dict(outcome.details or {})
        if steps:
            details["_steps"] = steps
        result = {
            "definition_id": str(d.id),
            "check_type": d.check_type,
            "status": outcome.status.value,
            "message": outcome.message,
            "details": details,
            "duration_ms": outcome.duration_ms,
            "steps": steps,
            "step_plan": get_step_plan(d.check_type),
        }

        if persist and cluster is not None:
            row = DeepCheckResult(
                cluster_id=cluster.id,
                daily_check_log_id=None,
                definition_id=d.id,
                check_type=d.check_type,
                status=outcome.status,
                message=outcome.message,
                details=details,
                duration_ms=outcome.duration_ms,
                checked_at=datetime.utcnow(),
            )
            self.db.add(row)
            self.db.commit()
            result["persisted_result_id"] = str(row.id)
        return result

    def run_check_type_once(
        self,
        check_type: str,
        *,
        cluster: Cluster | None = None,
        params: dict[str, Any] | None = None,
        thresholds: dict[str, Any] | None = None,
        in_cluster: bool = False,
        persist: bool = False,
    ) -> dict[str, Any]:
        """저장된 정의 없이 check_type 을 ad-hoc 으로 1회 실행 (런타임 params 주입 가능).

        ``run_definition_once`` 는 저장된 정의의 params 만 쓰므로 per-node(node_name) 같은
        런타임 인자를 넘길 수 없다. 이 메서드는 registry 의 default_thresholds/default_params 위에
        호출자 인자를 덮어써 실행한다. (예: 노드별 '검증' 버튼 / sync 직후 자동검증)
        """
        from app.models import StatusEnum
        from app.services.deep_checkers.registry import REGISTRY, get_step_plan

        cls = get_checker_class(check_type)
        entry = REGISTRY.get(check_type)
        if cls is None or entry is None:
            return {
                "check_type": check_type,
                "status": StatusEnum.pending.value,
                "message": f"알 수 없는 check_type: {check_type}",
                "details": {"check_type": check_type},
                "duration_ms": 0,
                "steps": [],
                "step_plan": [],
            }
        spec = entry[1]
        eff_thresholds = {**(spec.default_thresholds or {}), **(thresholds or {})}
        eff_params = {**(spec.default_params or {}), **(params or {})}

        ctx = DeepCheckContext(
            cluster=cluster,
            thresholds=eff_thresholds,
            params=eff_params,
            in_cluster=in_cluster,
        )
        outcome = cls().safe_run(ctx)
        steps = getattr(outcome, "steps", []) or []
        details = dict(outcome.details or {})
        if steps:
            details["_steps"] = steps
        result = {
            "check_type": check_type,
            "status": outcome.status.value,
            "message": outcome.message,
            "details": details,
            "duration_ms": outcome.duration_ms,
            "steps": steps,
            "step_plan": get_step_plan(check_type),
        }
        if persist and cluster is not None:
            row = DeepCheckResult(
                cluster_id=cluster.id,
                daily_check_log_id=None,
                definition_id=None,
                check_type=check_type,
                status=outcome.status,
                message=outcome.message,
                details=details,
                duration_ms=outcome.duration_ms,
                checked_at=datetime.utcnow(),
            )
            self.db.add(row)
            self.db.commit()
            result["persisted_result_id"] = str(row.id)
        return result

    def run_node_health_once(
        self,
        cluster: Cluster | None,
        *,
        node_name: str,
        in_cluster: bool = False,
        persist: bool = False,
    ) -> dict[str, Any]:
        """단일 노드 health 검증 (노드별 '검증' 버튼 / sync 직후 자동검증)."""
        return self.run_check_type_once(
            "node_health",
            cluster=cluster,
            params={"node_name": node_name},
            in_cluster=in_cluster,
            persist=persist,
        )

    # ──────────────────────────────────────────────────────────────
    # Ingest (in_cluster 모드 → 관리 backend 로 push)
    # ──────────────────────────────────────────────────────────────

    def persist_ingest_payload(self, payload: dict[str, Any]) -> tuple[int, str | None]:
        """In-cluster super pod 가 push 한 결과를 그대로 저장.

        daily_check_log_id 가 없으면 해당 클러스터의 최신 DailyCheckLog 에 자동 연결.

        Returns: (저장된 결과 수, 연결된 daily_check_log_id 문자열 or None)
        """
        from app.models import StatusEnum

        cluster_id = payload.get("cluster_id")
        log_id = payload.get("daily_check_log_id")
        results = payload.get("results") or []

        # in-cluster 모드는 log_id 를 모르므로 최신 DailyCheckLog 에 자동 연결
        if not log_id and cluster_id:
            latest = (
                self.db.query(DailyCheckLog)
                .filter(DailyCheckLog.cluster_id == cluster_id)
                .order_by(desc(DailyCheckLog.checked_at))
                .first()
            )
            if latest is not None:
                log_id = str(latest.id)
                logger.info("ingest: auto-linked cluster %s → daily_check_log %s", cluster_id, log_id)

        saved = 0
        for r in results:
            try:
                status = StatusEnum(r.get("status", "warning"))
            except ValueError:
                status = StatusEnum.warning
            row = DeepCheckResult(
                cluster_id=cluster_id,
                daily_check_log_id=log_id,
                definition_id=r.get("definition_id"),
                check_type=r.get("check_type", "unknown"),
                status=status,
                message=(r.get("message") or "")[:5000],
                details=r.get("details"),
                duration_ms=int(r.get("duration_ms") or 0),
                checked_at=datetime.utcnow(),
            )
            self.db.add(row)
            saved += 1
        if saved:
            self.db.commit()
        return saved, str(log_id) if log_id else None

    # ──────────────────────────────────────────────────────────────
    # Internals
    # ──────────────────────────────────────────────────────────────

    def _run_one(
        self,
        d: DeepCheckDefinition,
        cluster: Cluster | None,
        in_cluster: bool,
    ) -> DeepCheckOutcome:
        from app.models import StatusEnum

        cls = get_checker_class(d.check_type)
        if cls is None:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message=f"알 수 없는 check_type: {d.check_type}",
                details={"check_type": d.check_type},
            )

        instance = cls()
        ctx = DeepCheckContext(
            cluster=cluster,
            thresholds=d.thresholds or {},
            params=d.params or {},
            in_cluster=in_cluster,
        )
        return instance.safe_run(ctx)
