"""
Celery 앱 설정 및 스케줄 태스크
- 점검 매트릭스(check_matrix) 디스패처가 매분 모든 클러스터/항목의 cron 을 평가해 실행
  (구 아침/점심/저녁 하드코딩 스케줄 완전 대체)
"""
from celery import Celery
from celery.schedules import crontab
from datetime import datetime
import asyncio

from app.config import settings

# Celery 앱 생성
celery_app = Celery(
    "k8s_daily_monitor",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

# Celery 설정
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Seoul",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=300,  # 5분 타임아웃
)

# LLM 자동 분석은 전용 `llm` 큐로 라우팅한다 — 점검/배치잡이 쓰는 기본(celery) 큐의
# 2-slot 워커 풀을 LLM 대기(최대 120s+)로 점유하지 않도록 격리. 소비자는
# `celery -A app.celery_app worker -Q llm --concurrency=1` 로 따로 띄운다
# (k8s/base/celery/worker-llm.yaml · docker-compose `celery-worker-llm`).
celery_app.conf.task_routes = {
    "app.celery_app.run_auto_incident_analysis": {"queue": "llm"},
    "app.celery_app.run_auto_incident_analysis_k8s_event": {"queue": "llm"},
    "app.celery_app.backfill_embeddings": {"queue": "llm"},
}

# Beat 스케줄 설정
celery_app.conf.beat_schedule = {
    # 점검 매트릭스 디스패처 — 매분 Cluster.check_cron_expr(core_bundle) +
    # CheckMatrixSchedule(deep_check/addon 행) 을 평가해 due 한 것만 실행.
    "check-matrix-dispatch": {
        "task": "app.celery_app.run_check_matrix_dispatch",
        "schedule": crontab(minute="*"),
    },
    # 점검 매트릭스 이력 리텐션 정리 (매일 03:00 KST)
    "check-matrix-log-purge": {
        "task": "app.celery_app.run_check_matrix_log_purge",
        "schedule": crontab(hour=3, minute=0),
    },
    # deep_check_results 리텐션 정리 (매일 03:10 KST)
    "deep-check-results-purge": {
        "task": "app.celery_app.run_deep_check_results_purge",
        "schedule": crontab(hour=3, minute=10),
    },
    # 나머지 로그성 테이블(daily_check_logs/check_logs/k8s_events/audit_logs/
    # user_notifications) 리텐션 정리 — 지금까지 purge 대상이 아니어서 무기한
    # 증가했다. 위 두 purge 와 겹치지 않게 03:20 KST.
    "log-tables-purge": {
        "task": "app.celery_app.run_log_tables_purge",
        "schedule": crontab(hour=3, minute=20),
    },
    # 기술 트렌드 수집 (07:00 KST)
    "daily-trend-collect": {
        "task": "app.celery_app.run_trend_collect",
        "schedule": crontab(hour=7, minute=0),
    },
    # 리소스 수 스냅샷 — 주기는 운영자가 설정(AppSetting cron). 매분 디스패처가 cron 매치 시 수집.
    "resource-count-snapshot-dispatcher": {
        "task": "app.celery_app.dispatch_resource_count_snapshot",
        "schedule": crontab(minute="*"),
    },
    # BatchJob.cron 디스패처 — 매 분마다 등록된 잡들을 스캔하고
    # cron 표현식이 매치하는 잡을 run_batch_job 으로 큐잉.
    "batch-job-dispatcher": {
        "task": "app.celery_app.run_batch_job_dispatcher",
        "schedule": crontab(minute="*"),
    },
    # 클러스터 아이템(현황 카드) 자동 수집 디스패처 — 매시 정각, 스케줄 시(KST) 일치 아이템 수집.
    # 기본 'K8s 노드 수' 아이템은 schedule_hour=1 (새벽 1시) 로 매일 1회 수집된다.
    "cluster-item-dispatcher": {
        "task": "app.celery_app.run_cluster_item_dispatcher",
        "schedule": crontab(minute=0),
    },
    # 서비스 아키텍처 문서 현행화 — 주기는 운영자 설정(AppSetting cron). 매분 디스패처 평가.
    "arch-doc-sync-dispatcher": {
        "task": "app.celery_app.dispatch_architecture_doc_sync",
        "schedule": crontab(minute="*"),
    },
    # 주간보고 자동 생성 — 설정 cron(기본 금 17:00) 평가 후 Confluence 게시.
    "weekly-report-dispatcher": {
        "task": "app.celery_app.dispatch_weekly_report",
        "schedule": crontab(minute="*"),
    },
    # K8S 자원 효율화 — NS/워크로드 request·usage·quota 샘플 수집(클러스터별 cron, 기본 10분)
    # + 추천 생성 + opt-in NS 자동화 평가. 매분 디스패처가 클러스터별 due 를 평가해 팬아웃.
    "k8s-efficiency-dispatcher": {
        "task": "app.celery_app.dispatch_k8s_efficiency_collect",
        "schedule": crontab(minute="*"),
    },
}


@celery_app.task(bind=True, name="app.celery_app.run_check_matrix_dispatch", ignore_result=True)
def run_check_matrix_dispatch(self):
    """점검 매트릭스 디스패처 — 매분 실행, due 한 core_bundle(Cluster.check_cron_expr) +
    항목별 스케줄(CheckMatrixSchedule) 을 평가해 그 자리에서 동기 실행.

    구 run_scheduled_check/run_scheduled_single_check(고정 09/13/18시 + CheckSchedule
    on/off) 를 완전 대체. core_bundle 실행은 기존 DailyChecker.run_daily_check() 를
    그대로 호출하므로 Cluster.status authority·AI 리뷰 파이프라인은 무변경.
    """
    import logging
    from app.database import SessionLocal
    from app.services import check_matrix_service as cms

    db = SessionLocal()
    try:
        return cms.dispatch_due(db)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).exception("run_check_matrix_dispatch failed: %s", e)
        return {"error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name="app.celery_app.run_check_matrix_core_bundle_one",
    time_limit=180,
    soft_time_limit=150,
    ignore_result=True,
)
def run_check_matrix_core_bundle_one(self, cluster_id: str):
    """디스패처가 fan-out 한 단일 클러스터 core_bundle 실행.

    독립된 time_limit 을 가지므로 이 클러스터가 느리거나 멎어도 같은 분에 큐잉된
    다른 클러스터/셀 태스크에 영향을 주지 않는다(과거엔 디스패처 태스크 하나 안에서
    전 클러스터를 직렬 실행해 하나가 느리면 전체가 5분 SIGKILL 로 유실됐다).
    """
    import logging
    from app.database import SessionLocal
    from app.models import Cluster
    from app.services import check_matrix_service as cms

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            return {"error": "cluster not found", "cluster_id": cluster_id}
        cms.run_core_bundle(db, cluster)
        return {"cluster_id": cluster_id, "ok": True}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("check-matrix core_bundle task failed cluster_id=%s: %s", cluster_id, e)
        return {"error": str(e)[:200], "cluster_id": cluster_id}
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name="app.celery_app.run_check_matrix_cell_one",
    time_limit=280,
    soft_time_limit=240,
    ignore_result=True,
)
def run_check_matrix_cell_one(self, item_id: str, cluster_id: str):
    """디스패처가 fan-out 한 단일 item×cluster 셀(deep_check/addon) 실행."""
    import logging
    from app.database import SessionLocal
    from app.models import Cluster, CheckMatrixItem
    from app.services import check_matrix_service as cms

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if item is None or cluster is None:
            return {
                "error": "item or cluster not found",
                "item_id": item_id,
                "cluster_id": cluster_id,
            }
        executed = cms.execute_item_for_cluster(db, item, cluster)
        return {"item_id": item_id, "cluster_id": cluster_id, "executed": executed}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception(
            "check-matrix cell task failed item_id=%s cluster_id=%s: %s", item_id, cluster_id, e,
        )
        return {"error": str(e)[:200], "item_id": item_id, "cluster_id": cluster_id}
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name="app.celery_app.run_check_matrix_definition_one",
    time_limit=280,
    soft_time_limit=240,
    ignore_result=True,
)
def run_check_matrix_definition_one(self, definition_id: str, cluster_id: str):
    """디스패처가 fan-out 한 단일 DeepCheckDefinition×cluster 실행."""
    import logging
    from app.database import SessionLocal
    from app.models import Cluster
    from app.services import check_matrix_service as cms

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            return {"error": "cluster not found", "cluster_id": cluster_id}
        return cms.execute_definition_for_cluster(db, definition_id, cluster)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception(
            "check-matrix definition task failed definition_id=%s cluster_id=%s: %s",
            definition_id, cluster_id, e,
        )
        return {
            "error": str(e)[:200],
            "definition_id": definition_id,
            "cluster_id": cluster_id,
        }
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name="app.celery_app.run_check_matrix_run_one",
    time_limit=280,
    soft_time_limit=240,
    ignore_result=True,
)
def run_check_matrix_run_one(self, run_id: str):
    """사용자가 트리거한 일괄 수행(클러스터 열 / 항목 행)의 개별 셀 실행.

    ``CheckMatrixRun`` 이 이미 queued 로 만들어져 있고, 이 태스크는 그 레코드를
    running → success/failed/skipped 로 진행시킨다. 셀마다 독립 태스크라 느린
    클러스터 하나가 나머지 셀을 막지 않는다.
    """
    import logging
    from app.database import SessionLocal
    from app.services import check_matrix_service as cms

    db = SessionLocal()
    try:
        return cms.execute_run(db, run_id)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logging.getLogger(__name__).exception("check-matrix run task failed run_id=%s: %s", run_id, e)
        return {"error": str(e)[:200], "run_id": run_id}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_check_matrix_log_purge", ignore_result=True)
