"""Base classes and registry for batch job executors."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Optional


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


@dataclass
class ExecutionResult:
    """Standardised result returned from BatchJobExecutor.run()."""
    status: str  # "ok" / "error" / "timeout" / "auth_error" / "connect_error"
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
