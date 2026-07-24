"""DB-free unit test for BatchJobRun 실행 추적성(admin 상세 제어) 필드.

_run_and_record() 가 triggered_by_user_id/triggered_by_username(실행자)과
params_snapshot(그 실행에 실제로 사용된 merge 후 파라미터 — 예: k8s_job_cleanup
의 dry_run 여부)을 BatchJobRun 에 그대로 남기는지 확인한다. 실제 Postgres 세션
없이 MagicMock 으로 db.add/commit/refresh 를 흡수해 순수 동작만 검증한다.
"""
from unittest.mock import MagicMock

import pytest

from app.models import BatchJob
from app.services.batch_job_service import _run_and_record
from app.services.batch_jobs.base import BatchJobExecutor, ExecutionContext, ExecutionResult


class _StubExecutor(BatchJobExecutor):
    """등록되지 않은(테스트 전용) 스텁 — 전역 executor 레지스트리를 건드리지 않는다."""

    job_type = "stub_test_only"
    label = "stub"

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        return ExecutionResult(status="ok", stdout="done", executed_command="echo hi")


@pytest.mark.asyncio
async def test_run_and_record_persists_triggered_by_and_params_snapshot():
    db = MagicMock()
    job = BatchJob(name="t", job_type="stub_test_only")
    ctx = ExecutionContext(params={"dry_run": True, "foo": "bar"}, timeout=30)

    run, result = await _run_and_record(
        db, job, _StubExecutor(), ctx, host=None, trigger="manual",
        triggered_by_user_id="uid-1", triggered_by_username="alice",
    )

    assert result.status == "ok"
    assert run.trigger == "manual"
    assert run.triggered_by_user_id == "uid-1"
    assert run.triggered_by_username == "alice"
    assert run.params_snapshot == {"dry_run": True, "foo": "bar"}


@pytest.mark.asyncio
async def test_run_and_record_defaults_triggered_by_to_none_for_schedule():
    """스케줄(Beat) 실행은 사람이 아니므로 triggered_by_* 가 항상 None 이어야 한다."""
    db = MagicMock()
    job = BatchJob(name="t", job_type="stub_test_only")
    ctx = ExecutionContext(params={"dry_run": False}, timeout=30)

    run, _ = await _run_and_record(db, job, _StubExecutor(), ctx, host=None, trigger="schedule")

    assert run.trigger == "schedule"
    assert run.triggered_by_user_id is None
    assert run.triggered_by_username is None
    assert run.params_snapshot == {"dry_run": False}