def run_check_matrix_log_purge(self):
    """점검 매트릭스 이력 리텐션 정리 — 매일 03:00 KST, 설정된 보관 일수 초과분 청크 삭제."""
    import logging
    from app.database import SessionLocal
    from app.services import check_matrix_service as cms

    db = SessionLocal()
    try:
        return cms.purge_expired_logs(db)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).exception("run_check_matrix_log_purge failed: %s", e)
        return {"error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.collect_resource_counts")
def collect_resource_counts(self):
    """전 클러스터 리소스 수 스냅샷(하루 1회). 일일점검 리뷰 추세용.

    클러스터 조회 + 직렬 수집(클러스터 수가 많지 않고 카운트는 가벼움). 한 클러스터
    실패가 다음 클러스터를 막지 않도록 개별 try/except.
    """
    from app.database import SessionLocal
    from app.models import Cluster, SnapshotSource
    from app.services import resource_count_service as rcs

    db = SessionLocal()
    results: list[dict] = []
    try:
        for cluster in db.query(Cluster).all():
            try:
                snap = rcs.collect_for_cluster(db, cluster, source=SnapshotSource.auto.value)
                results.append({"cluster": cluster.name, "snapshot_id": str(snap.id)})
            except Exception as e:  # noqa: BLE001
                db.rollback()
                results.append({"cluster": cluster.name, "error": str(e)[:200]})
        return {"executed_at": datetime.now().isoformat(), "results": results}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.collect_resource_counts_one")
def collect_resource_counts_one(self, cluster_id: str, user_id: str | None = None):
    """단일 클러스터 리소스 수 스냅샷 — 수동 "지금 스냅샷"(비동기) 용.

    동기 요청에서 돌리면 big k8s 에서 게이트웨이 타임아웃(504) → 큐잉해서 worker 가 처리.
    """
    import logging
    from app.database import SessionLocal
    from app.models import Cluster, SnapshotSource
    from app.services import resource_count_service as rcs

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            return {"error": "cluster not found", "cluster_id": cluster_id}
        snap = rcs.collect_for_cluster(db, cluster, source=SnapshotSource.manual.value, user_id=user_id)
        return {"cluster": cluster.name, "snapshot_id": str(snap.id), "counts": snap.counts}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("manual snapshot failed cluster=%s: %s", cluster_id, e)
        return {"error": str(e)[:200], "cluster_id": cluster_id}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.dispatch_resource_count_snapshot", ignore_result=True)
def dispatch_resource_count_snapshot(self):
    """운영자 설정 cron 에 맞춰 리소스 수 스냅샷을 트리거(매분 평가).

    배치잡 디스패처와 동일하게 croniter + tz + last_run 앵커로 cron 틱당 최대 1회 발사.
    """
    import logging
    from datetime import datetime, timedelta, timezone as _tz
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from app.config import settings
    from app.database import SessionLocal
    from app.services import resource_count_service as rcs

    log = logging.getLogger(__name__)
    try:
        from croniter import croniter
    except ImportError:
        return {"dispatched": False, "reason": "croniter_missing"}

    try:
        tz = ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        tz = ZoneInfo("Asia/Seoul")

    db = SessionLocal()
    try:
        sch = rcs.get_schedule(db)
        if not sch.get("enabled"):
            return {"dispatched": False, "reason": "disabled"}
        cron_expr = (sch.get("cron") or "").strip()
        if not croniter.is_valid(cron_expr):
            return {"dispatched": False, "reason": "invalid_cron"}

        now_aware = datetime.now(_tz.utc).astimezone(tz)
        now_naive = now_aware.replace(tzinfo=None)
        last = sch.get("last_run_at")
        if last:
            try:
                anchor = datetime.fromisoformat(last).astimezone(tz).replace(tzinfo=None)
            except Exception:  # noqa: BLE001
                anchor = now_naive - timedelta(days=1)
        else:
            anchor = now_naive - timedelta(days=1)

        try:
            next_fire = croniter(cron_expr, anchor).get_next(datetime)
        except Exception:  # noqa: BLE001
            return {"dispatched": False, "reason": "cron_eval_error"}

        if next_fire > now_naive:
            return {"dispatched": False, "reason": "not_due", "next_fire": next_fire.isoformat()}

        # due → 수집 트리거 + last_run 갱신(현재 UTC iso)
        collect_resource_counts.delay()
        rcs.set_schedule(db, sch["enabled"], cron_expr, last_run_at=datetime.now(_tz.utc).isoformat())
        return {"dispatched": True, "fired_at": now_aware.isoformat()}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.sync_all_architecture_docs", ignore_result=True)
def sync_all_architecture_docs(self):
    """auto_sync_enabled 문서 전체 현행화 — 문서 하나의 실패가 배치를 막지 않는다."""
    import logging
    from app.database import SessionLocal
    from app.models import LakeService
    from app.models.service_arch_doc import ServiceArchDoc
    from app.services import architecture_doc_service as ads

    log = logging.getLogger(__name__)
    db = SessionLocal()
    synced, failed = 0, 0
    try:
        docs = (
            db.query(ServiceArchDoc)
            .filter(ServiceArchDoc.auto_sync_enabled.is_(True))
            .all()
        )
        for doc in docs:
            service = db.query(LakeService).filter(
                LakeService.id == doc.lake_service_id, LakeService.enabled.is_(True)
            ).first()
            if service is None:
                continue
            try:
                res = ads.sync_doc(db, service, triggered_by="scheduled")
                if res.last_sync_status == "failed":
                    failed += 1
                else:
                    synced += 1
            except Exception as e:  # noqa: BLE001
                db.rollback()
                failed += 1
                log.exception("arch doc scheduled sync 실패 service=%s: %s", doc.lake_service_id, e)
        return {"synced": synced, "failed": failed}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.dispatch_architecture_doc_sync", ignore_result=True)
