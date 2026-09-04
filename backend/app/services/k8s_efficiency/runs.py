"""K8sEfficiencyRun 로그 헬퍼 — 단계(steps)·로그 줄을 매번 커밋해 프론트가 폴링으로 실시간 표시."""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sEfficiencyRun

TERMINAL = ("succeeded", "failed", "partial", "skipped")


def create_run(db: Session, cluster_id, run_type: str, *, trigger: str = "manual",
               triggered_by: Optional[str] = None, dry_run: bool = False,
               targets: Optional[list] = None, rollback_of=None,
               step_plan: Optional[list[dict]] = None) -> K8sEfficiencyRun:
    run = K8sEfficiencyRun(
        cluster_id=cluster_id, run_type=run_type, trigger=trigger, triggered_by=triggered_by,
        dry_run=dry_run, targets=targets or [], rollback_of=rollback_of, run_state="queued",
        steps=[{"id": s["id"], "label": s["label"], "status": "pending"} for s in (step_plan or [])],
        log_lines="",
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


class RunLogger:
    """run 하나에 대한 단계/로그 기록기. 예외를 삼켜 본 작업을 막지 않는다."""

    def __init__(self, db: Session, run: K8sEfficiencyRun):
        self.db = db
        self.run = run
        self._t0 = time.monotonic()
        self._step_started: dict[str, float] = {}

    def _flush(self) -> None:
        try:
            self.db.commit()
        except Exception:  # noqa: BLE001
            self.db.rollback()

    def log(self, line: str) -> None:
        ts = datetime.utcnow().strftime("%H:%M:%S")
        self.run.log_lines = (self.run.log_lines or "") + f"[{ts}] {line}\n"
        self._flush()

    def step(self, step_id: str, status: str, detail: Optional[str] = None,
             label: Optional[str] = None) -> None:
        steps = list(self.run.steps or [])
        now_ms = int((time.monotonic() - self._t0) * 1000)
        found = None
        for s in steps:
            if s.get("id") == step_id:
                found = s
                break
        if found is None:
            found = {"id": step_id, "label": label or step_id, "status": "pending"}
            steps.append(found)
        if status == "running":
            self._step_started[step_id] = time.monotonic()
            found["started_ms"] = now_ms
        elif step_id in self._step_started:
            found["duration_ms"] = int((time.monotonic() - self._step_started[step_id]) * 1000)
        found["status"] = status
        if detail is not None:
            found["detail"] = detail[:500]
        if label:
            found["label"] = label
        self.run.steps = steps
        self._flush()

    def start(self) -> None:
        self.run.run_state = "running"
        self.run.started_at = datetime.utcnow()
        self._flush()

    def finish(self, state: str, *, error: Optional[str] = None, summary: Optional[dict[str, Any]] = None,
               before: Any = None, after: Any = None) -> None:
        self.run.run_state = state
        self.run.finished_at = datetime.utcnow()
        self.run.duration_ms = int((time.monotonic() - self._t0) * 1000)
        if error:
            self.run.error = error[:1000]
        if summary is not None:
            self.run.summary = summary
        if before is not None:
            self.run.before = before
        if after is not None:
            self.run.after = after
        self._flush()
