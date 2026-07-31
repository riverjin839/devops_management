"""Base classes and registry for batch job executors."""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, ClassVar, Optional


class CancelToken:
    """Cooperative, cross-thread cancellation handle for a single run.

    Executors attach whatever OS-level handle they hold while running (a
    connected ``paramiko.SSHClient``, a ``subprocess.Popen``) via
    :meth:`attach`. Calling :meth:`cancel` — from a *different* thread/coroutine
    than the one executing the job, e.g. the ``POST /{id}/stop`` request
    handler — closes/terminates every attached handle, which unblocks the
    executor's blocking call (closing an SSH transport mid-read makes the
    blocked ``channel.recv()`` raise; ``Popen.terminate()`` ends
    ``communicate()``). The remote SSH command itself also dies: sshd sends
    SIGHUP to the session's foreground process group when its channel closes
    (true unless the remote command detached itself via nohup/setsid, which
    none of our executors do).
    """

    def __init__(self) -> None:
        self._handles: list[Any] = []
        self._lock = threading.Lock()
        self.cancelled = False

    def attach(self, handle: Any) -> None:
        with self._lock:
            if self.cancelled:
                # cancel() already fired before this handle existed (race) —
                # close/kill it immediately instead of leaking it.
                self._close_one(handle)
                return
            self._handles.append(handle)

    def cancel(self) -> None:
        with self._lock:
            self.cancelled = True
            handles, self._handles = self._handles, []
        for h in handles:
            self._close_one(h)

    @staticmethod
    def _close_one(handle: Any) -> None:
        try:
            if hasattr(handle, "terminate"):
                handle.terminate()
            elif hasattr(handle, "close"):
                handle.close()
        except Exception:  # noqa: BLE001 — best-effort interruption only
            pass


@dataclass
class ExecutionContext:
    """Per-run inputs supplied by the caller.

    Credentials are intentionally not persisted in the DB — they live only on
    the request and are passed straight to the executor.
    """
    host: str = ""
    port: int = 22
    username: str = "root"
    password: Optional[str] = None
    private_key: Optional[str] = None

    # Job-type-specific overrides (merged on top of the saved BatchJob.params)
    params: dict[str, Any] = field(default_factory=dict)

    timeout: int = 60

    # Non-SSH (cluster-scoped) executors — resolved from the job's cluster.
    # SSH executors ignore these.
    kubeconfig_path: Optional[str] = None
    cluster_name: str = ""

    # Set by batch_job_service before executor.run() — executors that hold a
    # cancellable OS handle (SSH client, subprocess) should attach() it so a
    # concurrent "중지" request can interrupt the run. Optional: executors
    # that don't attach anything simply can't be force-stopped mid-flight.
    cancel_token: Optional[CancelToken] = None


@dataclass
class ExecutionResult:
    """Standardised result returned from BatchJobExecutor.run()."""
    status: str  # "ok" / "error" / "timeout" / "auth_error" / "connect_error" / "cancelled"
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: Optional[str] = None
    executed_command: str = ""


class BatchJobExecutor:
    """Base class for batch job implementations.

    Subclasses must:
      - set `job_type` (unique key) and `label` (human readable)
      - optionally set `description`, `default_params`, `param_schema`
      - implement `async def run(self, ctx: ExecutionContext) -> ExecutionResult`

    `requires_ssh = False` marks a cluster-scoped executor that runs from the
    backend/worker itself (e.g. kubectl with the cluster's kubeconfig). Such
    jobs need no target host and no SSH credentials — the router/dispatcher
    skip the credential invariants and `execute_job` resolves the kubeconfig
    into `ExecutionContext.kubeconfig_path` instead.
    """
    job_type: ClassVar[str] = ""
    label: ClassVar[str] = ""
    description: ClassVar[str] = ""
    requires_ssh: ClassVar[bool] = True
    # JSON-schema-ish description of allowed params; surfaced to the UI.
    # Shape: {param_name: {"type": "string|int|bool", "default": ..., "label": ...}}
    param_schema: ClassVar[dict[str, dict[str, Any]]] = {}
    default_params: ClassVar[dict[str, Any]] = {}

    def merge_params(self, saved: Optional[dict[str, Any]], override: Optional[dict[str, Any]]) -> dict[str, Any]:
        merged = dict(self.default_params)
        if saved:
            merged.update(saved)
        if override:
            merged.update(override)
        return merged

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:  # pragma: no cover - abstract
        raise NotImplementedError

    @classmethod
    def to_descriptor(cls) -> dict[str, Any]:
        return {
            "job_type": cls.job_type,
            "label": cls.label,
            "description": cls.description,
            "param_schema": cls.param_schema,
            "default_params": cls.default_params,
            "requires_ssh": cls.requires_ssh,
        }


_REGISTRY: dict[str, type[BatchJobExecutor]] = {}


def register_executor(cls: type[BatchJobExecutor]) -> type[BatchJobExecutor]:
    if not cls.job_type:
        raise ValueError(f"{cls.__name__} must set a non-empty job_type")
    if cls.job_type in _REGISTRY:
        raise ValueError(f"job_type '{cls.job_type}' already registered by {_REGISTRY[cls.job_type].__name__}")
    _REGISTRY[cls.job_type] = cls
    return cls


def get_executor(job_type: str) -> Optional[BatchJobExecutor]:
    cls = _REGISTRY.get(job_type)
    return cls() if cls else None


def list_executors() -> list[dict[str, Any]]:
    return [cls.to_descriptor() for cls in _REGISTRY.values()]