def dispatch_architecture_doc_sync(self):
    """운영자 설정 cron 에 맞춰 아키텍처 문서 현행화 트리거(매분 평가).

    리소스 스냅샷 디스패처와 동일 — croniter + tz + last_run 앵커로 cron 틱당 최대 1회.
    """
    import logging
    from datetime import datetime, timedelta, timezone as _tz
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from app.config import settings
    from app.database import SessionLocal
    from app.services import architecture_doc_service as ads

    log = logging.getLogger(__name__)
    try:
        from croniter import croniter
    except ImportError:
        return {"dispatched": False, "reason": "croniter_missing"}

    try:
        tz = ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        tz = ZoneInfo("Asia/Seoul")

    db = SessionLocal()
    try:
        sch = ads.get_schedule(db)
        if not sch.get("enabled"):
            return {"dispatched": False, "reason": "disabled"}
        cron_expr = (sch.get("cron") or "").strip()
        if not croniter.is_valid(cron_expr):
            return {"dispatched": False, "reason": "invalid_cron"}

        now_aware = datetime.now(_tz.utc).astimezone(tz)
        now_naive = now_aware.replace(tzinfo=None)
        last = sch.get("last_run_at")
        if last:
            try:
                anchor = datetime.fromisoformat(last).astimezone(tz).replace(tzinfo=None)
            except Exception:  # noqa: BLE001
                anchor = now_naive - timedelta(days=1)
        else:
            anchor = now_naive - timedelta(days=1)

        try:
            next_fire = croniter(cron_expr, anchor).get_next(datetime)
        except Exception:  # noqa: BLE001
            return {"dispatched": False, "reason": "cron_eval_error"}

        if next_fire > now_naive:
            return {"dispatched": False, "reason": "not_due", "next_fire": next_fire.isoformat()}

        sync_all_architecture_docs.delay()
        ads.set_schedule(db, sch["enabled"], cron_expr, last_run_at=datetime.now(_tz.utc).isoformat())
        return {"dispatched": True, "fired_at": now_aware.isoformat()}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.generate_arch_doc_llm", ignore_result=True)
def generate_arch_doc_llm(self, doc_id: str):
    """아키텍처 문서 LLM enrichment — 최초 sync 시 백그라운드 1회 (fail-safe)."""
    import logging
    from app.database import SessionLocal
    from app.models import LakeService
    from app.models.service_arch_doc import ServiceArchDoc
    from app.services import architecture_doc_service as ads

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        doc = db.query(ServiceArchDoc).filter(ServiceArchDoc.id == doc_id).first()
        if doc is None:
            return {"error": "doc not found", "doc_id": doc_id}
        service = db.query(LakeService).filter(LakeService.id == doc.lake_service_id).first()
        if service is None:
            return {"error": "service not found", "doc_id": doc_id}
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            doc = loop.run_until_complete(ads.generate_llm_content(db, doc, service))
        finally:
            loop.close()
        return {"doc_id": doc_id, "llm_status": doc.llm_status}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("generate_arch_doc_llm 실패 doc=%s: %s", doc_id, e)
        return {"error": str(e)[:200], "doc_id": doc_id}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_trend_collect", ignore_result=True)
