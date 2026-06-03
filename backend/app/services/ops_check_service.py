"""OpsCheckService — 운영 점검 통합 콘솔의 카탈로그 + 일괄 실행.

여러 점검 소스(deep_check / addon / …)를 공통 "점검 항목" 으로 normalize 해
콘솔이 리스트로 보여주고, 선택한 항목들을 한 묶음(OpsCheckRun)으로 실행한다.
실행은 항목마다 status(queued→running→done/error)+결과를 즉시 커밋해 콘솔이
폴링으로 진행률을 볼 수 있게 한다.

단계 0: deep_check + addon 소스 (자격증명 불필요).
단계 1 이후: batch_job(SSH) / playbook(Ansible) 어댑터를 _run_item 에 추가.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.models import (
    Addon,
    Cluster,
    DeepCheckDefinition,
    DeepCheckResult,
    OpsCheckRun,
    OpsCheckRunItem,
    StatusEnum,
)

logger = logging.getLogger(__name__)

# addon.type → 운영 점검 도메인 분류.
_ADDON_CATEGORY = {
    "etcd-leader": "k8s",
    "control-plane": "k8s",
    "node-check": "k8s",
    "system-pod": "k8s",
}


def _deep_check_category(check_type: str) -> str:
    try:
        from app.services.deep_checkers import REGISTRY
        entry = REGISTRY.get(check_type)
        if entry:
            return entry[1].category
    except Exception:  # noqa: BLE001
        pass
    return "k8s"


def _addon_category(addon_type: str) -> str:
    return _ADDON_CATEGORY.get(addon_type, "app")


def _status_value(s: Any) -> Optional[str]:
    if s is None:
        return None
    return s.value if isinstance(s, StatusEnum) else str(s)


class OpsCheckService:
    def __init__(self, db: Session):
        self.db = db

    # ──────────────────────────────────────────────────────────────
    # 카탈로그 — 클러스터별 점검 항목 리스트 (소스별 try/except 격리)
    # ──────────────────────────────────────────────────────────────
    def build_catalog(self, cluster_id: str | UUID) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        items.extend(self._catalog_deep_checks(cluster_id))
        items.extend(self._catalog_addons(cluster_id))
        return items

    def _catalog_deep_checks(self, cluster_id: str | UUID) -> list[dict[str, Any]]:
        try:
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
            # 정의별 최근 결과 (cluster 한정) — 1회 조회로 map.
            recent = (
                self.db.query(DeepCheckResult)
                .filter(DeepCheckResult.cluster_id == cluster_id)
                .order_by(desc(DeepCheckResult.checked_at))
                .limit(500)
                .all()
            )
            latest_by_def: dict[str, DeepCheckResult] = {}
            for r in recent:
                key = str(r.definition_id) if r.definition_id else f"type:{r.check_type}"
                latest_by_def.setdefault(key, r)

            out: list[dict[str, Any]] = []
            for d in defs:
                last = latest_by_def.get(str(d.id)) or latest_by_def.get(f"type:{d.check_type}")
                out.append({
                    "source": "deep_check",
                    "item_ref_id": str(d.id),
                    "name": d.name,
                    "check_type": d.check_type,
                    "category": _deep_check_category(d.check_type),
                    "requires_credentials": False,
                    "last_status": _status_value(last.status) if last else None,
                    "last_run_at": last.checked_at.isoformat() if last and last.checked_at else None,
                })
            return out
        except Exception as e:  # noqa: BLE001
            self.db.rollback()
            logger.warning("ops-check catalog: deep_check 소스 실패: %s", e)
            return []

    def _catalog_addons(self, cluster_id: str | UUID) -> list[dict[str, Any]]:
        try:
            addons = (
                self.db.query(Addon)
                .filter(Addon.cluster_id == cluster_id)
                .order_by(Addon.name.asc())
                .all()
            )
            return [{
                "source": "addon",
                "item_ref_id": str(a.id),
                "name": a.name,
                "check_type": a.type,
                "category": _addon_category(a.type),
                "requires_credentials": False,
                "last_status": _status_value(a.status),
                "last_run_at": a.last_check.isoformat() if a.last_check else None,
            } for a in addons]
        except Exception as e:  # noqa: BLE001
            self.db.rollback()
            logger.warning("ops-check catalog: addon 소스 실패: %s", e)
            return []

    # ──────────────────────────────────────────────────────────────
    # 실행 묶음 생성 + 실행
    # ──────────────────────────────────────────────────────────────
    def create_run(
        self,
        cluster_id: str | UUID,
        items: list[dict[str, Any]],
        *,
        triggered_by: Optional[str] = None,
        trigger: str = "manual",
    ) -> OpsCheckRun:
        cluster = self.db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            raise ValueError(f"Cluster not found: {cluster_id}")

        # 카탈로그로 이름/타입 보강 (UI 가 ref 만 보내도 됨).
        catalog = {(c["source"], c["item_ref_id"]): c for c in self.build_catalog(cluster_id)}

        run = OpsCheckRun(
            cluster_id=cluster.id,
            status="pending",
            trigger=trigger,
            triggered_by=triggered_by,
            total=len(items),
        )
        self.db.add(run)
        self.db.flush()  # run.id 확보

        for it in items:
            src = it.get("source")
            ref = str(it.get("item_ref_id"))
            meta = catalog.get((src, ref), {})
            self.db.add(OpsCheckRunItem(
                run_id=run.id,
                source=src,
                item_ref_id=ref,
                check_type=it.get("check_type") or meta.get("check_type"),
                name=it.get("name") or meta.get("name"),
                status="queued",
            ))
        self.db.commit()
        self.db.refresh(run)
        return run

    def execute_run(self, run_id: str | UUID) -> None:
        """실행 묶음을 수행 — 항목마다 진행 상태+결과를 즉시 커밋(폴링 가시화)."""
        run = self.db.query(OpsCheckRun).filter(OpsCheckRun.id == run_id).first()
        if run is None:
            logger.warning("execute_run: run not found %s", run_id)
            return
        cluster = self.db.query(Cluster).filter(Cluster.id == run.cluster_id).first()

        run.status = "running"
        self.db.commit()

        ok = warn = crit = err = 0
        items = (
            self.db.query(OpsCheckRunItem)
            .filter(OpsCheckRunItem.run_id == run.id)
            .order_by(OpsCheckRunItem.created_at.asc())
            .all()
        )
        for item in items:
            item.status = "running"
            item.started_at = datetime.utcnow()
            self.db.commit()
            try:
                result_status, message, details, duration_ms = self._run_item(cluster, item)
                item.result_status = result_status
                item.message = (message or "")[:5000]
                item.details = details
                item.duration_ms = duration_ms
                item.status = "done"
                if result_status == StatusEnum.healthy:
                    ok += 1
                elif result_status == StatusEnum.warning:
                    warn += 1
                elif result_status == StatusEnum.critical:
                    crit += 1
            except Exception as e:  # noqa: BLE001
                self.db.rollback()
                item = self.db.query(OpsCheckRunItem).filter(OpsCheckRunItem.id == item.id).first()
                if item is not None:
                    item.status = "error"
                    item.message = f"실행 실패: {str(e)[:300]}"
                    item.finished_at = datetime.utcnow()
                err += 1
                logger.exception("ops-check item 실행 실패 (run=%s, ref=%s): %s", run.id, item.item_ref_id if item else "?", e)
                self.db.commit()
                continue
            item.finished_at = datetime.utcnow()
            self.db.commit()

        run.ok_count, run.warn_count, run.crit_count, run.error_count = ok, warn, crit, err
        run.status = "done"
        run.finished_at = datetime.utcnow()
        self.db.commit()

    # ──────────────────────────────────────────────────────────────
    # 소스별 dispatch
    # ──────────────────────────────────────────────────────────────
    def _run_item(
        self, cluster: Optional[Cluster], item: OpsCheckRunItem
    ) -> tuple[StatusEnum, str, Optional[dict], int]:
        if item.source == "deep_check":
            return self._run_deep_check(cluster, item)
        if item.source == "addon":
            return self._run_addon(cluster, item)
        raise ValueError(f"지원하지 않는 소스: {item.source}")

    def _run_deep_check(
        self, cluster: Optional[Cluster], item: OpsCheckRunItem
    ) -> tuple[StatusEnum, str, Optional[dict], int]:
        from app.services.deep_check_service import DeepCheckService

        svc = DeepCheckService(self.db)
        res = svc.run_definition_once(
            item.item_ref_id, cluster=cluster, persist=True
        )
        try:
            status = StatusEnum(res.get("status", "pending"))
        except ValueError:
            status = StatusEnum.pending
        return status, res.get("message") or "", res.get("details"), int(res.get("duration_ms") or 0)

    def _run_addon(
        self, cluster: Optional[Cluster], item: OpsCheckRunItem
    ) -> tuple[StatusEnum, str, Optional[dict], int]:
        from app.services.health_checker import HealthChecker

        if cluster is None:
            return StatusEnum.pending, "클러스터 컨텍스트 없음", None, 0
        checker = HealthChecker(self.db)
        result = checker.run_single_addon_check(cluster.id, UUID(item.item_ref_id))
        if result is None:
            return StatusEnum.pending, "addon 을 찾을 수 없음", None, 0
        return (
            result.status,
            result.message or "",
            result.details,
            int(result.response_time or 0),
        )
