"""Batch job executors.

To add a new batch job type:

1. Create a module in this package, e.g. `my_job.py`.
2. Subclass `BatchJobExecutor`, set `job_type = "my_job"`, and implement `run()`.
3. Decorate the class with `@register_executor` (or call `register_executor(cls)`).
4. Import the module in `app/services/batch_jobs/__init__.py` so the decorator
   side-effect runs at import time.

The router (`/api/v1/batch-jobs/types`) auto-discovers registered executors
and the UI surfaces them as selectable options when creating a job.
"""
from app.services.batch_jobs.base import (
    BatchJobExecutor,
    CancelToken,
    ExecutionContext,
    ExecutionResult,
    ExecutionStep,
    register_executor,
    get_executor,
    list_executors,
)

# Side-effect imports — registers executors via the decorator.
from app.services.batch_jobs import etcdctl_defrag  # noqa: F401
from app.services.batch_jobs import shell_command  # noqa: F401
from app.services.batch_jobs import k8s_job_cleanup  # noqa: F401

__all__ = [
    "BatchJobExecutor",
    "CancelToken",
    "ExecutionContext",
    "ExecutionResult",
    "ExecutionStep",
    "register_executor",
    "get_executor",
    "list_executors",
]