def run_trend_collect(self):
    """매일 07:00 KST 기술 트렌드 수집"""
    from app.database import SessionLocal
    from app.services.trends.trend_service import TrendService

    db = SessionLocal()
    try:
        svc = TrendService(db)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        digest = loop.run_until_complete(svc.run_daily_collect())
        loop.close()
        return {
            "digest_date": str(digest.digest_date),
            "status": digest.status,
            "item_count": digest.item_count,
        }
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_batch_job")
def run_batch_job(
    self,
    job_id: str,
    *,
    password: str | None = None,
    private_key: str | None = None,
    trigger: str = "schedule",
    triggered_by_user_id: str | None = None,
    triggered_by_username: str | None = None,
):
    """Execute a registered batch job by id.

    Used for scheduled runs (Celery Beat) and ad-hoc background triggers
    (`trigger="bulk"` from the bulk-run endpoint, which passes the
    requesting user via `triggered_by_*` so the resulting BatchJobRun keeps
    an admin-visible record of who queued it — pure `trigger="schedule"`
    runs from Beat leave these None). If `password`/`private_key` are not
    supplied, `execute_job` falls back to the encrypted credentials saved
    on the BatchJob row.
    """
    from uuid import UUID
    from app.database import SessionLocal
    from app.services.batch_job_service import execute_job, get_job_or_404

    db = SessionLocal()
    try:
        job = get_job_or_404(db, UUID(job_id))
        if not job.enabled:
            return {"job_id": job_id, "skipped": True, "reason": "disabled"}

        # "중지" 요청이 이 실행을 revoke(terminate=True) 로 찾아 죽일 수 있도록
        # 자기 자신의 celery task id 를 잡에 기록해둔다. execute_job 이 끝나면
        # (성공/실패 불문) 항상 다시 None 으로 지운다.
        job.active_task_id = self.request.id
        db.commit()

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            try:
                run, result = loop.run_until_complete(
                    execute_job(
                        db,
                        job,
                        password=password,
                        private_key=private_key,
                        trigger=trigger,
                        triggered_by_user_id=triggered_by_user_id,
                        triggered_by_username=triggered_by_username,
                    )
                )
            finally:
                # execute_job 이 정상 경로(_run_and_record)를 못 타고 일찍 raise 하는
                # 예외적인 경우(예: UnknownJobType)에도 active_task_id 는 항상 정리한다.
                if job.active_task_id == self.request.id:
                    job.active_task_id = None
                    db.commit()
        finally:
            loop.close()

        return {
            "job_id": job_id,
            "run_id": str(run.id),
            "status": result.status,
            "duration_ms": result.duration_ms,
        }
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_batch_job_dispatcher", ignore_result=True)
def run_batch_job_dispatcher(self):
    """Scan registered BatchJob rows and queue any whose cron expression
    is due. Runs every minute via Celery Beat.

    A job fires when its cron's "previous fire time" is strictly newer
    than ``last_run_at`` — that way Beat downtime (worker restart, brief
    outage) doesn't cause a flood of catch-up runs, and a normal-running
    minute fires each cron at most once.

    Design Ref: §2.3.2 — tz-aware dispatcher.
    croniter is timezone-naive, so we convert ``last_run_at`` (naive UTC
    in DB) and ``now`` to ``settings.batch_jobs_timezone`` before passing
    them. The DB column itself stays naive UTC — no migration.
    """
    import logging
    from datetime import datetime, timedelta, timezone as _tz
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from app.config import settings
    from app.database import SessionLocal
    from app.models import BatchJob
    from app.services.batch_jobs import get_executor

    log = logging.getLogger(__name__)

    try:
        from croniter import croniter
    except ImportError:
        log.warning("croniter not installed — batch job dispatcher disabled")
        return {"dispatched": 0, "reason": "croniter_missing"}

    # Resolve timezone with safe fallback so a typo in BATCH_JOBS_TIMEZONE
    # never kills the dispatcher for all jobs.
    try:
        tz = ZoneInfo(settings.batch_jobs_timezone)
        tz_name = settings.batch_jobs_timezone
    except (ZoneInfoNotFoundError, ValueError, OSError):
        log.warning(
            "invalid BATCH_JOBS_TIMEZONE=%r — falling back to Asia/Seoul",
            settings.batch_jobs_timezone,
        )
        tz = ZoneInfo("Asia/Seoul")
        tz_name = "Asia/Seoul"

    db = SessionLocal()
    dispatched: list[str] = []
    skipped_reasons: dict[str, int] = {}
    try:
        now_utc = datetime.now(_tz.utc)
        now_aware = now_utc.astimezone(tz)
        check_at = now_utc.replace(tzinfo=None)  # naive UTC — DB 컬럼과 동일 기준
        jobs = (
            db.query(BatchJob)
            .filter(BatchJob.enabled.is_(True))
            .filter(BatchJob.cron.isnot(None))
            .all()
        )
        for job in jobs:
            # 매 분 평가 결과를 잡에 기록 → 운영자가 "왜 스케줄이 안 돌았는지" 확인 가능.
            note: str | None = None
            cron_expr = (job.cron or "").strip()
            if not cron_expr:
                continue
            executor = get_executor(job.job_type)
            job_needs_ssh = True if executor is None else executor.requires_ssh
            if not croniter.is_valid(cron_expr):
                skipped_reasons["invalid_cron"] = skipped_reasons.get("invalid_cron", 0) + 1
                note = "cron 표현식 오류"
            elif job_needs_ssh and not (job.encrypted_password or job.encrypted_private_key):
                # No saved credentials → unattended run can't authenticate.
                # (수동 실행은 요청에 비밀번호를 실어 동작하지만, 무인 스케줄은 저장 자격증명 필요)
                skipped_reasons["no_credentials"] = skipped_reasons.get("no_credentials", 0) + 1
                note = "저장된 자격증명 없음 — 무인 실행 불가 (자격증명 저장 필요)"
            else:
                # last_run_at is naive UTC in DB. Re-attach UTC tzinfo, then convert
                # to the configured zone so croniter interprets cron in the operator's tz.
                raw_anchor = job.last_run_at or (now_utc - timedelta(days=1)).replace(tzinfo=None)
                anchor_naive = raw_anchor.replace(tzinfo=_tz.utc).astimezone(tz).replace(tzinfo=None)
                now_naive = now_aware.replace(tzinfo=None)
                try:
                    next_fire = croniter(cron_expr, anchor_naive).get_next(datetime)
                except Exception:
                    skipped_reasons["cron_eval_error"] = skipped_reasons.get("cron_eval_error", 0) + 1
                    note = "cron 평가 오류"
                else:
                    if next_fire > now_naive:
                        note = f"대기 — 다음 실행 {next_fire:%Y-%m-%d %H:%M} ({tz_name})"
                    else:
                        # anchor(last_run_at)를 큐잉 시점에 바로 전진시킨다. 예전엔
                        # execute_job 이 실제로 "끝난" 뒤에야 last_run_at 을 갱신했는데,
                        # 워커가 바빠서 큐잉된 태스크가 1분 안에 시작도 못 하면 다음 분
                        # 디스패처가 여전히 옛 anchor 를 보고 같은 잡을 또 큐잉했다
                        # (etcd defrag 같은 잡이 중복 실행될 수 있었음). execute_job 이
                        # 완료 후 다시 last_run_at 을 finished_at 으로 갱신하므로 anchor 는
                        # 계속 전진만 한다(역행 없음).
                        run_batch_job.delay(str(job.id))
                        dispatched.append(str(job.id))
                        job.last_run_at = check_at
                        note = "실행 큐잉됨"

            job.last_schedule_check_at = check_at
            if note is not None:
                job.last_schedule_note = note

        try:
            db.commit()
        except Exception:
            db.rollback()

        return {
            "checked": len(jobs),
            "dispatched": len(dispatched),
            "dispatched_ids": dispatched,
            "skipped": skipped_reasons,
            "executed_at": now_aware.isoformat(),
            "timezone": tz_name,
        }
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_review_and_notify", ignore_result=True)
def run_review_and_notify(self, daily_check_log_id: str):
    """Ollama 기반 AI 리뷰 생성 → DailyCheckLog 에 저장 → 알림 채널 fan-out.

    DailyChecker.run_daily_check() commit 직후 .delay() 로 호출된다.
    Ollama / Notifier 가 fail-safe 라 이 태스크가 raise 해도 점검 자체는 영향 없음.
    """
    from app.database import SessionLocal
    from app.services.review_service import ReviewService

    db = SessionLocal()
    try:
        svc = ReviewService(db)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(svc.review_and_persist(daily_check_log_id))
        finally:
            loop.close()

        # 알림은 best-effort. 실패해도 리뷰 결과는 남는다.
        try:
            from app.services.notifier import notify_for_check_log
            notify_for_check_log(db, daily_check_log_id)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Notifier dispatch failed")

        return {
            "daily_check_log_id": daily_check_log_id,
            "ai_status": result.get("ai_status"),
        }
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_single_check")
def run_single_check(self, cluster_id: str):
    """단일 클러스터 체크 실행 (수동)"""
    from app.database import SessionLocal
    from app.models import CheckScheduleType
    from app.services.daily_checker import DailyChecker

    db = SessionLocal()

    try:
        checker = DailyChecker(db)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(
            checker.run_daily_check(cluster_id, CheckScheduleType.manual)
        )
        loop.close()

        return {
            "cluster_id": cluster_id,
            "status": result.overall_status.value,
            "api_server_status": result.api_server_status.value,
            "total_nodes": result.total_nodes,
            "ready_nodes": result.ready_nodes,
            "checked_at": result.checked_at.isoformat()
        }

    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_cluster_item_dispatcher", ignore_result=True)
def run_cluster_item_dispatcher(self):
    """현황 카드(ClusterItem) 자동 수집 디스패처 — 매시 정각 실행(Beat).

    현재 시(KST)와 아이템의 schedule_hour 가 일치하고 auto_enabled 인
    아이템을 수집한다. 기본 'K8s 노드 수' 는 schedule_hour=1 → 매일 새벽 1시.
    """
    from datetime import datetime, timezone as _tz
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from app.database import SessionLocal
    from app.services import cluster_item_service as cis

    try:
        tz = ZoneInfo("Asia/Seoul")
    except (ZoneInfoNotFoundError, ValueError, OSError):
        tz = None
    now_hour = (
        datetime.now(_tz.utc).astimezone(tz).hour if tz else datetime.utcnow().hour
    )

    db = SessionLocal()
    try:
        results = cis.run_due_auto_items(db, now_hour)
        return {
            "executed_at": datetime.now().isoformat(),
            "hour_kst": now_hour,
            "fired": len(results),
            "results": results,
        }
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_ops_check_batch")
def run_ops_check_batch(self, run_id: str):
    """운영 점검 콘솔 — 선택한 항목 묶음(OpsCheckRun)을 백그라운드 실행.

    항목마다 진행 상태/결과를 즉시 커밋하므로 콘솔이 폴링으로 진행률을 본다.
    """
    from app.database import SessionLocal
    from app.services.ops_check_service import OpsCheckService

    db = SessionLocal()
    try:
        OpsCheckService(db).execute_run(run_id)
        return {"run_id": run_id, "status": "done"}
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception("run_ops_check_batch failed (%s): %s", run_id, e)
        return {"run_id": run_id, "error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_deep_check_for_cluster")
