"""실행 명령 추적 — "로그 보기" 에 **실제로 노드·클러스터에 나간 명령**을 맨 앞에 남긴다(관리자 전용).

어느 화면의 실행 로그든 "이 버튼이 대상에 무슨 명령을 날렸나" 를 관리자가 먼저 볼 수 있어야 한다.
호출 경로마다 로그 코드를 넣지 않고 **명령이 나가는 길목 세 곳**에서 기록한다.

- SSH/SCP — ``ssh_runner._exec_ssh`` · ``_exec_scp_push`` · ``isilon_service``
- 로컬 프로세스(kubectl·helm·ansible-playbook·cilium …) — ``sys.addaudithook`` 의 ``subprocess.Popen`` 이벤트.
  ``subprocess.run`` 도 Popen 을 거치므로 호출처를 고치지 않아도 전부 잡힌다.
- 파드 exec(K8S SDK) — ``kubectl_exec.safe_pod_exec``

기록은 ContextVar 로 꽂힌 **sink** 로만 간다(없으면 DEBUG 로그만). sink 를 꽂는 곳:

- SSE 실행 로그(``services/sse.stream_async_job`` 등) — ``level="cmd"`` 로그 이벤트. 보는 사람이 관리자가 아니면
  스트림에서 걸러낸다.
- 단건 요청 — ``CommandTraceMiddleware`` 가 관리자 요청에만 수집기를 꽂고, 응답 헤더 ``X-PEP-Commands`` 로 돌려준다.
  프론트 실행 로그(useRunLog)가 진행 중인 실행에 ``CMD`` 줄로 붙인다.
- DB 에 남는 실행 로그(서비스 구성 적용·공통 서비스·플레이북) — ``level="cmd"`` 줄로 저장하고, 조회 시
  ``filter_log_lines`` 로 관리자가 아니면 뺀다.

비밀번호·토큰·kubeconfig 경로는 ``mask`` 로 가리고, 긴 명령(heredoc 파일 내용 등)은 앞부분만 남긴다.
"""
from __future__ import annotations

import base64
import contextvars
import json
import logging
import re
import shlex
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import Any, Callable, Iterable, Iterator, Optional

import anyio

logger = logging.getLogger(__name__)

CMD_LEVEL = "cmd"
# 한 줄 문자열 로그(``[HH:MM:SS] CMD $ [ssh …] …``)에서 명령 줄을 알아보는 표식.
CMD_TEXT_MARK = "CMD $ ["
HEADER = "X-PEP-Commands"
_HEADER_BYTES = HEADER.lower().encode()

# 한 줄·한 응답 상한 — 응답 헤더(프록시 기본 8KB~)·로그 뷰어가 감당할 크기.
MAX_COMMAND_CHARS = 2000
MAX_HEREDOC_PREVIEW_LINES = 6
MAX_HEADER_COMMANDS = 40
MAX_HEADER_BYTES = 12_000

Sink = Callable[[str], None]

_sink: contextvars.ContextVar[Optional[Sink]] = contextvars.ContextVar("pep_command_sink", default=None)
_viewer_admin: contextvars.ContextVar[bool] = contextvars.ContextVar("pep_command_viewer_admin", default=False)


# ── 마스킹·포맷 ─────────────────────────────────────────────────────────────

_SECRET_WORDS = r"(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key)"
_VALUE = r"(\"[^\"]*\"|'[^']*'|[^\s,};&|]+)"
# key=value · "key": "value" — 키 이름에 비밀 단어가 들어 있으면 값을 가린다.
_SECRET_KV = re.compile(r"(?i)(\b[\w.-]*" + _SECRET_WORDS + r"[\w.-]*[\"']?)(\s*[=:]\s*)" + _VALUE)
# --password VALUE 처럼 공백으로 값을 받는 플래그 — ``kubectl get secret -n x`` 를 가리지 않게 플래그 꼴만.
_SECRET_FLAG = re.compile(r"(?i)((?<!\S)--?[\w-]*" + _SECRET_WORDS + r"[\w-]*)(\s+)" + _VALUE)
_AUTH_HEADER = re.compile(r"(?i)(authorization:\s*(?:bearer|basic)\s+)[^\s\"']+")
_SSHPASS = re.compile(r"(\bsshpass\s+-p\s*)(\S+)")
_KUBECONFIG = re.compile(r"(--kubeconfig[=\s]+)(\S+)")
_KUBECONFIG_ENV = re.compile(r"(\bKUBECONFIG=)(\S+)")
_URL_CRED = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)([^\s@/]+)(@)")


