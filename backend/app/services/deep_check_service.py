"""DeepCheckService — DB 정의를 읽어 체커를 실행하고 결과를 DeepCheckResult 로 저장.

Phase 2의 핵심: 하드코딩된 클래스 호출이 아니라
``DeepCheckDefinition.enabled=True`` 인 정의를 registry 로 인스턴스화한다.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
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

        # daily_check_log_id 미지정 시 최근 1건과 연결
        log_id = daily_check_log_id
        if log_id is None and cluster is not None:
            latest = (
                self.db.query(DailyCheckLog)
                .filter(DailyCheckLog.cluster_id == cluster.id)
                .order_by(desc(DailyCheckLog.checked_at))
                .first()
            )
            if latest is not None:
                log_id = latest.id

        executed = 0
        for d in defs:
            outcome = await asyncio.to_thread(self._run_one, d, cluster, in_cluster)
            row = DeepCheckResult(
                cluster_id=cluster.id if cluster else d.cluster_id,
                daily_check_log_id=log_id,
                definition_id=d.id,
                check_type=d.check_type,
                status=outcome.status,
                message=outcome.message,
                details=outcome.details,
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
        result = {
            "definition_id": str(d.id),
            "check_type": d.check_type,
            "status": outcome.status.value,
            "message": outcome.message,
            "details": outcome.details,
            "duration_ms": outcome.duration_ms,
        }

        if persist and cluster is not None:
            row = DeepCheckResult(
                cluster_id=cluster.id,
                daily_check_log_id=None,
                definition_id=d.id,
                check_type=d.check_type,
                status=outcome.status,
                message=outcome.message,
                details=outcome.details,
                duration_ms=outcome.duration_ms,
                checked_at=datetime.utcnow(),
            )
            self.db.add(row)
            self.db.commit()
            result["persisted_result_id"] = str(row.id)
        return result

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