def run_deep_check_for_cluster(self, cluster_id: str, daily_check_log_id: str | None = None):
    """클러스터의 enabled deep check 전체를 백그라운드로 실행 + AI 리뷰 큐잉.

    수동 "지금 실행"(POST /deep-check/run/{cluster_id}) 이 exec·파드생성 다수를
    직렬로 도는 동안 요청이 블로킹/504 되는 것을 막기 위해 worker 로 넘긴다.
    """
    from app.database import SessionLocal
    from app.services.deep_check_service import DeepCheckService

    db = SessionLocal()
    try:
        svc = DeepCheckService(db)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            n, log_id = loop.run_until_complete(
                svc.run_for_cluster(
                    cluster_id,
                    in_cluster=False,
                    daily_check_log_id=daily_check_log_id,
                )
            )
        finally:
            loop.close()

        if log_id:
            try:
                run_review_and_notify.delay(log_id)
            except Exception:  # noqa: BLE001
                import logging
                logging.getLogger(__name__).warning(
                    "run_deep_check_for_cluster: review 큐잉 실패 (log=%s)", log_id
                )
        return {"cluster_id": cluster_id, "checks_run": n, "daily_check_log_id": log_id}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        import logging
        logging.getLogger(__name__).exception(
            "run_deep_check_for_cluster failed (%s): %s", cluster_id, e
        )
        return {"cluster_id": cluster_id, "error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_deep_check_results_purge", ignore_result=True)
def run_deep_check_results_purge(self):
    """deep_check_results 리텐션 정리 — 매일 03:10 KST, 보관일수 초과분 청크 삭제.

    check_matrix_result_logs 와 동일하게 무한 증가를 막는다(각 cron 실행마다 행 적재).
    """
    import logging
    from app.database import SessionLocal
    from app.services.deep_check_service import purge_expired_results

    db = SessionLocal()
    try:
        return purge_expired_results(db)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).exception("run_deep_check_results_purge failed: %s", e)
        return {"error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_log_tables_purge", ignore_result=True)
def run_log_tables_purge(self):
    """daily_check_logs/check_logs/k8s_events/audit_logs/user_notifications 리텐션
    정리 — 매일 03:20 KST. 테이블별 보관일수는 log_retention_service.RETENTION_DAYS.
    """
    import logging
    from app.database import SessionLocal
    from app.services import log_retention_service

    db = SessionLocal()
    try:
        return log_retention_service.purge_all(db)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).exception("run_log_tables_purge failed: %s", e)
        return {"error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.compute_work_item_embedding")
def compute_work_item_embedding(self, work_item_id: str):
    """WorkItem 제목+본문 임베딩을 비동기로 계산·저장.

    create_work_item/update_work_item 이 커밋 직후 .delay() 로 큐잉한다(best-effort —
    Celery/Redis/Ollama 미가용이어도 쓰기 응답 자체는 이미 끝난 뒤라 영향 없음).
    """
    import logging
    from app.database import SessionLocal
    from app.models.work_item import WorkItem
    from app.services.embedding_service import build_embedding_text, embedding_service

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        item = db.query(WorkItem).filter(WorkItem.id == work_item_id).first()
        if item is None:
            return {"work_item_id": work_item_id, "skipped": True, "reason": "not found"}

        text = build_embedding_text(item.title, item.content)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            vector = loop.run_until_complete(embedding_service.embed(text))
        finally:
            loop.close()

        if vector is None:
            return {"work_item_id": work_item_id, "skipped": True, "reason": "embedding unavailable"}

        item.embedding = vector
        db.commit()
        return {"work_item_id": work_item_id, "dim": len(vector)}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("compute_work_item_embedding failed (%s): %s", work_item_id, e)
        return {"work_item_id": work_item_id, "error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.compute_work_guide_embedding")
def compute_work_guide_embedding(self, work_guide_id: str):
    """WorkGuide(지식허브 TipTap 문서) 제목+본문 임베딩을 비동기로 계산·저장.

    create_guide/update_guide 가 커밋 직후 .delay() 로 큐잉한다(best-effort).
    """
    import logging
    from app.database import SessionLocal
    from app.models.work_guide import WorkGuide
    from app.services.embedding_service import build_embedding_text, embedding_service

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        guide = db.query(WorkGuide).filter(WorkGuide.id == work_guide_id).first()
        if guide is None:
            return {"work_guide_id": work_guide_id, "skipped": True, "reason": "not found"}

        text = build_embedding_text(guide.title, guide.content)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            vector = loop.run_until_complete(embedding_service.embed(text))
        finally:
            loop.close()

        if vector is None:
            return {"work_guide_id": work_guide_id, "skipped": True, "reason": "embedding unavailable"}

        guide.embedding = vector
        db.commit()
        return {"work_guide_id": work_guide_id, "dim": len(vector)}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("compute_work_guide_embedding failed (%s): %s", work_guide_id, e)
        return {"work_guide_id": work_guide_id, "error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.dispatch_weekly_report", ignore_result=True)
def dispatch_weekly_report(self):
    """주간보고 자동 생성·게시 디스패처 — 설정 cron 을 매분 평가해 tick 당 최대 1회 실행.

    아키텍처 문서 디스패처와 동일한 croniter + tz + last_run 앵커 패턴. 게시는 사용자
    세션이 필요하므로, **마지막으로 Confluence 세션이 확인된 사용자**의 자격으로 수행한다
    (없으면 건너뛴다 — 자동 게시는 세션 없이는 불가능하다)."""
    import asyncio
    import logging
    from datetime import datetime, timedelta, timezone as _tz
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from app.config import settings
    from app.database import SessionLocal

    log = logging.getLogger(__name__)
    try:
        from croniter import croniter
    except ImportError:
        return {"dispatched": False, "reason": "croniter_missing"}

    try:
        tz = ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        tz = ZoneInfo("Asia/Seoul")

    db = SessionLocal()
    try:
        from app.models.app_setting import AppSetting
        from app.models.user import User
        from app.models.user_jira_credential import UserJiraCredential
        from app.routers.jira import (
            WEEKLY_SETTINGS_KEY, DEFAULT_WEEKLY_SETTINGS, _get_config,
            _confluence_service_verified,
        )
        from app.services import weekly_report_service

        row = db.query(AppSetting).filter(AppSetting.key == WEEKLY_SETTINGS_KEY).first()
        sch = dict(DEFAULT_WEEKLY_SETTINGS)
        if row and isinstance(row.value, dict):
            sch.update(row.value)
        if not sch.get("auto_enabled"):
            return {"dispatched": False, "reason": "disabled"}
        cron_expr = (sch.get("auto_cron") or "").strip()
        if not croniter.is_valid(cron_expr):
            return {"dispatched": False, "reason": "invalid_cron"}

        now_aware = datetime.now(_tz.utc).astimezone(tz)
        now_naive = now_aware.replace(tzinfo=None)
        last = sch.get("last_run_at")
        try:
            anchor = (datetime.fromisoformat(last).astimezone(tz).replace(tzinfo=None)
                      if last else now_naive - timedelta(days=7))
        except Exception:  # noqa: BLE001
            anchor = now_naive - timedelta(days=7)
        try:
            next_fire = croniter(cron_expr, anchor).get_next(datetime)
        except Exception:  # noqa: BLE001
            return {"dispatched": False, "reason": "cron_eval_error"}
        if next_fire > now_naive:
            return {"dispatched": False, "reason": "not_due"}

        # 게시 주체 — Confluence 세션이 저장된 사용자 중 가장 최근 검증된 사람.
        cred = (
            db.query(UserJiraCredential)
            .filter(UserJiraCredential.confluence_cookie_encrypted.isnot(None))
            .order_by(UserJiraCredential.last_verified_at.desc().nullslast())
            .first()
        )
        if not cred:
            return {"dispatched": False, "reason": "no_confluence_session"}
        actor = db.query(User).filter(User.username == cred.username).first()
        if not actor:
            return {"dispatched": False, "reason": "actor_missing"}

        cfg = _get_config(db)
        report = weekly_report_service.build_report(
            db, project_filter=sch.get("project_filter", ""))
        space_key = (sch.get("space_key") or "").strip()
        if not space_key:
            return {"dispatched": False, "reason": "no_space_key"}
        title = (sch.get("title_template") or "주간보고 {start} ~ {end}").format(
            start=report["period_start"], end=report["period_end"])
        body = weekly_report_service.render_storage_html(report)

        loop = asyncio.new_event_loop()
        try:
            svc, res = loop.run_until_complete(_confluence_service_verified(db, actor, cfg))
            if svc is None or res.get("status") != "ok":
                return {"dispatched": False, "reason": "confluence_unavailable"}
            out = loop.run_until_complete(svc.upsert_page(
                space_key, title, body, parent_id=(sch.get("parent_page_id") or "")))
        finally:
            loop.close()

        sch["last_run_at"] = datetime.now(_tz.utc).isoformat()
        if row:
            row.value = sch
        else:
            db.add(AppSetting(key=WEEKLY_SETTINGS_KEY, value=sch))
        db.commit()
        log.info("weekly report auto-publish: %s", out.get("status"))
        return {"dispatched": True, "result": out.get("status"), "action": out.get("action")}
    except Exception as exc:  # noqa: BLE001 - 디스패처는 절대 죽지 않는다
        log.warning("weekly report dispatcher failed: %s", exc)
        return {"dispatched": False, "reason": "error"}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_auto_incident_analysis",
                 ignore_result=True, time_limit=240)