def mask(text: str) -> str:
    """명령 문자열의 비밀값을 가린다 — 키 이름이 비밀번호·토큰류인 값, Authorization 헤더, sshpass, URL 자격증명.
    kubeconfig 경로는 서버 내부 임시 경로라 ``<kubeconfig>`` 로 바꾼다."""
    s = _AUTH_HEADER.sub(r"\1***", text)
    s = _SSHPASS.sub(r"\1***", s)
    s = _URL_CRED.sub(r"\1***\3", s)
    s = _KUBECONFIG.sub(r"\1<kubeconfig>", s)
    s = _KUBECONFIG_ENV.sub(r"\1<kubeconfig>", s)
    s = _SECRET_KV.sub(lambda m: f"{m.group(1)}{m.group(2)}***", s)
    s = _SECRET_FLAG.sub(lambda m: f"{m.group(1)}{m.group(2)}***", s)
    return s


def _shorten(cmd: str) -> str:
    """여러 줄(heredoc 로 파일 내용을 싣는 명령)은 앞 몇 줄만, 그래도 길면 앞부분만."""
    lines = cmd.splitlines()
    if len(lines) > MAX_HEREDOC_PREVIEW_LINES + 1:
        head = "\n".join(lines[:MAX_HEREDOC_PREVIEW_LINES])
        cmd = f"{head}\n… (이하 {len(lines) - MAX_HEREDOC_PREVIEW_LINES}줄 생략)"
    if len(cmd) > MAX_COMMAND_CHARS:
        cmd = cmd[:MAX_COMMAND_CHARS] + f" … ({len(cmd)}자 중 {MAX_COMMAND_CHARS}자)"
    return cmd


def format_command(kind: str, target: str, command: str | Iterable[str]) -> str:
    """``$ [ssh root@10.0.0.1:22] sysctl -e vm.swappiness`` 형태의 한 줄(여러 줄일 수 있음)."""
    if not isinstance(command, str):
        command = " ".join(shlex.quote(str(c)) for c in command)
    where = f"{kind} {target}".strip()
    return f"$ [{where}] {_shorten(mask(command))}"


# ── sink ───────────────────────────────────────────────────────────────────

@contextmanager
def bind(sink: Optional[Sink]) -> Iterator[None]:
    """이 컨텍스트(와 여기서 시작한 태스크·executor 작업)에서 기록되는 명령을 ``sink`` 로 보낸다.
    안쪽 bind 가 바깥을 덮는다(같은 명령이 두 번 찍히지 않게)."""
    token = _sink.set(sink)
    try:
        yield
    finally:
        try:
            _sink.reset(token)
        except ValueError:  # 다른 컨텍스트에서 끝난 제너레이터 등 — 값만 되돌린다.
            _sink.set(None)


def bind_log(log: Callable[[str, str], None]) -> Any:
    """``log(level, message)`` 형태의 실행 로그에 ``cmd`` 줄로 남기는 bind."""
    return bind(lambda msg: log(CMD_LEVEL, msg))


def bind_emit(emit: Callable[[dict], None]) -> Any:
    """SSE emit 에 ``{"type":"log","level":"cmd"}`` 이벤트로 흘리는 bind(보는 사람이 관리자일 때만 쓴다)."""
    from app.services.sse import now_iso

    return bind(lambda msg: emit({"type": "log", "level": CMD_LEVEL, "ts": now_iso(), "message": msg}))


