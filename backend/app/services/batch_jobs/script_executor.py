"""Executes a BatchJob whose behavior comes from the script library
(``execution_mode="script"``) instead of a hardcoded executor class.

One executor handles every script-backed job — ``batch_job_service.execute_job()``
loads the actual ``ExecutableScript``/``ExecutableScriptVersion`` row and injects
its content into ``ExecutionContext`` before calling ``run()`` (this module never
touches the DB directly, matching the rest of the ``batch_jobs`` package).

kind 별 분기 (설계 문서 §4.3과 동일 — services/script_test_run.py 의 "테스트 실행"과
같은 로직을 실제 예약/추적 실행 경로에 이식):
  - shell            → SSH 로 원격 실행 (``ssh_runner`` 재사용, ``shell_command.py`` 와 동일 패턴)
  - ansible_playbook → ``playbook_executor.run_playbook`` 재사용
  - python           → 아직 미지원. 대상 클러스터의 일회용 K8s Job 실행기는 Phase 2 의
                        나머지 구간으로 남아있다(§4.4) — 지금은 명확한 에러로 실패시킨다.
"""
from __future__ import annotations

import asyncio
import shlex
import time
from typing import Any

from app.services.batch_jobs.base import (
    BatchJobExecutor,
    ExecutionContext,
    ExecutionResult,
    register_executor,
)
from app.services.playbook_executor import run_playbook
from app.services.ssh_runner import SSHTarget, run_bulk


@register_executor
class ScriptExecutor(BatchJobExecutor):
    job_type = "script"
    label = "스크립트 라이브러리"
    description = (
        "스크립트 라이브러리(/scripts)에 저장된 Shell/Ansible Playbook 스크립트를 실행합니다. "
        "실제 내용은 이 Batch Job 이 가리키는 스크립트 버전에서 로드됩니다 — "
        "새 job 을 만들 때는 UI 의 '스크립트 선택'에서 고릅니다."
    )
    step_plan = [
        {"id": "load_script", "label": "스크립트 로드"},
        {"id": "execute", "label": "실행"},
    ]

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        with self._step("load_script", "스크립트 로드") as st:
            kind = ctx.script_kind
            content = ctx.script_content
            if not kind or content is None:
                st.status = "failed"
                st.detail = "스크립트 내용을 불러오지 못했습니다 — 스크립트가 삭제되었을 수 있습니다."
                return ExecutionResult(
                    status="error",
                    error="스크립트 내용을 불러오지 못했습니다 — 스크립트가 삭제되었을 수 있습니다.",
                    steps=self._collected_steps(), commands=self._collected_commands(),
                )
            st.detail = f"kind={kind}"

        if kind == "shell":
            return await self._run_shell(ctx, content)
        if kind == "ansible_playbook":
            return await self._run_ansible(ctx, content)

        with self._step("execute", "실행") as st:
            st.status = "failed"
            st.detail = "Python 스크립트 실행은 아직 지원하지 않습니다."
        return ExecutionResult(
            status="error",
            error=(
                "Python 스크립트 실행은 아직 지원하지 않습니다 — 대상 클러스터의 일회용 "
                "K8s Job 실행기가 Phase 2 에 구현될 예정입니다(설계 문서 §4.4)."
            ),
            steps=self._collected_steps(), commands=self._collected_commands(),
        )

    async def _run_shell(self, ctx: ExecutionContext, content: str) -> ExecutionResult:
        command = f"bash -lc {shlex.quote(content)}"
        target = SSHTarget(
            host=ctx.host, port=ctx.port, username=ctx.username,
            password=ctx.password, private_key=ctx.private_key,
        )
        start = time.monotonic()
        with self._step("execute", "SSH 접속·실행") as st:
            t0 = time.time()
            try:
                results = await run_bulk(
                    [target], action="ssh", command=command, mode="sequential",
                    connect_timeout=min(ctx.timeout, 10), exec_timeout=ctx.timeout,
                    parallelism=1, cancel_token=ctx.cancel_token,
                )
            except Exception as exc:
                self._record_command(command, t0, kind="ssh", exit_code=None, stdout="", stderr=str(exc)[:500])
                st.status = "failed"
                st.detail = str(exc)[:200]
                return ExecutionResult(
                    status="error", error=str(exc)[:500], executed_command=command,
                    duration_ms=int((time.monotonic() - start) * 1000),
                    steps=self._collected_steps(), commands=self._collected_commands(),
                )
            r = results[0]
            self._record_command(
                command, t0, kind="ssh",
                exit_code=r.exit_code, stdout=r.stdout or "", stderr=r.stderr or "",
            )
            st.detail = f"{ctx.username}@{ctx.host} — {r.status}" + (
                f" (exit {r.exit_code})" if r.exit_code is not None else ""
            )
            if r.status != "ok":
                st.status = "failed"
                st.detail = (r.error or st.detail)[:200]

        cancelled = bool(ctx.cancel_token and ctx.cancel_token.cancelled)
        return ExecutionResult(
            status="cancelled" if cancelled else r.status,
            exit_code=r.exit_code, stdout=r.stdout, stderr=r.stderr, duration_ms=r.duration_ms,
            error="사용자에 의해 중지됨" if cancelled else r.error,
            executed_command=command,
            steps=self._collected_steps(), commands=self._collected_commands(),
        )

    async def _run_ansible(self, ctx: ExecutionContext, content: str) -> ExecutionResult:
        extra_vars: dict[str, Any] = dict(ctx.params or {})
        inventory_content = ctx.script_inventory_content
        inventory_hosts = None
        if not inventory_content:
            inventory_hosts = [ctx.host] if ctx.host else None
            extra_vars.setdefault("ansible_user", ctx.username)
            if ctx.password:
                extra_vars.setdefault("ansible_ssh_pass", ctx.password)

        start = time.monotonic()
        with self._step("execute", "ansible-playbook 실행") as st:
            t0 = time.time()
            # ansible-runner 는 blocking subprocess — 이벤트 루프를 막지 않게 스레드로.
            # (참고: run_playbook 내부 subprocess 는 cancel_token 에 attach 되지 않아
            # "중지"가 이 단계는 인터럽트하지 못한다 — playbook_executor 의 기존 한계.)
            result = await asyncio.to_thread(
                run_playbook,
                playbook_content=content,
                inventory_content=inventory_content,
                inventory_hosts=inventory_hosts,
                extra_vars=extra_vars,
                ssh_private_key=ctx.private_key,
                timeout=ctx.timeout,
            )
            ok = result.status == "healthy"
            self._record_command(
                "ansible-playbook (임시 파일에서 실행)", t0, kind="ansible",
                exit_code=0 if ok else 1, stdout=result.raw_output, stderr="",
            )
            st.detail = result.message[:200]
            if not ok:
                st.status = "failed"

        cancelled = bool(ctx.cancel_token and ctx.cancel_token.cancelled)
        return ExecutionResult(
            status="cancelled" if cancelled else ("ok" if ok else "error"),
            exit_code=0 if ok else 1, stdout=result.raw_output, stderr="",
            duration_ms=int((time.monotonic() - start) * 1000),
            error=None if ok else result.message,
            steps=self._collected_steps(), commands=self._collected_commands(),
        )