def run_auto_incident_analysis(self, alert_event_id: str, rule_id: str | None = None,
                               include_logs: bool = False, notify_analysis: bool = False):
    """알람 1건에 대한 AI 자동 분석 — 전용 `llm` 큐에서 실행.

    `services/observability/analysis_hook.maybe_enqueue_analysis` 가 scope 매칭·
    디바운스·레이트 검사를 통과시킨 알람만 여기 도착한다 (수동 실행은
    `POST /observability/alerts/{id}/analyze`). 분석은 **읽기 전용**이다 —
    결과는 사람이 읽는 조치 가이드일 뿐 어떤 실행 경로도 없다.
    실패해도 알람 자체에는 영향이 없다 (analysis_status=failed 로만 기록).
    """
    import logging
    import time as _time
    import uuid as _uuid
    from datetime import datetime as _dt

    from app.database import SessionLocal
    from app.models import AlertEvent, IncidentAnalysis

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        try:
            event_uuid = _uuid.UUID(str(alert_event_id))
        except ValueError:
            return {"ok": False, "reason": "bad_id"}
        event = db.query(AlertEvent).filter(AlertEvent.id == event_uuid).first()
        if event is None:
            return {"ok": False, "reason": "alert_not_found"}

        analysis = IncidentAnalysis(
            alert_event_id=event.id,
            cluster_id=event.cluster_id,
            namespace=event.namespace,
            resource=event.resource,
            trigger="alert" if rule_id else "manual",
            status="running",
            matched_rule_id=rule_id,
        )
        db.add(analysis)
        db.flush()
        event.analysis_id = analysis.id
        event.analysis_status = "running"
        db.commit()
        db.refresh(analysis)

        started = _time.monotonic()
        try:
            from app.services.analyzers.factory import get_analyzer
            from app.services.incident_context_builder import build_context_from_alert

            ctx = build_context_from_alert(db, event, include_logs=include_logs)
            analyzer = get_analyzer(db)
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(analyzer.analyze(ctx))
            finally:
                loop.close()

            analysis.severity = result.severity
            analysis.root_cause = result.root_cause
            analysis.suggested_actions = list(result.suggested_actions or [])
            analysis.related_runbooks = list(result.related_runbooks or [])
            analysis.citations = list(getattr(result, "citations", None) or [])
            analysis.confidence = result.confidence
            analysis.analyzed_by = result.analyzed_by
            analysis.status = "done"
        except Exception as exc:  # noqa: BLE001
            log.warning("auto incident analysis failed (alert=%s): %s", alert_event_id, exc)
            analysis.status = "failed"
            analysis.error = str(exc)[:500]
        analysis.duration_ms = int((_time.monotonic() - started) * 1000)
        analysis.finished_at = _dt.utcnow()
        event.analysis_status = analysis.status
        db.commit()

        # 후속 알림은 best-effort — 실패해도 분석 결과는 남는다.
        if notify_analysis and analysis.status == "done":
            try:
                from app.services.user_notify import notify_broadcast
                summary = (analysis.root_cause or "")[:200]
                notify_broadcast(
                    db,
                    type="alert",
                    title=f"[AI 분석] {event.alertname}",
                    body=f"원인 분석: {summary}",
                    link=f"/alerts?id={event.id}",
                )
                db.commit()
            except Exception:  # noqa: BLE001
                log.exception("analysis notify failed")

        return {"ok": True, "analysis_id": str(analysis.id), "status": analysis.status}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_auto_incident_analysis_k8s_event",
                 ignore_result=True, time_limit=240)
def run_auto_incident_analysis_k8s_event(self, k8s_event_id: str, rule_id: str | None = None,
                                         include_logs: bool = False, notify_analysis: bool = False):
    """K8s 이벤트(kubewatch) 1건에 대한 AI 자동 분석 — 전용 `llm` 큐에서 실행.

    `services/observability/analysis_hook.maybe_enqueue_analysis_for_k8s_event` 가
    scope 매칭·디바운스·레이트 검사를 통과시킨 이벤트만 여기 도착한다 (수동 실행은
    `POST /events/{id}/analyze`). `run_auto_incident_analysis`(알람용)와 동일한
    분석 전용/fail-safe 계약 — 실패해도 이벤트 자체에는 영향이 없다.
    """
    import logging
    import time as _time
    import uuid as _uuid
    from datetime import datetime as _dt

    from app.database import SessionLocal
    from app.models import K8sEvent, IncidentAnalysis

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        try:
            event_uuid = _uuid.UUID(str(k8s_event_id))
        except ValueError:
            return {"ok": False, "reason": "bad_id"}
        event = db.query(K8sEvent).filter(K8sEvent.id == event_uuid).first()
        if event is None:
            return {"ok": False, "reason": "k8s_event_not_found"}

        analysis = IncidentAnalysis(
            k8s_event_id=event.id,
            cluster_id=event.cluster_id,
            namespace=event.namespace,
            resource=event.resource_name,
            trigger="k8s_event" if rule_id else "manual",
            status="running",
            matched_rule_id=rule_id,
        )
        db.add(analysis)
        db.flush()
        event.analysis_id = analysis.id
        event.analysis_status = "running"
        db.commit()
        db.refresh(analysis)

        started = _time.monotonic()
        try:
            from app.services.analyzers.factory import get_analyzer
            from app.services.incident_context_builder import build_context_from_k8s_event

            ctx = build_context_from_k8s_event(db, event, include_logs=include_logs)
            analyzer = get_analyzer(db)
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(analyzer.analyze(ctx))
            finally:
                loop.close()

            analysis.severity = result.severity
            analysis.root_cause = result.root_cause
            analysis.suggested_actions = list(result.suggested_actions or [])
            analysis.related_runbooks = list(result.related_runbooks or [])
            analysis.citations = list(getattr(result, "citations", None) or [])
            analysis.confidence = result.confidence
            analysis.analyzed_by = result.analyzed_by
            analysis.status = "done"
        except Exception as exc:  # noqa: BLE001
            log.warning("auto incident analysis failed (k8s_event=%s): %s", k8s_event_id, exc)
            analysis.status = "failed"
            analysis.error = str(exc)[:500]
        analysis.duration_ms = int((_time.monotonic() - started) * 1000)
        analysis.finished_at = _dt.utcnow()
        event.analysis_status = analysis.status
        db.commit()

        if notify_analysis and analysis.status == "done":
            try:
                from app.services.user_notify import notify_broadcast
                summary = (analysis.root_cause or "")[:200]
                notify_broadcast(
                    db,
                    type="k8s_event",
                    title=f"[AI 분석] {event.resource_kind}/{event.resource_name}",
                    body=f"원인 분석: {summary}",
                    link="/k8s-events",
                )
                db.commit()
            except Exception:  # noqa: BLE001
                log.exception("analysis notify failed")

        return {"ok": True, "analysis_id": str(analysis.id), "status": analysis.status}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.compute_ops_note_embedding")
