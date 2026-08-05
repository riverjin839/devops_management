"""DB-free unit tests for the "실행 중지(stop)" feature.

Covers the two units that make cancellation actually work:
  - `CancelToken` (base.py) — attach/cancel semantics, including the race
    where cancel() fires before a handle is attached.
  - `active_runs` registry — register/try_cancel/unregister, including the
    "don't clobber a newer run for the same job" guard.
  - `_run_and_record` — the DB-correctness half: even if the executor
    doesn't report "cancelled" itself, a cancelled token always wins.
"""
from unittest.mock import MagicMock

import pytest

from app.models import BatchJob
from app.services import active_runs
from app.services.batch_job_service import _run_and_record
from app.services.batch_jobs.base import BatchJobExecutor, CancelToken, ExecutionContext, ExecutionResult


class TestCancelToken:
    def test_cancel_closes_attached_handle(self):
        token = CancelToken()
        handle = MagicMock(spec=["close"])
        token.attach(handle)
        token.cancel()
        handle.close.assert_called_once()
        assert token.cancelled is True

    def test_cancel_prefers_terminate_over_close(self):
        """subprocess.Popen 처럼 둘 다 있으면 terminate() 를 우선 사용."""
        token = CancelToken()
        handle = MagicMock(spec=["close", "terminate"])
        token.attach(handle)
        token.cancel()
        handle.terminate.assert_called_once()
        handle.close.assert_not_called()

    def test_attach_after_cancel_closes_immediately(self):
        """cancel() 이 먼저 호출된 뒤 뒤늦게 attach 된 핸들도 즉시 정리돼야 한다
        (executor 가 cancel_token 을 확인하기 전에 새 handle 을 여는 레이스)."""
        token = CancelToken()
        token.cancel()
        late_handle = MagicMock(spec=["close"])
        token.attach(late_handle)
        late_handle.close.assert_called_once()

    def test_cancel_swallows_handle_errors(self):
        """close()/terminate() 가 예외를 던져도 cancel() 자체는 죽지 않는다."""
        token = CancelToken()
        bad_handle = MagicMock(spec=["close"])
        bad_handle.close.side_effect = RuntimeError("already dead")
        token.attach(bad_handle)
        token.cancel()  # should not raise
        assert token.cancelled is True


class TestActiveRunsRegistry:
    def test_try_cancel_missing_job_returns_false(self):
        assert active_runs.try_cancel("no-such-job") is False

    def test_register_then_try_cancel_invokes_token(self):
        token = CancelToken()
        active_runs.register("job-a", token)
        try:
            assert active_runs.try_cancel("job-a") is True
            assert token.cancelled is True
        finally:
            active_runs.unregister("job-a", token)

    def test_unregister_does_not_clobber_newer_token(self):
        """job-b 의 이전 실행이 끝나며 unregister 하는 시점에 이미 같은 job 의
        새 실행이 등록돼 있으면, 새 토큰을 지우면 안 된다."""
        old_token = CancelToken()
        new_token = CancelToken()
        active_runs.register("job-b", old_token)
        active_runs.register("job-b", new_token)  # 새 실행이 덮어씀
        active_runs.unregister("job-b", old_token)  # 낡은 참조로 해제 시도
        try:
            # new_token 이 여전히 살아있어야 한다.
            assert active_runs.try_cancel("job-b") is True
            assert new_token.cancelled is True
            assert old_token.cancelled is False
        finally:
            active_runs.unregister("job-b", new_token)


class _ImmediateOkExecutor(BatchJobExecutor):
    job_type = "stub_stop_test"
    label = "stub"

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        # 실행 도중 밖에서 cancel_token.cancel() 이 걸렸다고 가정 — 이 스텁은
        # 그걸 반영하지 않고 그냥 "ok" 를 리턴한다(비협조적인 executor 시나리오).
        return ExecutionResult(status="ok", stdout="finished anyway")


@pytest.mark.asyncio
async def test_run_and_record_overrides_status_when_token_cancelled():
    """executor 가 cancel 을 반영 못하고 ok 를 리턴해도, cancel_token 이 이미
    cancelled 라면 최종 DB 상태는 반드시 'cancelled' 여야 한다 (정합성 보장).

    `_run_and_record` 가 CancelToken 을 만들어 `ctx.cancel_token` 에 심어주는
    시점은 executor.run() 호출 *직전* 이므로, "실행 도중 밖에서 stop 요청이
    걸렸다"는 상황은 executor 자신이 실행 중 ctx.cancel_token.cancel() 을
    호출하는 것으로 흉내낸다 — 실제로는 다른 코루틴(POST /stop 핸들러)이
    `active_runs.try_cancel()` 을 통해 같은 토큰의 cancel() 을 호출한다.
    """
    db = MagicMock()
    job = BatchJob(name="t", job_type="stub_stop_test")
    ctx = ExecutionContext(params={}, timeout=30)

    executor = _ImmediateOkExecutor()
    orig_run = executor.run

    async def run_and_cancel(c):
        assert c.cancel_token is not None  # _run_and_record 가 심어줬어야 함
        c.cancel_token.cancel()
        return await orig_run(c)

    executor.run = run_and_cancel  # type: ignore[method-assign]

    run, result = await _run_and_record(db, job, executor, ctx, host=None, trigger="manual")

    assert result.status == "ok"  # executor 자체는 여전히 ok 를 리턴
    assert run.status == "cancelled"  # 그러나 최종 기록은 cancelled 로 정정됨
    assert run.error == "사용자에 의해 중지됨"
