"""etcdctl defrag — example batch job.

Connects via SSH to a control-plane (master) node and runs:

    set -a && source <env_file> && set +a && etcdctl defrag [--cluster | --endpoints=...]

The env file (default `/etc/etcd.env`) is expected to provide ETCDCTL_API,
ETCDCTL_ENDPOINTS, ETCDCTL_CACERT, ETCDCTL_CERT, ETCDCTL_KEY so that TLS is
handled automatically.

Defrag acquires a write lock on each endpoint as it runs, so this is normally
scheduled outside business hours.
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
class EtcdctlDefragExecutor(BatchJobExecutor):
    job_type = "etcdctl_defrag"
    label = "etcdctl defrag"
    description = (
        "Compact and defragment the etcd database on every member of the cluster. "
        "Acquires a write lock per endpoint while running — schedule off-hours."
    )

    param_schema = {
        "env_file": {
            "type": "string",
            "label": "etcd env file",
            "default": "/etc/etcd.env",
            "help": "Sourced before running etcdctl. Should export ETCDCTL_* variables.",
        },
        "use_env": {
            "type": "bool",
            "label": "Source env file",
            "default": True,
        },
        "endpoints": {
            "type": "string",
            "label": "Endpoints override (optional)",
            "default": "",
            "help": "Comma-separated etcd endpoints. Empty → use --cluster (every member).",
        },
        "etcdctl_path": {
            "type": "string",
            "label": "etcdctl binary path",
            "default": "etcdctl",
        },
    }
    default_params = {
        "env_file": "/etc/etcd.env",
        "use_env": True,
        "endpoints": "",
        "etcdctl_path": "etcdctl",
    }

    def _build_command(self, params: dict) -> str:
        parts: list[str] = []
        env_file = params.get("env_file") or ""
        if params.get("use_env", True) and env_file:
            parts.append(f"set -a && source {shlex.quote(env_file)} && set +a")

        etcdctl = params.get("etcdctl_path") or "etcdctl"
        endpoints = (params.get("endpoints") or "").strip()
        if endpoints:
            parts.append(f"{shlex.quote(etcdctl)} --endpoints={shlex.quote(endpoints)} defrag")
        else:
            parts.append(f"{shlex.quote(etcdctl)} defrag --cluster")
        return " && ".join(parts)

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        params = self.merge_params(saved=None, override=ctx.params)
        bash_cmd = self._build_command(params)
        remote_cmd = f"bash -lc {shlex.quote(bash_cmd)}"

        target = SSHTarget(
            host=ctx.host,
            port=ctx.port,
            username=ctx.username,
            password=ctx.password,
            private_key=ctx.private_key,
        )

        start = time.monotonic()
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
            return ExecutionResult(
                status="error",
                error=str(exc)[:500],
                executed_command=bash_cmd,
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        r = results[0]
        # 강제 종료(중지)로 인한 실패는 일반 error 가 아니라 cancelled 로 보고한다.
        cancelled = bool(ctx.cancel_token and ctx.cancel_token.cancelled)
        return ExecutionResult(
            status="cancelled" if cancelled else r.status,
            exit_code=r.exit_code,
            stdout=r.stdout,
            stderr=r.stderr,
            duration_ms=r.duration_ms,
            error="사용자에 의해 중지됨" if cancelled else r.error,
            executed_command=bash_cmd,
        )
