"""Glue between BatchJob DB rows and registered executors."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import BatchJob, BatchJobRun
from app.services import active_runs
from app.services.batch_jobs import (
    CancelToken,
    ExecutionContext,
    ExecutionResult,
    get_executor,
)
from app.services.secret_box import decrypt as decrypt_secret

logger = logging.getLogger(__name__)


class BatchJobNotFound(Exception):
    pass


class UnknownJobType(Exception):
    pass


async def execute_job(
    db: Session,
    job: BatchJob,
    *,
    host: Optional[str] = None,
    port: Optional[int] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    private_key: Optional[str] = None,
    param_override: Optional[dict] = None,
    timeout: int = 60,
    trigger: str = "manual",
    triggered_by_user_id: Optional[str] = None,
    triggered_by_username: Optional[str] = None,
) -> tuple[BatchJobRun, ExecutionResult]:
    """Run a registered job and persist the result as a BatchJobRun row."""
    executor = get_executor(job.job_type)
    if executor is None:
        raise UnknownJobType(job.job_type)

    target_host = host or job.default_host
    if not executor.requires_ssh:
        # 클러스터 스코프 잡 — host/SSH 자격증명 없이 백엔드/워커에서 실행.
        # kubeconfig 는 클러스터 등록 정보에서 재구체화(파일 유실 대비).
        # 실패 시 **사유**(미등록/경로만 등록·워커 미공유/재생성 실패)를 executor 에
        # 전달해 "왜 안 되는지"가 실행 로그·단계 trace 에 그대로 남게 한다.
        from app.services.kubeconfig import resolve_kubeconfig

        kubeconfig_path: Optional[str] = None
        kubeconfig_note = ""
        cluster_name = ""
        if job.cluster is not None:
            cluster_name = job.cluster.name or ""
        try:
            kubeconfig_path, kubeconfig_note = resolve_kubeconfig(job.cluster)
        except Exception as exc:  # noqa: BLE001 — 실패 사유도 note 로 보존
            kubeconfig_path = None
            kubeconfig_note = f"kubeconfig 해석 중 오류: {str(exc)[:200]}"

        merged_params = executor.merge_params(saved=job.params, override=param_override)
        ctx = ExecutionContext(
            params=merged_params,
            timeout=timeout,
            kubeconfig_path=kubeconfig_path,
            cluster_name=cluster_name,
            kubeconfig_note=kubeconfig_note,
        )
        return await _run_and_record(
            db, job, executor, ctx, host=None, trigger=trigger,
            triggered_by_user_id=triggered_by_user_id,
            triggered_by_username=triggered_by_username,
        )

    if not target_host:
        # 스케줄 실행(trigger="schedule")에서 여기 도달하면 default_host 없이 cron 이
        # 걸린 레거시 잡이라는 뜻 — 라우터가 저장 시점에 이 조합을 막지만, 이미 잘못된
        # 상태로 저장된 잡이 있을 수 있다. last_run_at 을 갱신하지 않고 raise 만 하면
        # 디스패처 anchor 가 그대로 남아 매분 재큐잉하는 retry storm 이 되므로, 실패도
        # "실행 시도"로 기록해 최소 다음 cron 틱까지는 재시도를 미룬다.
        job.last_status = "error"
        job.last_run_at = datetime.utcnow()
        db.commit()
        raise ValueError("host is required (no default_host set on the job)")

    # Fall back to credentials saved on the job (used by scheduled runs).
    # Manual runs typically supply their own.
    if password is None and private_key is None:
        if job.encrypted_password:
            try:
                password = decrypt_secret(job.encrypted_password)
            except ValueError:
                logger.warning("BatchJob %s: failed to decrypt saved password", job.id)
        if private_key is None and job.encrypted_private_key:
            try:
                private_key = decrypt_secret(job.encrypted_private_key)
            except ValueError:
                logger.warning("BatchJob %s: failed to decrypt saved private key", job.id)

    merged_params = executor.merge_params(saved=job.params, override=param_override)
    ctx = ExecutionContext(
        host=target_host,
        port=port or job.default_port or 22,
        username=username or job.default_username or "root",
        password=password,
        private_key=private_key,
        params=merged_params,
        timeout=timeout,
    )
    return await _run_and_record(
        db, job, executor, ctx, host=target_host, trigger=trigger,
        triggered_by_user_id=triggered_by_user_id,
        triggered_by_username=triggered_by_username,
    )


async def _run_and_record(
    db: Session,
    job: BatchJob,
    executor,
    ctx: ExecutionContext,
    *,
    host: Optional[str],
    trigger: str,
    triggered_by_user_id: Optional[str] = None,
    triggered_by_username: Optional[str] = None,
) -> tuple[BatchJobRun, ExecutionResult]:
    """Run the executor and persist the outcome as a BatchJobRun row.

    The run row is created *before* the executor starts (status="running")
    so a concurrent ``POST /{id}/stop`` always has something to point at —
    without this, a job stuck mid-execution had no queryable row at all
    until it finished, which is exactly when you'd want to interrupt it.

    A `CancelToken` is attached to the context and registered in the
    in-process `active_runs` registry (manual/synchronous runs only — see
    that module's docstring for why scheduled/bulk runs use Celery revoke
    instead) so a stop request landing on this same process can actually
    interrupt the blocking SSH/subprocess call the executor is holding.
    """
    job_id_str = str(job.id)
    started_at = datetime.utcnow()

    run = BatchJobRun(
        job_id=job.id,
        status="running",
        trigger=trigger,
        triggered_by_user_id=triggered_by_user_id,
        triggered_by_username=triggered_by_username,
        host=host,
        # admin 이 "이 실행이 정확히 어떤 설정으로 이뤄졌는지"(예: k8s_job_cleanup
        # 의 dry_run) 나중에도 확인할 수 있도록 merge 후 파라미터를 그대로 남긴다.
        params_snapshot=ctx.params or None,
        duration_ms=0,
        started_at=started_at,
    )
    db.add(run)
    job.last_status = "running"
    db.commit()
    db.refresh(run)

    token = CancelToken()
    ctx.cancel_token = token
    active_runs.register(job_id_str, token)
    try:
        try:
            result = await executor.run(ctx)
        except Exception as exc:
            result = ExecutionResult(status="error", error=str(exc)[:500])
    finally:
        active_runs.unregister(job_id_str, token)

    # 예외로 result 를 직접 만들었어도 executor 인스턴스(실행마다 새로 생성)에
    # 쌓인 부분 trace 는 살아있다 — 실패 경로일수록 "어디까지 갔는지"가 중요하므로
    # 여기서 회수해 항상 영속한다.
    if not result.steps:
        result.steps = executor._collected_steps()
    if not result.commands:
        result.commands = executor._collected_commands()

    finished_at = datetime.utcnow()
    # 실행기가 cancel 을 직접 반영 못했더라도(강제 종료로 예외만 남긴 경우) 여기서
    # 최종적으로 "cancelled" 로 정정 — DB 상태는 항상 정확해야 한다.
    final_status = "cancelled" if token.cancelled else result.status

    run.status = final_status
    run.executed_command = (result.executed_command or "")[:2000]
    run.exit_code = result.exit_code
    run.stdout = result.stdout or ""
    run.stderr = result.stderr or ""
    run.error = (result.error or None) and result.error[:1000]
    if token.cancelled and not run.error:
        run.error = "사용자에 의해 중지됨"
    run.steps = result.steps or None
    run.commands = result.commands or None
    run.duration_ms = result.duration_ms
    run.finished_at = finished_at

    job.last_status = final_status
    job.last_run_at = finished_at
    job.active_task_id = None
    db.commit()
    db.refresh(run)

    return run, result


def get_job_or_404(db: Session, job_id: UUID) -> BatchJob:
    job = db.query(BatchJob).filter(BatchJob.id == job_id).first()
    if not job:
        raise BatchJobNotFound(str(job_id))
    return job
