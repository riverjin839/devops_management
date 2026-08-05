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


class _SteppedExecutor(BatchJobExecutor):
    """_step/_record_command 를 실제로 사용하는 스텁 — trace 영속 검증용."""

    job_type = "stub_stepped_test_only"
    label = "stub"

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        import time as _t
        with self._step("phase_a", "준비"):
            pass
        with self._step("phase_b", "실행") as st:
            self._record_command("echo hi", _t.time(), kind="ssh", exit_code=0, stdout="hi", stderr="")
            st.detail = "done"
        return ExecutionResult(status="ok", stdout="done")


class _ExplodingExecutor(BatchJobExecutor):
    """스텝 기록 도중 예외 — 예외 경로에서도 부분 trace 가 영속되는지 검증용."""

    job_type = "stub_exploding_test_only"
    label = "stub"

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        with self._step("phase_a", "준비"):
            pass
        with self._step("phase_b", "실행"):
            raise RuntimeError("boom mid-flight")


@pytest.mark.asyncio
async def test_run_and_record_persists_steps_and_commands():
    db = MagicMock()
    job = BatchJob(name="t", job_type="stub_stepped_test_only")
    ctx = ExecutionContext(params={}, timeout=30)

    run, result = await _run_and_record(db, job, _SteppedExecutor(), ctx, host=None, trigger="manual")

    assert result.status == "ok"
    assert [s["id"] for s in run.steps] == ["phase_a", "phase_b"]
    assert run.steps[1]["status"] == "success"
    assert run.commands and run.commands[0]["command"] == "echo hi"
    assert run.commands[0]["kind"] == "ssh"


@pytest.mark.asyncio
async def test_run_and_record_backfills_partial_steps_on_exception():
    """executor 가 도중에 죽어도 '어디까지 갔는지'(부분 trace)는 반드시 남는다."""
    db = MagicMock()
    job = BatchJob(name="t", job_type="stub_exploding_test_only")
    ctx = ExecutionContext(params={}, timeout=30)

    run, result = await _run_and_record(db, job, _ExplodingExecutor(), ctx, host=None, trigger="manual")

    assert run.status == "error"
    assert "boom mid-flight" in (run.error or "")
    step_map = {s["id"]: s for s in run.steps}
    assert step_map["phase_a"]["status"] == "success"
    assert step_map["phase_b"]["status"] == "failed"
    assert "boom" in step_map["phase_b"]["detail"]