def compute_ops_note_embedding(self, ops_note_id: str):
    """OpsNote 제목+앞뒤면 임베딩을 비동기로 계산·저장 (RAG 근거 인용용).

    ops_note 라우터의 create/update 가 커밋 직후 .delay() 로 큐잉한다(best-effort —
    compute_work_item_embedding 과 동일 패턴).
    """
    import logging
    from app.database import SessionLocal
    from app.models.ops_note import OpsNote
    from app.services.embedding_service import build_embedding_text, embedding_service

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        note = db.query(OpsNote).filter(OpsNote.id == ops_note_id).first()
        if note is None:
            return {"ops_note_id": ops_note_id, "skipped": True, "reason": "not found"}

        body = "\n\n".join(p for p in (note.content, note.back_content) if p)
        text = build_embedding_text(note.title, body)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            vector = loop.run_until_complete(embedding_service.embed(text))
        finally:
            loop.close()

        if vector is None:
            return {"ops_note_id": ops_note_id, "skipped": True, "reason": "embedding unavailable"}

        note.embedding = vector
        db.commit()
        return {"ops_note_id": ops_note_id, "dim": len(vector)}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("compute_ops_note_embedding failed (%s): %s", ops_note_id, e)
        return {"ops_note_id": ops_note_id, "error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.compute_ontology_event_embedding")
def compute_ontology_event_embedding(self, ontology_event_id: str):
    """OntologyEvent(구성변경 영향분석 이벤트) 제목+설명 임베딩을 비동기로 계산·저장.

    ontology 라우터의 `analyze_config_change_impact` 가 이벤트 커밋 직후 .delay() 로
    큐잉한다(best-effort — compute_ops_note_embedding 과 동일 패턴). RAG 근거 인용에서
    "과거 이런 구성 변경이 이런 영향을 미쳤다"는 사내 이력으로 검색된다.
    """
    import logging
    from app.database import SessionLocal
    from app.models.ontology import OntologyEvent
    from app.services.embedding_service import build_embedding_text, embedding_service

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        event = db.query(OntologyEvent).filter(OntologyEvent.id == ontology_event_id).first()
        if event is None:
            return {"ontology_event_id": ontology_event_id, "skipped": True, "reason": "not found"}

        text = build_embedding_text(event.title, event.description)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            vector = loop.run_until_complete(embedding_service.embed(text))
        finally:
            loop.close()

        if vector is None:
            return {"ontology_event_id": ontology_event_id, "skipped": True, "reason": "embedding unavailable"}

        event.embedding = vector
        db.commit()
        return {"ontology_event_id": ontology_event_id, "dim": len(vector)}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("compute_ontology_event_embedding failed (%s): %s", ontology_event_id, e)
        return {"ontology_event_id": ontology_event_id, "error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.backfill_embeddings", ignore_result=True,
                 time_limit=3600, soft_time_limit=3500)
def backfill_embeddings(self):
    """embedding 이 NULL 인 행 전수 백필 — RAG 도입/모델 교체 시 1회성 수동 실행.

    `POST /llm/backfill-embeddings` (admin) 가 전용 llm 큐로 큐잉한다.
    행 단위 실패는 건너뛰고 계속 진행한다.
    """
    import logging
    from app.database import SessionLocal
    from app.services.embedding_service import build_embedding_text, embedding_service

    log = logging.getLogger(__name__)
    db = SessionLocal()
    stats = {"work_items": 0, "work_guides": 0, "ops_notes": 0, "ontology_events": 0, "errors": 0}

    def _embed_sync(text: str):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(embedding_service.embed(text))
        finally:
            loop.close()

    try:
        from app.models.work_item import WorkItem
        from app.models.work_guide import WorkGuide
        from app.models.ops_note import OpsNote
        from app.models.ontology import OntologyEvent

        targets = [
            ("work_items", WorkItem, lambda r: build_embedding_text(r.title, r.content)),
            ("work_guides", WorkGuide, lambda r: build_embedding_text(r.title, r.content)),
            ("ops_notes", OpsNote, lambda r: build_embedding_text(
                r.title, "\n\n".join(p for p in (r.content, r.back_content) if p))),
            ("ontology_events", OntologyEvent, lambda r: build_embedding_text(r.title, r.description)),
        ]
        for key, model, text_fn in targets:
            try:
                rows = db.query(model).filter(model.embedding.is_(None)).limit(2000).all()
            except Exception as e:  # noqa: BLE001
                db.rollback()
                log.warning("backfill: %s 조회 실패 — 건너뜀 (%s)", key, e)
                continue
            for row in rows:
                try:
                    vector = _embed_sync(text_fn(row))
                    if vector is None:
                        continue
                    row.embedding = vector
                    db.commit()
                    stats[key] += 1
                except Exception:  # noqa: BLE001
                    db.rollback()
                    stats["errors"] += 1
        return stats
    finally:
        db.close()


# ── K8S 자원 효율화 (수집 → 추천 → 자동화 / 적용·롤백 실행) ───────────────────────
@celery_app.task(bind=True, name="app.celery_app.dispatch_k8s_efficiency_collect", ignore_result=True)
def dispatch_k8s_efficiency_collect(self):
    """클러스터별 effective cron(전역 기본 + 오버라이드)을 croniter 로 평가해 due 한 클러스터만
    `collect_k8s_efficiency_one` 으로 팬아웃(직렬 아님 — 대형 클러스터가 다른 클러스터를 막지 않게)."""
    import logging
    from datetime import datetime, timedelta, timezone as _tz
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from app.config import settings
    from app.database import SessionLocal
    from app.models import Cluster
    from app.services.k8s_efficiency import settings as effcfg

    log = logging.getLogger(__name__)
    try:
        from croniter import croniter
    except ImportError:
        return {"dispatched": [], "reason": "croniter_missing"}
    try:
        tz = ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        tz = ZoneInfo("Asia/Seoul")

    db = SessionLocal()
    fired: list[str] = []
    try:
        sch = effcfg.get_schedule(db)
        if not sch.get("enabled"):
            return {"dispatched": [], "reason": "disabled"}
        now_aware = datetime.now(_tz.utc).astimezone(tz)
        now_naive = now_aware.replace(tzinfo=None)
        for cluster in db.query(Cluster).all():
            enabled, cron_expr, last = effcfg.effective_cron(sch, str(cluster.id))
            if not enabled or not croniter.is_valid((cron_expr or "").strip()):
                continue
            anchor = now_naive - timedelta(days=1)
            if last:
                try:
                    anchor = datetime.fromisoformat(last).astimezone(tz).replace(tzinfo=None)
                except Exception:  # noqa: BLE001
                    pass
            try:
                next_fire = croniter(cron_expr.strip(), anchor).get_next(datetime)
            except Exception:  # noqa: BLE001
                continue
            if next_fire > now_naive:
                continue
            collect_k8s_efficiency_one.delay(str(cluster.id))
            effcfg.mark_cluster_run(db, str(cluster.id), datetime.now(_tz.utc).isoformat())
            fired.append(cluster.name)
        if fired:
            log.info("k8s efficiency collect dispatched: %s", fired)
        return {"dispatched": fired, "fired_at": now_aware.isoformat()}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.collect_k8s_efficiency_one",
                 time_limit=900, soft_time_limit=840)