def bind_stream(emit: Callable[[dict], None]) -> Any:
    """SSE 실행 스트림용 — 보는 사람이 관리자면 cmd 이벤트로 흘리고, 아니면 sink 를 비운다."""
    return bind_emit(emit) if viewer_is_admin() else bind(None)


@contextmanager
def collecting() -> Iterator[list[str]]:
    """직접 만든 SSE 제너레이터용 — 명령을 리스트에 모으고(관리자일 때만), 호출자가 ``drain_events`` 로 흘린다."""
    lst: list[str] = []
    with bind(lst.append if viewer_is_admin() else None):
        yield lst


def drain_events(lst: list[str]) -> list[dict]:
    """모은 명령 → ``{"type":"log","level":"cmd"}`` 이벤트 목록(리스트는 비운다)."""
    if not lst:
        return []
    from app.services.sse import now_iso

    taken = lst[:]
    del lst[: len(taken)]
    ts = now_iso()
    return [{"type": "log", "level": CMD_LEVEL, "ts": ts, "message": m} for m in taken]


def active() -> bool:
    return _sink.get() is not None


def record(kind: str, target: str, command: str | Iterable[str]) -> None:
    """명령 1건 기록 — 절대 예외를 올리지 않는다(실행 경로를 막지 않게)."""
    sink = _sink.get()
    if sink is None and not logger.isEnabledFor(logging.DEBUG):
        return
    try:
        line = format_command(kind, target, command)
        logger.debug("command %s", line)
        if sink is not None:
            sink(line)
    except Exception:  # noqa: BLE001
        logger.debug("command_trace record failed", exc_info=True)


# ── 보는 사람(관리자 여부) ───────────────────────────────────────────────────

def set_viewer_admin(value: bool) -> contextvars.Token:
    return _viewer_admin.set(bool(value))


def viewer_is_admin() -> bool:
    return _viewer_admin.get()


def is_cmd_event(evt: dict) -> bool:
    return evt.get("type") == "log" and evt.get("level") == CMD_LEVEL


def filter_log_lines(lines: Any, is_admin: bool) -> Any:
    """DB 에 남은 실행 로그에서 ``cmd`` 줄을 관리자가 아니면 뺀다.
    줄 모양 ``[ts, level, message]`` · ``{"level": ...}`` · 문자열(``CMD $ [`` 표식) 을 받는다(그 밖은 그대로 둔다)."""
    if is_admin or not isinstance(lines, list):
        return lines
    out = []
    for ln in lines:
        if isinstance(ln, (list, tuple)) and len(ln) >= 2 and ln[1] == CMD_LEVEL:
            continue
        if isinstance(ln, dict) and ln.get("level") == CMD_LEVEL:
            continue
        if isinstance(ln, str) and CMD_TEXT_MARK in ln:
            continue
        out.append(ln)
    return out


def visible_lines(lines: Any) -> Any:
    """지금 요청을 보낸 사람 기준으로 거른 실행 로그(관리자 = 그대로, 그 밖 = cmd 줄 제외).
    관리자 여부는 ``CommandTraceMiddleware`` 가 요청 컨텍스트에 둔 값이다(요청 밖 — Celery 등 — 은 비관리자 취급)."""
    return filter_log_lines(lines, viewer_is_admin())


def filter_text_log(text: Any, is_admin: bool) -> Any:
    """한 덩어리 문자열 실행 로그(``[ts] CMD $ […] …`` 줄)용."""
    if is_admin or not isinstance(text, str):
        return text
    return "\n".join(ln for ln in text.split("\n") if CMD_TEXT_MARK not in ln)


def is_admin_user(user: Any) -> bool:
    return getattr(user, "role", None) == "admin"


# ── 로컬 프로세스(kubectl·helm·ansible …) — 감사 훅 ────────────────────────────

_HOOK_INSTALLED = False


