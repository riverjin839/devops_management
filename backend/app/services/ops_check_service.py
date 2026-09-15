"""OpsCheckService — 운영 점검 통합 콘솔의 카탈로그 + 일괄 실행.

여러 점검 소스(deep_check / addon / batch_job / playbook)를 공통 "점검 항목" 으로
normalize 해 콘솔이 리스트로 보여주고, 선택한 항목들을 한 묶음(OpsCheckRun)으로
실행한다. 실행은 항목마다 status(queued→running→done/error)+결과를 즉시 커밋해
콘솔이 폴링으로 진행률을 볼 수 있게 한다.

batch_job/playbook 은 매트릭스(check_matrix_service)와 같은 실행 서비스
(batch_job_service.execute_job / playbook_service.execute_playbook_run)를 그대로
재사용한다 — "자격증명 불필요"라는 전제는 deep_check/addon 뿐이라, 이 두 소스는
배치잡/플레이북에 저장된 스케줄용 자격증명이 있어야 실행되며 없으면 그 사유가
결과 메시지에 그대로 남는다(D-066).
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
    BatchJob,
    Cluster,
    DeepCheckDefinition,
    DeepCheckResult,
    OpsCheckRun,
    OpsCheckRunItem,
    Playbook,
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
        from app.services.registered_checks import REGISTRY
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


def _deep_check_exec_tech(check_type: str) -> Optional[str]:
    try:
        from app.services.registered_checks import REGISTRY
        entry = REGISTRY.get(check_type)
        return entry[1].exec_tech if entry else None
    except Exception:  # noqa: BLE001
        return None


def _addon_exec_tech(addon_type: str) -> Optional[str]:
    try:
        from app.services.checkers import EXEC_TECH
        return EXEC_TECH.get(addon_type)
    except Exception:  # noqa: BLE001
        return None


def _batch_job_exec_tech(db: Session, job: BatchJob) -> str:
    """매트릭스의 이름 기반 추정과 달리 이미 로드된 인스턴스로 정확히 판정한다."""
    try:
        from app.services.batch_jobs import get_executor
        executor = get_executor(job.job_type)
        if executor is not None and not executor.requires_ssh:
            return "k8s_api"
    except Exception:  # noqa: BLE001
        pass
    if job.execution_mode == "script" and job.script_id:
        try:
            from app.models.executable_script import ExecutableScript
            script = db.query(ExecutableScript).filter(ExecutableScript.id == job.script_id).first()
            if script is not None and script.kind == "python":
                return "ssh_python"
            if script is not None and script.kind == "ansible_playbook":
                return "ansible"
        except Exception:  # noqa: BLE001
            pass
    return "ssh_bash"


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
        items.extend(self._catalog_batch_jobs(cluster_id))
        items.extend(self._catalog_playbooks(cluster_id))
        return items

    def _catalog_deep_checks(self, cluster_id: str | UUID) -> list[dict[str, Any]]:
        try:
            # enabled/disabled 모두 노출 — 비활성으로 "등록만" 된 점검도 콘솔에서
            # 수동 실행할 수 있어야 한다(cron 은 enabled 만 돈다).
            defs = (
                self.db.query(DeepCheckDefinition)
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
                    "exec_tech": _deep_check_exec_tech(d.check_type),
                    "requires_credentials": False,
                    "enabled": bool(d.enabled),
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
                "exec_tech": _addon_exec_tech(a.type),
                "requires_credentials": False,
                "enabled": True,
                "last_status": _status_value(a.status),
                "last_run_at": a.last_check.isoformat() if a.last_check else None,
            } for a in addons]
        except Exception as e:  # noqa: BLE001
            self.db.rollback()
            logger.warning("ops-check catalog: addon 소스 실패: %s", e)
            return []

    def _catalog_batch_jobs(self, cluster_id: str | UUID) -> list[dict[str, Any]]:
        try:
            jobs = (
                self.db.query(BatchJob)
                .filter(BatchJob.cluster_id == cluster_id)
                .order_by(BatchJob.name.asc())
                .all()
            )
            out: list[dict[str, Any]] = []
            for j in jobs:
                requires_creds = False
                try:
                    from app.services.batch_jobs import get_executor
                    executor = get_executor(j.job_type)
                    requires_creds = bool(
                        executor and executor.requires_ssh
                        and not (j.encrypted_password or j.encrypted_private_key),
                    )
                except Exception:  # noqa: BLE001
                    pass
                out.append({
                    "source": "batch_job",
                    "item_ref_id": str(j.id),
                    "name": j.name,
                    "check_type": j.job_type,
                    "category": "os",
                    "exec_tech": _batch_job_exec_tech(self.db, j),
                    "requires_credentials": requires_creds,
                    "enabled": bool(j.enabled),
                    "last_status": j.last_status,
                    "last_run_at": j.last_run_at.isoformat() if j.last_run_at else None,
                })
            return out
        except Exception as e:  # noqa: BLE001
            self.db.rollback()
            logger.warning("ops-check catalog: batch_job 소스 실패: %s", e)
            return []

    def _catalog_playbooks(self, cluster_id: str | UUID) -> list[dict[str, Any]]:
        try:
            playbooks = (
                self.db.query(Playbook)
                .filter(Playbook.cluster_id == cluster_id)
                .order_by(Playbook.name.asc())
                .all()
            )
            return [{
                "source": "playbook",
                "item_ref_id": str(p.id),
                "name": p.name,
                "check_type": "ansible",
                "category": "os",
                "exec_tech": "ansible",
                "requires_credentials": False,
                "enabled": True,
                "last_status": p.status if p.status != "unknown" else None,
                "last_run_at": p.last_run_at.isoformat() if p.last_run_at else None,
            } for p in playbooks]
        except Exception as e:  # noqa: BLE001
            self.db.rollback()
            logger.warning("ops-check catalog: playbook 소스 실패: %s", e)
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
        if item.source == "batch_job":
            return self._run_batch_job(cluster, item)
        if item.source == "playbook":
            return self._run_playbook(cluster, item)
        raise ValueError(f"지원하지 않는 소스: {item.source}")

    def _run_deep_check(
        self, cluster: Optional[Cluster], item: OpsCheckRunItem
    ) -> tuple[StatusEnum, str, Optional[dict], int]:
        from app.services.check_definition_runner import DeepCheckService

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

    def _run_batch_job(
        self, cluster: Optional[Cluster], item: OpsCheckRunItem
    ) -> tuple[StatusEnum, str, Optional[dict], int]:
        if cluster is None:
            return StatusEnum.pending, "클러스터 컨텍스트 없음", None, 0
        job = (
            self.db.query(BatchJob)
            .filter(BatchJob.id == UUID(item.item_ref_id), BatchJob.cluster_id == cluster.id)
            .first()
        )
        if job is None:
            return StatusEnum.pending, "배치잡을 찾을 수 없음", None, 0
        if not job.enabled:
            return StatusEnum.pending, f"배치잡 «{job.name}» 이 비활성화(enabled=false)되어 있습니다.", None, 0

        import asyncio
        from app.services import batch_job_service

        try:
            job_run, result = asyncio.run(batch_job_service.execute_job(
                self.db, job, trigger="manual",
            ))
        except Exception as e:  # noqa: BLE001
            return StatusEnum.critical, f"배치잡 실행 실패: {str(e)[:300]}", None, 0
        # ok/cancelled 만 non-critical — error/timeout/auth_error/connect_error 는 전부 위험.
        status = (
            StatusEnum.healthy if result.status == "ok"
            else StatusEnum.pending if result.status == "cancelled"
            else StatusEnum.critical
        )
        message = result.error or f"배치잡 «{job.name}» 실행 결과: {result.status}"
        details = {"steps": result.steps, "commands": result.commands, "batch_job_run_id": str(job_run.id)}
        return status, message, details, result.duration_ms

    def _run_playbook(
        self, cluster: Optional[Cluster], item: OpsCheckRunItem
    ) -> tuple[StatusEnum, str, Optional[dict], int]:
        playbook = self.db.query(Playbook).filter(Playbook.id == UUID(item.item_ref_id)).first()
        if playbook is None:
            return StatusEnum.pending, "플레이북을 찾을 수 없음", None, 0

        from app.services import playbook_service

        try:
            pb_run, result = playbook_service.execute_playbook_run(
                self.db, playbook, trigger="manual",
            )
        except Exception as e:  # noqa: BLE001
            return StatusEnum.critical, f"플레이북 실행 실패: {str(e)[:300]}", None, 0
        try:
            status = StatusEnum(result.status)
        except ValueError:
            status = StatusEnum.critical
        details = {"stats": result.stats, "playbook_run_id": str(pb_run.id)}
        return status, result.message or "", details, result.duration_ms
