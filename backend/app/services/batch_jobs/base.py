"""Base classes and registry for batch job executors."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar, Iterator, Optional

# step/command trace 상한 — JSONB 무한 성장 방지 (deep_checkers 와 동일 정책)
_OUTPUT_EXCERPT_CHARS = 2000
_MAX_RECORDED_COMMANDS = 30


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
    # kubeconfig 해석이 실패한 경우 그 **사유** (resolve_kubeconfig 가 생성) —
    # executor 가 step detail/에러 메시지에 그대로 노출해 "왜 안 되는지"를 보여준다.
    kubeconfig_note: str = ""

    # Set by batch_job_service before executor.run() — executors that hold a
    # cancellable OS handle (SSH client, subprocess) should attach() it so a
    # concurrent "중지" request can interrupt the run. Optional: executors
    # that don't attach anything simply can't be force-stopped mid-flight.
    cancel_token: Optional[CancelToken] = None


@dataclass
class ExecutionStep:
    """단일 실행 단계 — 진행 상태 타임라인/로그용 (deep_checkers 와 동일 shape)."""
    id: str
    label: str
    status: str = "running"  # running | success | failed | skipped
    detail: str = ""
    metrics: dict[str, Any] = field(default_factory=dict)
    started_ms: int = 0      # 실행 시작 기준 상대 시각
    duration_ms: int = 0


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
    # 단계별 진행 trace + 실제로 나간 명령 기록. executor 가 직접 채우지 않아도
    # `_run_and_record` 가 `_collected_steps()/_collected_commands()` 로 백필한다.
    steps: list[dict[str, Any]] = field(default_factory=list)
    commands: list[dict[str, Any]] = field(default_factory=list)


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
    # 정적 실행 단계 계획 [{"id","label"}] — 실행 전에도 UI 타임라인이 그려지고,
    # 실행 후에는 `_step()` 이 남긴 실측 상태가 같은 id 로 오버레이된다
    # (deep_checkers/registry.py 의 STEP_PLANS 관례).
    step_plan: ClassVar[list[dict[str, str]]] = []

    def merge_params(self, saved: Optional[dict[str, Any]], override: Optional[dict[str, Any]]) -> dict[str, Any]:
        merged = dict(self.default_params)
        if saved:
            merged.update(saved)
        if override:
            merged.update(override)
        return merged

    # ── 단계 트레이스 (deep_checkers/base.py 패턴 이식) ────────────────
    # deep_checkers 를 import 하지 않고 복사 — 그 모듈은 k8s SDK/Cluster 모델에
    # 의존해 batch_jobs 를 불필요하게 무겁게 만든다. executor 는 실행마다 새
    # 인스턴스(get_executor 가 cls() 반환)라 인스턴스 수집이 안전하고,
    # `_run_and_record` 가 예외 경로에서도 수집분을 회수한다.
    @contextmanager
    def _step(self, step_id: str, label: str) -> Iterator[ExecutionStep]:
        """핵심 동작을 감싸는 컨텍스트매니저 — 진입 시 running, 정상 종료 success,
        예외 시 failed(+detail) 후 re-raise. detail/metrics 는 블록 안에서 채운다."""
        if not hasattr(self, "_steps"):
            self._steps: list[ExecutionStep] = []
            self._run_start = time.time()
        rec = ExecutionStep(
            id=step_id, label=label, status="running",
            started_ms=int((time.time() - self._run_start) * 1000),
        )
        self._steps.append(rec)
        t0 = time.time()
        try:
            yield rec
            if rec.status == "running":
                rec.status = "success"
        except Exception as e:  # noqa: BLE001
            rec.status = "failed"
            if not rec.detail:
                rec.detail = str(e)[:200]
            raise
        finally:
            rec.duration_ms = int((time.time() - t0) * 1000)

    def _collected_steps(self) -> list[dict[str, Any]]:
        return [asdict(s) for s in getattr(self, "_steps", [])]

    def _record_command(
        self,
        command: list[str] | str,
        started: float,
        *,
        kind: str = "kubectl",
        exit_code: Optional[int],
        stdout: str,
        stderr: str,
    ) -> None:
        """실제로 대상에 나간 명령 1건을 기록한다 (런북 "설계" 대비 "실측").

        kubeconfig 경로는 서버 내부 경로라 마스킹하고, 출력은 발췌만 남긴다
        (전체를 담으면 JSONB 가 무한정 커진다). SSH executor 는 문자열 명령을
        kind="ssh" 로 기록한다.
        """
        if not hasattr(self, "_commands"):
            self._commands: list[dict[str, Any]] = []
        if len(self._commands) >= _MAX_RECORDED_COMMANDS:
            return
        if isinstance(command, str):
            display_cmd = command
        else:
            display: list[str] = []
            skip_next = False
            for tok in command:
                if skip_next:
                    display.append("<kubeconfig>")
                    skip_next = False
                    continue
                if tok == "--kubeconfig":
                    display.append(tok)
                    skip_next = True
                    continue
                display.append(tok)
            display_cmd = " ".join(display)
        self._commands.append({
            "kind": kind,
            "command": display_cmd,
            "exit_code": exit_code,
            "duration_ms": int((time.time() - started) * 1000),
            "stdout": (stdout or "")[:_OUTPUT_EXCERPT_CHARS],
            "stderr": (stderr or "")[:_OUTPUT_EXCERPT_CHARS],
            "truncated": len(stdout or "") > _OUTPUT_EXCERPT_CHARS,
        })

    def _collected_commands(self) -> list[dict[str, Any]]:
        return list(getattr(self, "_commands", []))

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
            "step_plan": cls.step_plan,
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