def _audit_hook(event: str, args: tuple) -> None:
    if event != "subprocess.Popen":
        return
    sink = _sink.get()
    if sink is None:
        return
    try:
        executable, argv = args[0], args[1]
        if isinstance(argv, (list, tuple)) and argv:
            prog = str(argv[0]).rsplit("/", 1)[-1]
        elif isinstance(argv, (str, bytes)):
            prog = (argv.decode(errors="replace") if isinstance(argv, bytes) else argv).split(" ", 1)[0].rsplit("/", 1)[-1]
            argv = argv.decode(errors="replace") if isinstance(argv, bytes) else argv
        else:
            prog = str(executable or "?").rsplit("/", 1)[-1]
            argv = [str(executable)]
        if isinstance(argv, (list, tuple)):
            argv = [a.decode(errors="replace") if isinstance(a, bytes) else str(a) for a in argv]
        record("local", prog, argv)
    except Exception:  # noqa: BLE001 — 감사 훅은 절대 예외를 올리지 않는다.
        pass


def install() -> None:
    """프로세스에 한 번만 감사 훅을 단다(앱·Celery 워커 기동 시). 훅은 sink 가 없으면 아무 일도 하지 않는다."""
    global _HOOK_INSTALLED
    if _HOOK_INSTALLED:
        return
    sys.addaudithook(_audit_hook)
    _HOOK_INSTALLED = True


# ── 스레드로 컨텍스트 넘기기 ─────────────────────────────────────────────────

class ContextThreadPoolExecutor(ThreadPoolExecutor):
    """``submit`` 시점의 contextvars 를 작업 스레드로 넘기는 executor.

    ``loop.run_in_executor`` 와 평범한 ThreadPoolExecutor 는 컨텍스트를 복사하지 않아, SSH 를 스레드에서 돌리는
    실행은 sink 를 잃는다. 이벤트 루프 기본 executor(main.py lifespan)와 ``ssh_runner`` 병렬 풀이 이것을 쓴다."""

    def submit(self, fn, /, *args, **kwargs):  # noqa: ANN001, ANN201
        ctx = contextvars.copy_context()
        return super().submit(ctx.run, fn, *args, **kwargs)


# ── 응답 헤더(단건 요청) ─────────────────────────────────────────────────────

