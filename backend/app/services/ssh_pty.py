"""브라우저(xterm.js) ↔ FastAPI WebSocket ↔ paramiko PTY 브리지 공용 유틸.

SSH 웹 터미널 화면(k9s 콘솔 `routers/k9s_ssh.py`, 노드 SSH 터미널
`routers/node_ssh.py`)이 공유하는 **기본 base 툴**이다. 토큰 검증 · init 프레임
파싱 · PTY 펌프 루프를 한 곳에 두어 콘솔이 늘어나도 프로토콜과 보안 정책이
갈라지지 않게 한다. 실제 SSH 연결은 `services/ssh_runner.connect_client`
(TOFU host-key 정책)를 그대로 쓴다.

프로토콜(모든 SSH 웹 터미널 공통):
- 클라이언트는 `?token=<jwt>` 로 연결한다(WS 는 Authorization 헤더 불가).
- accept 직후 클라이언트가 **init 프레임** 을 1회 보낸다:
    {"type":"init","host":"10.0.0.11","port":22,"username":"root",
     "password":"...","privateKey":"...","cols":120,"rows":40, ...}
  password/privateKey 는 URL 이 아닌 이 프레임으로만 받는다(로그/히스토리 노출 방지).
  화면별 추가 옵션(namespace, initialCommand 등)은 `PtyInit.raw` 로 그대로 전달된다.
- 이후 프레임: {"type":"stdin","data":"..."} / {"type":"resize","cols":..,"rows":..}

보안:
- WS 에는 전역 `_auth` 가 적용되지 않으므로 핸들러가 `resolve_ws_user()` 로 직접
  토큰을 검증하고, 역할이 admin/operator 일 때만 accept 한다(viewer 차단).
- SSH 인증정보는 세션에만 사용하고 DB 에 저장하지 않는다(bulk-exec/etcdctl 과 동일).
- 세션은 `MAX_SESSION_SECONDS` 상한으로 강제 종료한다(좀비 세션 방지).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from fastapi import WebSocket, WebSocketDisconnect

from app.auth.security import decode_access_token
from app.models.user import User
from app.services.ssh_runner import SSHTarget, connect_client

logger = logging.getLogger(__name__)

ALLOWED_ROLES = frozenset({"admin", "operator"})
MAX_SESSION_SECONDS = 60 * 60  # 1시간 상한 — 좀비 세션 방지

# WebSocket close code — 화면(K9sTerminal/SshTerminalWindow)이 사용자 안내 문구로 매핑한다.
CLOSE_UNAUTHORIZED = 4401
CLOSE_DISABLED = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_BAD_INIT = 1008
CLOSE_SSH_FAILED = 1011


def env_flag_enabled(name: str, default: bool = True) -> bool:
    """`PEP_*_ENABLED` 류 on/off 플래그. 미설정이면 default."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("false", "0", "no")


def resolve_ws_user(token: str | None, db, allowed_roles=ALLOWED_ROLES) -> User | None:
    """query param 토큰 → User. 실패/비활성/역할부족이면 None."""
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    username = payload.get("sub")
    if not username:
        return None
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.is_active:
        return None
    effective_role = "viewer" if user.role == "user" else user.role
    if effective_role not in allowed_roles:
        return None
    return user


class PtyInitError(Exception):
    """init 프레임이 없거나 형식이 잘못됨 — 사용자에게 보여줄 한국어 사유를 담는다."""


@dataclass
class PtyInit:
    """검증된 init 프레임."""

    host: str
    port: int
    username: str
    password: Optional[str]
    private_key: Optional[str]
    cols: int
    rows: int
    raw: dict = field(default_factory=dict)

    @property
    def label(self) -> str:
        return f"{self.username}@{self.host}:{self.port}"

    def target(self, **meta) -> SSHTarget:
        return SSHTarget(
            host=self.host,
            port=self.port,
            username=self.username,
            password=self.password,
            private_key=self.private_key,
            **meta,
        )


