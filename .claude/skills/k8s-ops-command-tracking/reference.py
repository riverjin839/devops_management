"""Command tracking — KM(K8s Manager) 명령(Command) 패턴의 레퍼런스 구현.

KM 명령: fetch/wait/abort/retry, 일괄 명령(errors), 명령 메타데이터(argSchema), 대상별 명령 목록.

프레임워크 비의존(표준 라이브러리만). 저장소(DB/Redis)는 `CommandStore` 프로토콜로 주입한다.
"""
from __future__ import annotations

import itertools
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

# KM 은 즉시 끝나는 동기 명령에 id=-1 을 준다 → fetch/wait/abort 가 no-op.
SYNCHRONOUS_COMMAND_ID = -1


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class LogLine:
    ts: datetime
    level: str  # info | warn | error | debug
    message: str
    step: str | None = None


@dataclass
class Command:
    """하나의 장기 실행 작업 핸들. 버튼 1회 클릭 = Command 1개."""

    id: int
    name: str
    target: dict[str, str] = field(default_factory=dict)  # {"cluster":..,"namespace":..,"kind":..,"name":..}
    args: dict[str, Any] = field(default_factory=dict)
    active: bool = True
    success: bool | None = None  # active 동안 None
    result_message: str = ""
    started_at: datetime = field(default_factory=_now)
    ended_at: datetime | None = None
    parent_id: int | None = None  # retry 로 만들어진 경우 원본 id
    children: list[int] = field(default_factory=list)  # 하위 명령(배치/노드별)
    can_retry: bool = False
    abort_requested: bool = False
    logs: list[LogLine] = field(default_factory=list)

    @property
    def state(self) -> str:
        if self.active:
            return "aborting" if self.abort_requested else "running"
        if self.abort_requested and not self.success:
            return "aborted"
        return "succeeded" if self.success else "failed"


class CommandStore(Protocol):
    def save(self, cmd: Command) -> None: ...
    def get(self, cmd_id: int) -> Command: ...


class InMemoryStore:
    def __init__(self) -> None:
        self._d: dict[int, Command] = {}
        self._lock = threading.Lock()

    def save(self, cmd: Command) -> None:
        with self._lock:
            self._d[cmd.id] = cmd

    def get(self, cmd_id: int) -> Command:
        with self._lock:
            return self._d[cmd_id]


class CommandAborted(Exception):
    pass


class CommandContext:
    """실행 함수가 받는 컨텍스트. 로그는 즉시 저장(실시간 스트리밍 전제)."""

    def __init__(self, store: CommandStore, cmd: Command, echo: Callable[[LogLine], None] | None = None):
        self._store, self.cmd, self._echo = store, cmd, echo

    def log(self, message: str, level: str = "info", step: str | None = None) -> None:
        line = LogLine(_now(), level, message, step)
        self.cmd.logs.append(line)
        self._store.save(self.cmd)  # 줄 단위 커밋 → 폴링/SSE 가 바로 읽는다
        if self._echo:
            self._echo(line)

    def checkpoint(self) -> None:
        """협조적 abort 지점. 단계 사이마다 호출한다."""
        if self._store.get(self.cmd.id).abort_requested:
            raise CommandAborted("abort requested")


