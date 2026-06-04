"""Batch job registration + execution.

Pattern (extending with new job types):
  1. Add a `BatchJobExecutor` subclass under `app/services/batch_jobs/`.
  2. Decorate it with `@register_executor`.
  3. Import it from `app/services/batch_jobs/__init__.py` so the registration
     side-effect runs.
That's it — `GET /api/v1/batch-jobs/types` will surface it and the existing
CRUD/run endpoints work unchanged.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import BatchJob, BatchJobRun, Cluster
from app.schemas.batch_job import (
    BatchJobCreate,
    BatchJobListResponse,
    BatchJobResponse,
    BatchJobRunListResponse,
    BatchJobRunRequest,
    BatchJobRunResponse,
    BatchJobTestConnectionRequest,
    BatchJobTestConnectionResponse,
    BatchJobTypeListResponse,
    BatchJobUpdate,
)
from app.services.batch_job_service import (
    BatchJobNotFound,
    UnknownJobType,
    execute_job,
    get_job_or_404,
)
from app.services.batch_jobs import get_executor, list_executors
from app.services.secret_box import decrypt as decrypt_secret
from app.services.secret_box import encrypt as encrypt_secret
from app.services.ssh_runner import SSHTarget, test_connection as ssh_test_connection

router = APIRouter(prefix="/batch-jobs", tags=["batch-jobs"])


def _require_cron_credentials(
    *,
    cron: str | None,
    has_password: bool,
    has_private_key: bool,
) -> None:
    """Raise 422 if a cron schedule is set but no credential will be persisted.

    Design Ref: §2.3.3 — shared invariant for create + update.
    Plan SC: SC-2 (POST 422) / SC-3 (PUT 422 after merge).

    Arguments reflect the *final* post-merge state — for PUT the caller
    must merge ``payload`` with the existing DB row first.
    """
    if not (cron and cron.strip()):
        return
    if has_password or has_private_key:
        return
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=(
            "cron 을 사용하려면 saved_password 또는 saved_private_key 중 "
            "하나가 필요합니다. 둘 다 비우면 스케줄러가 매분 silent skip 합니다."
        ),
    )


def _to_response(job: BatchJob) -> dict:
    """Serialise a BatchJob row into the response shape, hiding ciphertext
    behind boolean has_* flags."""
    return {
        "id": job.id,
        "cluster_id": job.cluster_id,
        "name": job.name,
        "description": job.description,
        "job_type": job.job_type,
        "default_host": job.default_host,
        "default_port": job.default_port or 22,
        "default_username": job.default_username or "root",
        "params": job.params,
        "cron": job.cron,
        "enabled": job.enabled if job.enabled is not None else True,
        "last_status": job.last_status or "unknown",
        "last_run_at": job.last_run_at,
        "last_schedule_check_at": job.last_schedule_check_at,
        "last_schedule_note": job.last_schedule_note,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "has_saved_password": bool(job.encrypted_password),
        "has_saved_private_key": bool(job.encrypted_private_key),
    }


# ── job type registry ────────────────────────────────────────────────────────

@router.get("/types", response_model=BatchJobTypeListResponse)
def list_job_types():
    """Registered batch job types — drives the 'New Job' UI."""
    return BatchJobTypeListResponse(data=list_executors())


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("", response_model=BatchJobListResponse)
def list_jobs(
    cluster_id: UUID | None = Query(default=None),
    job_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    q = db.query(BatchJob)
    if cluster_id:
        q = q.filter(BatchJob.cluster_id == cluster_id)
    if job_type:
        q = q.filter(BatchJob.job_type == job_type)
    jobs = q.order_by(BatchJob.created_at.desc()).all()
    return BatchJobListResponse(data=[_to_response(j) for j in jobs])


@router.post("", response_model=BatchJobResponse, status_code=status.HTTP_201_CREATED)
def create_job(payload: BatchJobCreate, db: Session = Depends(get_db)):
    if not db.query(Cluster).filter(Cluster.id == payload.cluster_id).first():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    if get_executor(payload.job_type) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown job_type '{payload.job_type}'. See GET /batch-jobs/types.",
        )

    # Block silent-skip case at registration (Plan SC-2).
    _require_cron_credentials(
        cron=payload.cron,
        has_password=bool(payload.saved_password),
        has_private_key=bool(payload.saved_private_key),
    )

    data = payload.model_dump()
    saved_password = data.pop("saved_password", None)
    saved_private_key = data.pop("saved_private_key", None)

    job = BatchJob(**data)
    if saved_password:
        job.encrypted_password = encrypt_secret(saved_password)
    if saved_private_key:
        job.encrypted_private_key = encrypt_secret(saved_private_key)
    db.add(job)
    db.commit()
    db.refresh(job)
    return _to_response(job)


@router.get("/{job_id}", response_model=BatchJobResponse)
def get_job(job_id: UUID, db: Session = Depends(get_db)):
    try:
        return _to_response(get_job_or_404(db, job_id))
    except BatchJobNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BatchJob not found")


@router.put("/{job_id}", response_model=BatchJobResponse)
def update_job(job_id: UUID, payload: BatchJobUpdate, db: Session = Depends(get_db)):
    try:
        job = get_job_or_404(db, job_id)
    except BatchJobNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BatchJob not found")

    update = payload.model_dump(exclude_unset=True)
    saved_password = update.pop("saved_password", None)
    saved_private_key = update.pop("saved_private_key", None)
    clear_password = update.pop("clear_saved_password", False)
    clear_private_key = update.pop("clear_saved_private_key", False)

    # Compute the final post-merge state and enforce the invariant before
    # mutating. ``saved_password=""`` is treated as "set to empty" → clears
    # the cipher, matching the assignment branch below.
    final_cron = update.get("cron", job.cron) if "cron" in update else job.cron
    if clear_password:
        final_has_pw = False
    elif saved_password is not None:
        final_has_pw = bool(saved_password)
    else:
        final_has_pw = bool(job.encrypted_password)
    if clear_private_key:
        final_has_key = False
    elif saved_private_key is not None:
        final_has_key = bool(saved_private_key)
    else:
        final_has_key = bool(job.encrypted_private_key)
    _require_cron_credentials(
        cron=final_cron,
        has_password=final_has_pw,
        has_private_key=final_has_key,
    )

    for field, value in update.items():
        setattr(job, field, value)

    if clear_password:
        job.encrypted_password = None
    elif saved_password is not None:
        job.encrypted_password = encrypt_secret(saved_password) if saved_password else None
    if clear_private_key:
        job.encrypted_private_key = None
    elif saved_private_key is not None:
        job.encrypted_private_key = encrypt_secret(saved_private_key) if saved_private_key else None

    db.commit()
    db.refresh(job)
    return _to_response(job)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job(job_id: UUID, db: Session = Depends(get_db)):
    try:
        job = get_job_or_404(db, job_id)
    except BatchJobNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BatchJob not found")
    # Cascade deletes BatchJobRun rows via the relationship's
    # `cascade="all, delete-orphan"`.
    db.delete(job)
    db.commit()
    return None


# ── execution + run history ──────────────────────────────────────────────────

@router.post("/{job_id}/run", response_model=BatchJobRunResponse)
async def run_job(job_id: UUID, payload: BatchJobRunRequest, db: Session = Depends(get_db)):
    try:
        job = get_job_or_404(db, job_id)
    except BatchJobNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BatchJob not found")

    # Either the request supplies credentials, or the job has saved ones.
    has_saved = bool(job.encrypted_password or job.encrypted_private_key)
    if not payload.password and not payload.private_key and not has_saved:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다 (또는 잡에 저장된 자격증명 등록).",
        )

    try:
        run, _ = await execute_job(
            db,
            job,
            host=payload.host,
            port=payload.port,
            username=payload.username,
            password=payload.password,
            private_key=payload.private_key,
            param_override=payload.param_override,
            timeout=payload.timeout,
            trigger="manual",
        )
    except UnknownJobType as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown job_type '{exc}'.",
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return run


@router.post("/{job_id}/test-connection", response_model=BatchJobTestConnectionResponse)
async def test_job_connection(
    job_id: UUID,
    payload: BatchJobTestConnectionRequest,
    db: Session = Depends(get_db),
):
    """SSH 자격증명/네트워크만 검증. 명령은 실행하지 않고 BatchJobRun 도 생성하지 않음.

    요청 자격증명이 비어있고 잡에 저장된 자격증명도 없으면 422. 저장된 자격증명을
    사용한 경우 응답의 used_saved_password / used_saved_private_key 로 표시한다 —
    UI 가 "저장된 자격증명으로 테스트됨" 라벨을 보여줄 수 있게.
    """
    import asyncio

    try:
        job = get_job_or_404(db, job_id)
    except BatchJobNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BatchJob not found")

    target_host = payload.host or job.default_host
    if not target_host:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="host 가 필요합니다 (잡에 default_host 가 설정되지 않음).",
        )

    password = payload.password
    private_key = payload.private_key
    used_saved_password = False
    used_saved_private_key = False

    if not password and not private_key:
        if job.encrypted_password:
            try:
                password = decrypt_secret(job.encrypted_password)
                used_saved_password = True
            except ValueError:
                pass
        if not password and job.encrypted_private_key:
            try:
                private_key = decrypt_secret(job.encrypted_private_key)
                used_saved_private_key = True
            except ValueError:
                pass

    if not password and not private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 가 필요합니다 (또는 잡에 저장된 자격증명 등록).",
        )

    port = payload.port or job.default_port or 22
    username = payload.username or job.default_username or "root"

    target = SSHTarget(
        host=target_host,
        port=port,
        username=username,
        password=password,
        private_key=private_key,
    )

    # paramiko 호출은 blocking 이므로 thread pool 에서 실행.
    result = await asyncio.get_event_loop().run_in_executor(
        None, ssh_test_connection, target, payload.timeout
    )

    return BatchJobTestConnectionResponse(
        status=result.status,
        latency_ms=result.duration_ms,
        host=target_host,
        port=port,
        username=username,
        used_saved_password=used_saved_password,
        used_saved_private_key=used_saved_private_key,
        error=result.error,
    )


@router.get("/{job_id}/runs", response_model=BatchJobRunListResponse)
def list_runs(
    job_id: UUID,
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    try:
        get_job_or_404(db, job_id)
    except BatchJobNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="BatchJob not found")

    runs = (
        db.query(BatchJobRun)
        .filter(BatchJobRun.job_id == job_id)
        .order_by(BatchJobRun.started_at.desc())
        .limit(limit)
        .all()
    )
    return BatchJobRunListResponse(data=runs)


@router.get("/runs/{run_id}", response_model=BatchJobRunResponse)
def get_run(run_id: UUID, db: Session = Depends(get_db)):
    run = db.query(BatchJobRun).filter(BatchJobRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    return run
