"""Generic shell command batch job.

Runs an arbitrary bash command via SSH on a single host. This is the
"escape hatch" type — when an operator wants to schedule something that
isn't worth a dedicated executor (rotating a log file, restarting a
systemd unit, running a one-off script), they can register a
`shell_command` job with the desired command in `params.command`.

The command is executed with `bash -lc`, so login shell init files
(``/etc/profile``, ``~/.bashrc``) are sourced and the operator's $PATH
applies just like a real interactive session.
"""
from __future__ import annotations

import shlex
import time

from app.services.batch_jobs.base import (
    BatchJobExecutor,
    ExecutionContext,
    ExecutionResult,
    register_executor,
)
from app.services.ssh_runner import SSHTarget, run_bulk


@register_executor
class ShellCommandExecutor(BatchJobExecutor):
    job_type = "shell_command"
    label = "Shell Command"
    description = (
        "Run an arbitrary bash command on a target host over SSH. "
        "Use for ad-hoc operational scripts that don't warrant a dedicated executor."
    )

    param_schema = {
        "command": {
            "type": "string",
            "label": "Command",
            "default": "",
            "help": "Shell command to execute. Wrapped in `bash -lc` on the remote host.",
        },
        "working_dir": {
            "type": "string",
            "label": "Working directory (optional)",
            "default": "",
            "help": "If set, `cd <dir>` is run before the command.",
        },
    }
    default_params = {
        "command": "",
        "working_dir": "",
    }
    step_plan = [
        {"id": "build_command", "label": "명령 조립"},
        {"id": "ssh_exec", "label": "SSH 접속·실행"},
        {"id": "parse_result", "label": "결과 정리"},
    ]

    def _build_command(self, params: dict) -> str:
        command = (params.get("command") or "").strip()
        if not command:
            raise ValueError("params.command 가 비어있습니다 — 실행할 명령을 지정해주세요.")
        working_dir = (params.get("working_dir") or "").strip()
        if working_dir:
            return f"cd {shlex.quote(working_dir)} && {command}"
        return command

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        params = self.merge_params(saved=None, override=ctx.params)

        with self._step("build_command", "명령 조립") as st:
            try:
                bash_cmd = self._build_command(params)
            except ValueError as exc:
                st.status = "failed"
                st.detail = str(exc)[:200]
                return ExecutionResult(
                    status="error", error=str(exc),
                    steps=self._collected_steps(), commands=self._collected_commands(),
                )
            st.detail = bash_cmd[:200]

        remote_cmd = f"bash -lc {shlex.quote(bash_cmd)}"

        target = SSHTarget(
            host=ctx.host,
            port=ctx.port,
            username=ctx.username,
            password=ctx.password,
            private_key=ctx.private_key,
        )

        start = time.monotonic()
        with self._step("ssh_exec", "SSH 접속·실행") as st:
            t0 = time.time()  # _record_command 는 wall-clock 기준
            try:
                results = await run_bulk(
                    [target],
                    action="ssh",
                    command=remote_cmd,
                    mode="sequential",
                    connect_timeout=min(ctx.timeout, 10),
                    exec_timeout=ctx.timeout,
                    parallelism=1,
                    cancel_token=ctx.cancel_token,
                )
            except Exception as exc:
                self._record_command(
                    bash_cmd, t0, kind="ssh",
                    exit_code=None, stdout="", stderr=str(exc)[:500],
                )
                st.status = "failed"
                st.detail = str(exc)[:200]
                return ExecutionResult(
                    status="error",
                    error=str(exc)[:500],
                    executed_command=bash_cmd,
                    duration_ms=int((time.monotonic() - start) * 1000),
                    steps=self._collected_steps(), commands=self._collected_commands(),
                )
            r = results[0]
            self._record_command(
                bash_cmd, t0, kind="ssh",
                exit_code=r.exit_code, stdout=r.stdout or "", stderr=r.stderr or "",
            )
            st.detail = f"{ctx.username}@{ctx.host} — {r.status}" + (
                f" (exit {r.exit_code})" if r.exit_code is not None else ""
            )
            if r.status != "ok":
                st.status = "failed"
                st.detail = (r.error or st.detail)[:200]

        # 강제 종료(중지)로 인한 실패는 일반 error 가 아니라 cancelled 로 보고한다.
        cancelled = bool(ctx.cancel_token and ctx.cancel_token.cancelled)
        with self._step("parse_result", "결과 정리") as st:
            if cancelled:
                st.status = "skipped"
                st.detail = "중지됨"
            else:
                st.detail = f"stdout {len(r.stdout or '')}자 / stderr {len(r.stderr or '')}자"
        return ExecutionResult(
            status="cancelled" if cancelled else r.status,
            exit_code=r.exit_code,
            stdout=r.stdout,
            stderr=r.stderr,
            duration_ms=r.duration_ms,
            error="사용자에 의해 중지됨" if cancelled else r.error,
            executed_command=bash_cmd,
            steps=self._collected_steps(),
            commands=self._collected_commands(),
        )