async def receive_init(websocket: WebSocket, timeout: int = 60) -> PtyInit:
    """accept 직후 init 프레임 1개를 수신·검증한다. 실패 시 PtyInitError."""
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)
        frame = json.loads(raw)
    except (asyncio.TimeoutError, ValueError, TypeError):
        raise PtyInitError("init 프레임 없음 — 종료")
    if not isinstance(frame, dict) or frame.get("type") != "init":
        raise PtyInitError("잘못된 init 프레임")

    host = str(frame.get("host") or "").strip()
    if not host:
        raise PtyInitError("host 미지정")
    password = frame.get("password") or None
    private_key = frame.get("privateKey") or frame.get("private_key") or None
    if not password and not private_key:
        raise PtyInitError("password 또는 private_key 필요")

    try:
        port = int(frame.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    try:
        cols = int(frame.get("cols") or 120)
        rows = int(frame.get("rows") or 40)
    except (TypeError, ValueError):
        cols, rows = 120, 40

    return PtyInit(
        host=host,
        port=port,
        username=str(frame.get("username") or "root").strip() or "root",
        password=password,
        private_key=private_key,
        cols=cols,
        rows=rows,
        raw=frame,
    )


async def reject_init(websocket: WebSocket, reason: str, code: int = CLOSE_BAD_INIT) -> None:
    """init 실패를 터미널 화면에 한 줄로 알리고 닫는다."""
    try:
        await websocket.send_text(f"\r\n[{reason}]\r\n")
    except Exception:  # noqa: BLE001
        pass
    try:
        await websocket.close(code=code)
    except Exception:  # noqa: BLE001
        pass


async def bridge_pty(
    websocket: WebSocket,
    init: PtyInit,
    *,
    command: str | None = None,
    term: str = "xterm",
    connect_timeout: int = 12,
    max_session_seconds: int = MAX_SESSION_SECONDS,
    target_meta: dict | None = None,
    on_open: Callable[[], None] | None = None,
) -> float | None:
    """SSH PTY 셸을 열고 WebSocket 과 양방향으로 브리지한다.

    - `command` 가 있으면 셸 오픈 직후 한 줄로 전송한다(k9s 는 `exec k9s ...`,
      노드 터미널은 운영자가 지정한 접속 후 실행 명령). None 이면 로그인 셸 그대로.
    - PTY 단말 타입은 `xterm` 이 기본이다. 서버에 `xterm-256color` terminfo 가 없는
      최소/폐쇄망 환경에서도 셸아웃 에디터(vi/nano)의 방향키가 동작하도록 하기 위함.
    - paramiko 채널은 동기/블로킹이므로 recv/send 는 executor 로 오프로드한다.

    반환: 세션이 열렸으면 지속 시간(초), SSH 연결에 실패했으면 None.
    호출자는 이 값으로 close 감사 로그 기록 여부를 판단한다.
    """
    loop = asyncio.get_event_loop()
    client = None
    chan = None
    await websocket.send_text(f"\r\n\x1b[36m[{init.label} 접속 중…]\x1b[0m\r\n")

    try:
        target = init.target(**(target_meta or {}))
        try:
            client = await loop.run_in_executor(None, connect_client, target, connect_timeout)
            chan = await loop.run_in_executor(
                None,
                lambda: client.invoke_shell(
                    term=term,
                    width=max(20, init.cols),
                    height=max(5, init.rows),
                ),
            )
        except Exception as e:  # noqa: BLE001
            await websocket.send_text(
                f"\r\n\x1b[31m[SSH 접속 실패] {str(e)[:200]}\x1b[0m\r\n")
            await websocket.close(code=CLOSE_SSH_FAILED)
            return None

        chan.settimeout(0.1)
        if command:
            # 실패(명령 미설치 등) 시 원격 셸의 에러가 그대로 터미널에 흐른다.
            chan.send(f"{command}\n")

        started = time.time()
        if on_open is not None:
            on_open()

        def _read_chunk() -> str | None:
            """블로킹(0.1s) — 채널에서 읽어 반환. EOF/에러면 None, 데이터 없으면 ''."""
            try:
                data = chan.recv(65536)
            except socket.timeout:
                return ""
            except Exception:  # noqa: BLE001
                return None
            if not data:
                return None  # EOF — 원격 셸 종료
            return data.decode("utf-8", errors="replace")

        async def _pump_input():
            """브라우저 → PTY stdin / resize."""
            try:
                while True:
                    msg = await websocket.receive_text()
                    data: str | None = msg
                    if msg[:1] == "{":
                        try:
                            obj = json.loads(msg)
                            mtype = obj.get("type")
                            if mtype == "stdin":
                                data = obj.get("data", "")
                            elif mtype == "resize":
                                c = int(obj.get("cols") or 0)
                                r = int(obj.get("rows") or 0)
                                if c > 0 and r > 0:
                                    await loop.run_in_executor(
                                        None, lambda: chan.resize_pty(width=c, height=r))
                                data = None
                        except (ValueError, TypeError):
                            data = msg
                    if data:
                        await loop.run_in_executor(None, chan.send, data)
            except WebSocketDisconnect:
                pass
            except Exception:  # noqa: BLE001
                pass

        input_task = asyncio.create_task(_pump_input())
        try:
            while True:
                if time.time() - started > max_session_seconds:
                    await websocket.send_text("\r\n[세션 시간 초과 — 종료]\r\n")
                    break
                chunk = await loop.run_in_executor(None, _read_chunk)
                if chunk is None:
                    break  # 채널 종료
                if chunk:
                    await websocket.send_text(chunk)
                else:
                    await asyncio.sleep(0.02)  # busy-loop 방지
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001
            logger.warning("pty stream error (%s): %s", init.label, e)
        finally:
            input_task.cancel()
        return round(time.time() - started, 1)
    finally:
        if chan is not None:
            try:
                chan.close()
            except Exception:  # noqa: BLE001
                pass
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
