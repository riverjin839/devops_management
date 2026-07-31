"""In-process registry of in-flight batch job executions, keyed by job_id.

Only used for **manual** runs — those execute synchronously inside the same
FastAPI worker process that later serves ``POST /batch-jobs/{id}/stop``, so a
plain in-memory dict is enough (no cross-process coordination needed). A
`stop` request only succeeds via this registry if it lands on the same
backend replica that is running the job; with multiple replicas behind a
Service, a stop request for a manual run may hit a different pod and find
nothing here — the DB state is still corrected by the router regardless (see
`routers/batch_jobs.py::stop_job`), only the *actual* OS-level interruption
may be missed in that case.

Scheduled (Celery Beat) and bulk-run executions run inside a separate Celery
worker process and are stopped via `celery_app.control.revoke(terminate=True)`
instead (works across processes through the broker) — they don't rely on this
registry at all.
"""
from __future__ import annotations

import threading

from app.services.batch_jobs import CancelToken

_lock = threading.Lock()
_active: dict[str, CancelToken] = {}


def register(job_id: str, token: CancelToken) -> None:
    with _lock:
        _active[job_id] = token


def unregister(job_id: str, token: CancelToken) -> None:
    """Remove only if it's still the same token (avoids clobbering a newer
    run that started for the same job right after this one finished)."""
    with _lock:
        if _active.get(job_id) is token:
            _active.pop(job_id, None)


def try_cancel(job_id: str) -> bool:
    """Best-effort interrupt. Returns True if a live handle was found (does
    not guarantee the remote process actually died)."""
    with _lock:
        token = _active.get(job_id)
    if token is None:
        return False
    token.cancel()
    return True
