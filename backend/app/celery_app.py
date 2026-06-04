"""
Celery 앱 설정 및 스케줄 태스크
- 일일 3회 (아침/점심/저녁) 자동 헬스 체크
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

# Beat 스케줄 설정 (일일 3회 체크)
celery_app.conf.beat_schedule = {
    # 아침 체크 (09:00 KST)
    "daily-check-morning": {
        "task": "app.celery_app.run_scheduled_check",
        "schedule": crontab(hour=9, minute=0),
        "args": ("morning",),
    },
    # 점심 체크 (13:00 KST)
    "daily-check-noon": {
        "task": "app.celery_app.run_scheduled_check",
        "schedule": crontab(hour=13, minute=0),
        "args": ("noon",),
    },
    # 저녁 체크 (18:00 KST)
    "daily-check-evening": {
        "task": "app.celery_app.run_scheduled_check",
        "schedule": crontab(hour=18, minute=0),
        "args": ("evening",),
    },
    # 기술 트렌드 수집 (07:00 KST)
    "daily-trend-collect": {
        "task": "app.celery_app.run_trend_collect",
        "schedule": crontab(hour=7, minute=0),
    },
    # BatchJob.cron 디스패처 — 매 분마다 등록된 잡들을 스캔하고
    # cron 표현식이 매치하는 잡을 run_batch_job 으로 큐잉.
    "batch-job-dispatcher": {
        "task": "app.celery_app.run_batch_job_dispatcher",
        "schedule": crontab(minute="*"),
    },
    # Deep check — daily check 15분 뒤. Super Pod (centralized) 모드용.
    "daily-deep-check-morning": {
        "task": "app.celery_app.run_deep_check_all",
        "schedule": crontab(hour=9, minute=15),
        "args": ("morning",),
    },
    "daily-deep-check-noon": {
        "task": "app.celery_app.run_deep_check_all",
        "schedule": crontab(hour=13, minute=15),
        "args": ("noon",),
    },
    "daily-deep-check-evening": {
        "task": "app.celery_app.run_deep_check_all",
        "schedule": crontab(hour=18, minute=15),
        "args": ("evening",),
    },
}


@celery_app.task(bind=True, name="app.celery_app.run_scheduled_check")
def run_scheduled_check(self, schedule_type: str):
    """
    스케줄된 일일 체크 디스패처. 모든 활성 클러스터에 대해
    `run_scheduled_single_check.delay(cluster_id, schedule_type)` 으로 fanout.

    이전 구조 (직렬 for-loop) 는 클러스터 N개 × 평균 30초 → 5분 task_time_limit 초과 시
    부분 결과만 commit 되고 나머지 클러스터는 회차 누락 (Plan SC-1 위반). 디스패처는
    DB 조회 + queue 만 하므로 즉시 종료, 실제 체크는 worker concurrency 만큼 병렬 처리.
    """
    from app.database import SessionLocal
    from app.models import Cluster, CheckSchedule

    db = SessionLocal()
    queued: list[dict] = []
    skipped: list[dict] = []

    try:
        clusters = db.query(Cluster).all()

        for cluster in clusters:
            schedule = db.query(CheckSchedule).filter(
                CheckSchedule.cluster_id == cluster.id,
                CheckSchedule.is_active == True  # noqa: E712
            ).first()

            # 스케줄이 명시적으로 비활성화돼 있으면 skip
            if schedule:
                enabled_attr = f"{schedule_type}_enabled"
                if hasattr(schedule, enabled_attr) and not getattr(schedule, enabled_attr):
                    skipped.append({"cluster": cluster.name, "reason": f"{schedule_type} disabled"})
                    continue

            # Fanout — 각 클러스터 체크는 별도 task 로 큐잉. worker concurrency 만큼 병렬.
            try:
                run_scheduled_single_check.delay(str(cluster.id), schedule_type)
                queued.append({"cluster": cluster.name})
            except Exception as e:
                # broker 자체 실패 — 어떤 클러스터도 큐잉 안 됨. 운영자가 알아채야 함.
                import logging
                logging.getLogger(__name__).exception(
                    "Failed to queue daily check for cluster %s: %s", cluster.name, e
                )
                skipped.append({"cluster": cluster.name, "reason": f"queue error: {str(e)[:120]}"})

        return {
            "schedule_type": schedule_type,
            "executed_at": datetime.now().isoformat(),
            "queued": len(queued),
            "skipped": len(skipped),
            "queued_clusters": queued,
            "skipped_clusters": skipped,
        }

    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_scheduled_single_check")
def run_scheduled_single_check(self, cluster_id: str, schedule_type: str):
    """단일 클러스터 단일 회차 체크 — Beat 디스패처가 큐잉.

    `run_single_check` (수동 트리거용) 과 분리한 이유: 수동은 항상 schedule_type=manual 이고,
    스케줄은 morning/noon/evening 중 하나. 통계/로그 구분을 위해 별도 task name 사용.
    """
    from app.database import SessionLocal
    from app.models import CheckScheduleType
    from app.services.daily_checker import DailyChecker

    db = SessionLocal()
    try:
        schedule_enum = CheckScheduleType(schedule_type)
        checker = DailyChecker(db)
        result = asyncio.run(
            checker.run_daily_check(cluster_id, schedule_enum)
        )
        return {
            "cluster_id": cluster_id,
            "schedule_type": schedule_type,
            "status": result.overall_status.value,
            "checked_at": result.checked_at.isoformat(),
        }
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception(
            "Scheduled check failed for cluster %s (%s): %s",
            cluster_id, schedule_type, e,
        )
        return {
            "cluster_id": cluster_id,
            "schedule_type": schedule_type,
            "error": str(e)[:200],
        }
    finally:
        db.close()


@celery_app.task(bind=True, name="app.celery_app.run_trend_collect")
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
def run_batch_job(self, job_id: str, *, password: str | None = None, private_key: str | None = None):
    """Execute a registered batch job by id.

    Used for scheduled runs (Celery Beat) and ad-hoc background triggers.
    If `password`/`private_key` are not supplied, `execute_job` falls
    back to the encrypted credentials saved on the BatchJob row.
    """
    from uuid import UUID
    from app.database import SessionLocal
    from app.services.batch_job_service import execute_job, get_job_or_404

    db = SessionLocal()
    try:
        job = get_job_or_404(db, UUID(job_id))
        if not job.enabled:
            return {"job_id": job_id, "skipped": True, "reason": "disabled"}

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            run, result = loop.run_until_complete(
                execute_job(
                    db,
                    job,
                    password=password,
                    private_key=private_key,
                    trigger="schedule",
                )
            )
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


@celery_app.task(bind=True, name="app.celery_app.run_batch_job_dispatcher")
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
            if not croniter.is_valid(cron_expr):
                skipped_reasons["invalid_cron"] = skipped_reasons.get("invalid_cron", 0) + 1
                note = "cron 표현식 오류"
            elif not (job.encrypted_password or job.encrypted_private_key):
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
                        run_batch_job.delay(str(job.id))
                        dispatched.append(str(job.id))
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


@celery_app.task(bind=True, name="app.celery_app.run_review_and_notify")
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


@celery_app.task(bind=True, name="app.celery_app.run_deep_check_all")
def run_deep_check_all(self, schedule_type: str = "manual"):
    """모든 클러스터에 대해 deep check 를 centralized 모드로 실행.

    각 클러스터의 가장 최근 DailyCheckLog 에 결과를 묶어 저장한다.
    """
    from app.database import SessionLocal
    from app.models import Cluster
    from app.services.deep_check_service import DeepCheckService

    import logging
    _log = logging.getLogger(__name__)

    db = SessionLocal()
    try:
        svc = DeepCheckService(db)
        clusters = db.query(Cluster).all()
        results = []
        for cluster in clusters:
            linked_log_id = None
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    n, linked_log_id = loop.run_until_complete(
                        svc.run_for_cluster(str(cluster.id))
                    )
                finally:
                    loop.close()
                results.append({"cluster": cluster.name, "checks_run": n, "log_id": linked_log_id})
            except Exception as e:
                results.append({"cluster": cluster.name, "error": str(e)})

            # AI 리뷰 생성 + 알림 발송 — best-effort, 이벤트 루프 닫힌 뒤 실행
            if linked_log_id:
                try:
                    run_review_and_notify.delay(linked_log_id)
                except Exception:
                    _log.warning("Failed to queue review/notify for log %s", linked_log_id)

        return {
            "schedule_type": schedule_type,
            "executed_at": datetime.now().isoformat(),
            "results": results,
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