def collect_k8s_efficiency_one(self, cluster_id: str, run_id: str | None = None, triggered_by: str | None = None):
    """단일 클러스터 수집 → 추천 생성 → 자동화 평가. 실행 로그(K8sEfficiencyRun)에 단계/로그 기록.
    전역 task_time_limit(300s)은 369노드급 전수 순회에 부족해 태스크 단위로 늘린다."""
    import logging
    from app.database import SessionLocal
    from app.models import Cluster
    from app.models.k8s_efficiency import K8sEfficiencyRun
    from app.services import audit_logger
    from app.services.k8s_efficiency import automation as effauto
    from app.services.k8s_efficiency import engine as effengine
    from app.services.k8s_efficiency import settings as effcfg
    from app.services.k8s_efficiency.collector import STEP_PLAN, collect_cluster
    from app.services.k8s_efficiency.runs import RunLogger, create_run

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            return {"error": "cluster not found", "cluster_id": cluster_id}
        run = db.query(K8sEfficiencyRun).filter(K8sEfficiencyRun.id == run_id).first() if run_id else None
        if run is None:
            run = create_run(db, cluster.id, "collect", trigger="schedule", triggered_by=triggered_by,
                             step_plan=STEP_PLAN + [{"id": "recommend", "label": "추천 생성"},
                                                    {"id": "automation", "label": "자동화 평가"}])
        run.celery_task_id = getattr(self.request, "id", None)
        rl = RunLogger(db, run)
        rl.start()
        rl.log(f"클러스터 {cluster.name} 수집 시작")
        result: dict = {}
        try:
            result = collect_cluster(db, cluster, log=rl.log, step=rl.step)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            log.exception("k8s efficiency collect failed cluster=%s", cluster_id)
            rl.log(f"수집 실패: {str(e)[:300]}")
            rl.finish("failed", error=str(e)[:300])
            return {"error": str(e)[:200], "cluster_id": cluster_id, "run_id": str(run.id)}

        defaults = effcfg.get_policy_defaults(db)
        rl.step("recommend", "running", None)
        try:
            rec = effengine.generate(db, cluster, defaults, log=rl.log)
            rl.step("recommend", "success", f"generated={rec.get('generated')} source={rec.get('usage_source')}")
            result["recommendations"] = rec
        except Exception as e:  # noqa: BLE001
            db.rollback()
            log.exception("k8s efficiency recommend failed cluster=%s", cluster_id)
            rl.log(f"추천 생성 실패: {str(e)[:300]}")
            rl.step("recommend", "failed", str(e)[:300])

        rl.step("automation", "running", None)
        try:
            auto = effauto.dispatch_auto(
                db, cluster, defaults, log=rl.log,
                enqueue=lambda rid: run_k8s_efficiency_run.delay(str(rid)),
            )
            rl.step("automation", "success" if auto.get("runs") else "skipped",
                    f"runs={len(auto.get('runs') or [])}" if not auto.get("skipped") else auto["skipped"])
            result["automation"] = auto
        except Exception as e:  # noqa: BLE001
            db.rollback()
            log.exception("k8s efficiency automation failed cluster=%s", cluster_id)
            rl.log(f"자동화 평가 실패: {str(e)[:300]}")
            rl.step("automation", "failed", str(e)[:300])

        state = "succeeded" if "recommendations" in result else "partial"
        rl.log(f"완료 — NS {result.get('namespaces')} / 워크로드 {result.get('workloads')} / {result.get('elapsed_ms')}ms")
        rl.finish(state, summary=result)
        audit_logger.record(db, action="k8s.efficiency.collect.run", actor_username=triggered_by or "scheduler",
                            status="success" if state == "succeeded" else "failure", target_type="cluster",
                            target_id=str(cluster.id), details={"run_id": str(run.id), **{k: v for k, v in result.items() if k != "recommendations"}})
        return {"cluster": cluster.name, "run_id": str(run.id), **result}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_k8s_efficiency_recommend", time_limit=600)
def run_k8s_efficiency_recommend(self, run_id: str):
    """추천만 재생성(수집 없이) — 수동 "추천 재생성" 버튼."""
    import logging
    from app.database import SessionLocal
    from app.models import Cluster
    from app.models.k8s_efficiency import K8sEfficiencyRun
    from app.services.k8s_efficiency import engine as effengine
    from app.services.k8s_efficiency import settings as effcfg
    from app.services.k8s_efficiency.runs import RunLogger

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        run = db.query(K8sEfficiencyRun).filter(K8sEfficiencyRun.id == run_id).first()
        if run is None:
            return {"error": "run not found"}
        cluster = db.query(Cluster).filter(Cluster.id == run.cluster_id).first()
        rl = RunLogger(db, run)
        rl.start()
        rl.step("recommend", "running", None)
        try:
            rec = effengine.generate(db, cluster, effcfg.get_policy_defaults(db), log=rl.log)
            rl.step("recommend", "success", f"generated={rec.get('generated')} source={rec.get('usage_source')}")
            rl.finish("succeeded", summary=rec)
            return rec
        except Exception as e:  # noqa: BLE001
            db.rollback()
            log.exception("recommend failed run=%s", run_id)
            rl.log(f"추천 생성 실패: {str(e)[:300]}")
            rl.step("recommend", "failed", str(e)[:300])
            rl.finish("failed", error=str(e)[:300])
            return {"error": str(e)[:200]}
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_k8s_efficiency_run", time_limit=600)
def run_k8s_efficiency_run(self, run_id: str):
    """적용/롤백/쿼터 조정/CR 스케일 run 실행 — apply.execute_run + 감사 기록."""
    import logging
    from app.database import SessionLocal
    from app.models import Cluster
    from app.models.k8s_efficiency import K8sEfficiencyRun, K8sNamespacePolicy
    from app.services import audit_logger
    from app.services.k8s_efficiency.apply import execute_run

    log = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        run = db.query(K8sEfficiencyRun).filter(K8sEfficiencyRun.id == run_id).first()
        if run is None:
            return {"error": "run not found"}
        if run.run_state not in ("queued",):
            return {"error": f"run already {run.run_state}"}
        cluster = db.query(Cluster).filter(Cluster.id == run.cluster_id).first()
        run.celery_task_id = getattr(self.request, "id", None)
        db.commit()
        try:
            execute_run(db, run, cluster)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            log.exception("efficiency run failed run=%s", run_id)
            run.run_state = "failed"
            run.error = str(e)[:1000]
            db.commit()
        # CR 어댑터 적용 성공 시 정책의 current 값을 갱신(다음 자동화 판단 기준).
        if run.run_state in ("succeeded", "partial") and not run.dry_run:
            for i, t in enumerate(run.targets or []):
                if t.get("type") == "custom_resource" and str(i) in (run.after or {}):
                    idx = t.get("policy_target_index")
                    pol = (db.query(K8sNamespacePolicy)
                           .filter(K8sNamespacePolicy.cluster_id == run.cluster_id,
                                   K8sNamespacePolicy.namespace == t.get("namespace")).first())
                    if pol is not None and idx is not None and idx < len(pol.custom_targets or []):
                        ct = list(pol.custom_targets)
                        ct[idx] = {**ct[idx], "current": t.get("value")}
                        pol.custom_targets = ct
                        db.commit()
        audit_logger.record(db, action=f"k8s.efficiency.{run.run_type}.run",
                            actor_username=run.triggered_by or "automation",
                            status="success" if run.run_state == "succeeded" else "failure",
                            target_type="cluster", target_id=str(run.cluster_id),
                            details={"run_id": str(run.id), "trigger": run.trigger, "dry_run": run.dry_run,
                                     "summary": run.summary, "error": run.error})
        return {"run_id": str(run.id), "state": run.run_state, "summary": run.summary}
    finally:
        db.close()