def encode_header(commands: list[str]) -> Optional[bytes]:
    """명령 목록 → base64url(JSON). 상한을 넘으면 뒤를 자르고 마지막에 생략 표시를 넣는다."""
    if not commands:
        return None
    items = list(commands[:MAX_HEADER_COMMANDS])
    if len(commands) > MAX_HEADER_COMMANDS:
        items.append(f"… 명령 {len(commands) - MAX_HEADER_COMMANDS}건 더 (헤더 상한)")
    while items:
        raw = base64.urlsafe_b64encode(json.dumps(items, ensure_ascii=False).encode()).rstrip(b"=")
        if len(raw) <= MAX_HEADER_BYTES:
            return raw
        # 넘치면 줄 길이를 줄이고 개수를 반으로 — 몇 번 안에 상한 안으로 들어온다.
        keep = max(1, (len(items) - 1) // 2) if len(items) > 1 else 0
        if keep == 0:
            items = [items[0][:500]] if len(items[0]) > 500 else []
            continue
        items = [s_[:500] for s_ in items[:keep]] + ["… 헤더 크기 상한으로 일부 생략"]
    return None


def _bearer_payload(scope: dict) -> Optional[dict]:
    """서명·만료 검증을 통과한 JWT payload(없거나 무효면 None)."""
    for k, v in scope.get("headers") or []:
        if k == b"authorization":
            val = v.decode("latin-1")
            if not val.lower().startswith("bearer "):
                return None
            from app.auth.security import decode_access_token

            return decode_access_token(val[7:].strip()) or None
    return None


# 관리자 판정 캐시 — (username, 로그인 시각) → (만료 monotonic, 관리자 여부). 요청마다 DB 를 치지 않게 짧게만 둔다.
ADMIN_CACHE_TTL_SEC = 10.0
_admin_cache: dict[tuple[str, Any], tuple[float, bool]] = {}
_admin_cache_lock = threading.Lock()


def forget_user(username: Optional[str] = None) -> None:
    """역할·활성 상태가 바뀌면 캐시를 지운다(None = 전부). 역할 변경 API 가 부른다."""
    with _admin_cache_lock:
        if username is None:
            _admin_cache.clear()
        else:
            for key in [k for k in _admin_cache if k[0] == username]:
                _admin_cache.pop(key, None)


def _db_is_admin(username: str, payload: dict) -> bool:
    """DB 의 **현재** 사용자 상태로 관리자 여부를 본다 — 토큰의 role 클레임은 강등 뒤에도 남아 있으므로 믿지 않는다.
    인증 의존성(get_current_user)과 같은 조건: 활성 사용자 · 비밀번호 변경 전 토큰 아님 · role=admin."""
    from app.auth.security import is_token_revoked
    from app.database import SessionLocal
    from app.models.user import User

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None or not user.is_active or user.role != "admin":
            return False
        return not is_token_revoked(payload, getattr(user, "password_changed_at", None))
    finally:
        db.close()


def resolve_admin(payload: Optional[dict]) -> bool:
    """검증된 토큰 payload → 지금 관리자인가(캐시 ``ADMIN_CACHE_TTL_SEC``). 오류는 비관리자로 본다(fail-closed)."""
    if not payload or payload.get("role") != "admin":
        return False  # 관리자 토큰이 아니면 DB 를 볼 필요도 없다(승격은 다음 토큰부터)
    username = payload.get("sub")
    if not username:
        return False
    key = (str(username), payload.get("auth_time") or payload.get("iat"))
    now = time.monotonic()
    with _admin_cache_lock:
        hit = _admin_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    try:
        value = _db_is_admin(str(username), payload)
    except Exception:  # noqa: BLE001
        logger.debug("command_trace admin lookup failed", exc_info=True)
        return False
    with _admin_cache_lock:
        if len(_admin_cache) > 1000:
            _admin_cache.clear()
        _admin_cache[key] = (now + ADMIN_CACHE_TTL_SEC, value)
    return value


class CommandTraceMiddleware:
    """관리자 요청에만 명령 수집기를 꽂고, 응답 헤더 ``X-PEP-Commands`` 로 돌려준다(순수 ASGI — SSE 무간섭).

    관리자 여부는 서명 검증된 JWT 의 ``role`` 이 admin 이고 **DB 의 현재 사용자**도 활성 admin 일 때만 참이다
    (강등·비활성화·비밀번호 변경 뒤의 옛 토큰은 보지 못한다 — ``resolve_admin``, 10초 캐시 + 역할 변경 시 ``forget_user``).
    표시용 판정이라 권한 검사(require_admin)를 대신하지 않는다. SSE 응답은 헤더가 먼저 나가므로 스트림 안에서 ``cmd`` 이벤트로 흘린다(services/sse.py)."""

    def __init__(self, app):  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        try:
            payload = _bearer_payload(scope)
            # 토큰이 관리자일 때만 DB 의 현재 역할을 본다(스레드에서 — 이벤트 루프를 막지 않게).
            admin = bool(payload and payload.get("role") == "admin") and await anyio.to_thread.run_sync(resolve_admin, payload)
        except Exception:  # noqa: BLE001
            admin = False
        if not admin:
            await self.app(scope, receive, send)
            return
        collected: list[str] = []

        def _collect(line: str) -> None:
            # 오래 열린 요청(스트림 등)이 응답 시작 뒤에도 명령을 쌓아 메모리를 키우지 않게 상한을 둔다.
            if len(collected) <= MAX_HEADER_COMMANDS:
                collected.append(line)

        admin_token = set_viewer_admin(True)
        sink_token = _sink.set(_collect)

        async def _send(message):  # noqa: ANN001
            if message["type"] == "http.response.start" and collected:
                raw = encode_header(collected)
                if raw:
                    headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != _HEADER_BYTES]
                    headers.append((_HEADER_BYTES, raw))
                    message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            for var, tok in ((_sink, sink_token), (_viewer_admin, admin_token)):
                try:
                    var.reset(tok)
                except ValueError:
                    pass