class CommandManager:
    _ids = itertools.count(1)

    def __init__(self, store: CommandStore):
        self.store = store

    def submit(self, name: str, fn: Callable[[CommandContext], str], *, target=None, args=None,
               parent_id: int | None = None, retryable: bool = True,
               run: Callable[[Callable[[], None]], None] | None = None) -> Command:
        """명령을 만들고 즉시 반환(비동기). `run` 은 실행기(Celery delay, thread 등)."""
        cmd = Command(id=next(self._ids), name=name, target=target or {}, args=args or {}, parent_id=parent_id)
        self.store.save(cmd)

        def _body() -> None:
            ctx = CommandContext(self.store, cmd)
            ctx.log(f"start {name} target={cmd.target} args={cmd.args}")
            try:
                msg = fn(ctx)
                cmd.success, cmd.result_message = True, msg or "ok"
            except CommandAborted as e:
                cmd.success, cmd.result_message, cmd.can_retry = False, f"aborted: {e}", retryable
            except Exception as e:  # 실패도 구조화된 결과로 남긴다
                cmd.success, cmd.result_message, cmd.can_retry = False, f"{type(e).__name__}: {e}", retryable
                ctx.log(cmd.result_message, level="error")
            finally:
                cmd.active, cmd.ended_at = False, _now()
                ctx.log(f"end state={cmd.state}")
        (run or (lambda f: threading.Thread(target=f, daemon=True).start()))(_body)
        return cmd

    def fetch(self, cmd_id: int) -> Command:
        return self.store.get(cmd_id)

    def wait(self, cmd_id: int, timeout: float | None = None, poll: float = 0.5, max_poll: float = 5.0) -> Command:
        """끝날 때까지 대기. 타임아웃이면 예외 대신 *마지막 상태*를 돌려준다(KM 의미론)."""
        if cmd_id == SYNCHRONOUS_COMMAND_ID:
            raise ValueError("synchronous command has no server state")
        deadline = None if timeout is None else time.monotonic() + timeout
        delay = poll
        while True:
            cmd = self.fetch(cmd_id)
            if not cmd.active:
                return cmd
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    return cmd
                time.sleep(min(delay, left))
            else:
                time.sleep(delay)
            delay = min(delay * 1.5, max_poll)  # 고정 간격 대신 — 짧은 명령 체감 개선용 백오프

    def abort(self, cmd_id: int) -> Command:
        cmd = self.fetch(cmd_id)
        if cmd.active:
            cmd.abort_requested = True
            self.store.save(cmd)
        return cmd

    def retry(self, cmd_id: int, fn: Callable[[CommandContext], str], **kw) -> Command:
        old = self.fetch(cmd_id)
        if old.active or not old.can_retry:
            raise ValueError(f"command {cmd_id} is not retryable (state={old.state})")
        return self.submit(old.name, fn, target=old.target, args=old.args, parent_id=old.id, **kw)


# ── Bulk: 대상 N개에 같은 명령. 일부 실패는 errors 로 모으고 나머지는 계속(KM 일괄 명령) ──
@dataclass
class BulkResult:
    commands: list[Command]
    errors: list[str]  # 제출 자체가 실패한 대상(검증 실패 등)


def submit_bulk(mgr: CommandManager, name: str, targets: list[dict], make_fn, validate=None, **kw) -> BulkResult:
    cmds, errors = [], []
    for t in targets:
        reason = validate(t) if validate else None
        if reason:
            errors.append(f"{t}: {reason}")
            continue
        cmds.append(mgr.submit(name, make_fn(t), target=t, **kw))
    return BulkResult(cmds, errors)


# ── Command catalog: 대상 종류별 실행 가능한 명령 + 인자 스키마 → UI 가 폼을 그린다(KM 명령 메타데이터) ──
@dataclass(frozen=True)
class CommandSpec:
    name: str
    label: str
    applies_to: tuple[str, ...]  # ("Deployment","StatefulSet",...)
    arg_schema: dict  # JSON Schema subset: {"type":"object","properties":{..},"required":[..]}
    mutating: bool = True  # False 면 확인 없이 실행(조회형)
    danger: bool = False  # True 면 2단계 확인


def validate_args(spec: CommandSpec, args: dict) -> list[str]:
    errs: list[str] = []
    props = spec.arg_schema.get("properties", {})
    for req in spec.arg_schema.get("required", []):
        if req not in args:
            errs.append(f"missing: {req}")
    pytypes = {"integer": int, "number": (int, float), "string": str, "boolean": bool, "array": list}
    for k, v in args.items():
        if k not in props:
            errs.append(f"unknown: {k}")
            continue
        p = props[k]
        t = pytypes.get(p.get("type", ""))
        if t and (not isinstance(v, t) or (p.get("type") == "integer" and isinstance(v, bool))):
            errs.append(f"type: {k} must be {p['type']}")
            continue
        if "minimum" in p and v < p["minimum"]:
            errs.append(f"range: {k} >= {p['minimum']}")
        if "enum" in p and v not in p["enum"]:
            errs.append(f"enum: {k} in {p['enum']}")
    return errs


def commands_for(catalog: list[CommandSpec], kind: str) -> list[CommandSpec]:
    return [c for c in catalog if kind in c.applies_to]
