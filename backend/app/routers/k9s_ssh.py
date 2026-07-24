"""k9s TUI 를 control-plane 서버에 SSH 로 접속해 웹 터미널로 스트리밍.

전제:
- 각 클러스터의 control-plane(master) 서버에 `k9s` 바이너리가 설치되어 있고, 해당
  서버 계정의 기본 kubeconfig(`~/.kube/config`) 로 클러스터에 접근 가능하다.
- 브라우저(xterm.js) ↔ FastAPI WebSocket ↔ paramiko PTY(invoke_shell) 를 브리지한다.
  paramiko 채널은 동기/블로킹이므로 블로킹 recv 를 executor 로 오프로드한다.

프로토콜:
- 클라이언트는 `?token=<jwt>` 로 연결한다(WS 는 Authorization 헤더 불가).
- accept 직후 클라이언트가 **init 프레임** 을 1회 보낸다:
    {"type":"init","host":"10.0.0.11","port":22,"username":"root",
     "password":"...","privateKey":"...","cols":120,"rows":40,
     "namespace":"kube-system","readonly":false}
  password/privateKey 는 URL 이 아닌 이 프레임으로만 받는다(로그/히스토리 노출 방지).
- 이후 프레임: {"type":"stdin","data":"..."} / {"type":"resize","cols":..,"rows":..}

보안:
- WS 는 전역 `_auth` 가 적용되지 않으므로 핸들러 내부에서 직접 토큰을 검증하고,
  역할이 admin/operator 일 때만 accept 한다(viewer 차단). k8s_exec 와 동일 정책.
- 세션 open/close 를 감사 로그(`k9s.ssh.open` / `k9s.ssh.close`) 에 남긴다.
- SSH 인증정보는 이 세션에만 사용되고 DB 에 저장하지 않는다(etcdctl/bulk-exec 와 동일).
- `PEP_K9S_SSH_ENABLED=false` 로 전역 비활성화 가능.
- 실행 명령은 서버가 검증된 조각으로만 조립한다(namespace 정규식·readonly bool).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import socket
import time
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth.security import decode_access_token
from app.database import SessionLocal
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.ssh_runner import SSHTarget, connect_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k9s-ssh"])

_ALLOWED_ROLES = {"admin", "operator"}
_MAX_SESSION_SECONDS = 60 * 60  # 1시간 상한 — 좀비 세션 방지
_NS_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,62}$")  # k8s 네임스페이스 형식


def _k9s_enabled() -> bool:
    return os.getenv("PEP_K9S_SSH_ENABLED", "true").lower() not in ("false", "0", "no")


def _resolve_user(token: str | None, db) -> User | None:
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
    if effective_role not in _ALLOWED_ROLES:
        return None
    return user


def _build_k9s_command(namespace: str | None, readonly: bool, extra: str | None) -> str:
    """검증된 조각으로만 k9s 실행 명령을 조립한다.

    `exec` 로 로그인 셸을 k9s 로 치환 → k9s 종료 시 채널도 EOF 로 닫힌다.

    앞단(prelude)에서 편집 셸아웃 환경을 보장한다:
    - k9s 의 `e`(edit)/`v`(view) 등은 kubectl edit 처럼 `$KUBE_EDITOR`/`$EDITOR`
      로 **같은 터미널에 에디터를 셸아웃**한다. 이 값이 없거나 서버에 에디터가 없으면
      셸아웃이 멈춰(hang) 화면이 얼어붙은 것처럼 보인다. 그래서 운영자가 이미 지정한
      `KUBE_EDITOR`/`EDITOR` 는 존중하되, 없으면 웹 터미널에서 종료법이 화면에 보이는
      `nano` 를 우선 선택하고(없으면 `vi`) 확정한다.
    - `TERM` 을 **`xterm`** 으로 고정한다. k9s 자체는 tcell 내장 terminfo 로 잘 뜨지만,
      셸아웃한 에디터는 **시스템 terminfo(ncurses)** 를 쓰므로 서버에 `xterm-256color`
      terminfo 가 없으면(최소/폐쇄망 서버에서 흔함) 방향키 이스케이프를 해석 못 해
      **에디터 커서가 안 먹는다**. `xterm` 은 거의 모든 서버에 존재해 안전하다.
      k9s 색상은 `COLORTERM=truecolor` 로 유지된다(tcell 은 COLORTERM 으로 풀컬러 판단).
    prelude 문자열은 서버가 고정한 리터럴이며 사용자 입력이 섞이지 않는다.
    """
    parts = ["k9s"]
    if namespace and _NS_RE.match(namespace):
        parts += ["-n", namespace]
    if readonly:
        parts.append("--readonly")
    # extra 는 화이트리스트 플래그만 허용(공백 구분). 값 인자는 받지 않는다.
    _ALLOWED_FLAGS = {"--readonly", "--headless", "--crumbsless", "--logoless"}
    for tok in (extra or "").split():
        if tok in _ALLOWED_FLAGS and tok not in parts:
            parts.append(tok)
    k9s_cmd = " ".join(shlex.quote(p) for p in parts)
    prelude = (
        'export TERM=xterm; '
        'export COLORTERM="${COLORTERM:-truecolor}"; '
        'export KUBE_EDITOR="${KUBE_EDITOR:-${EDITOR:-$(command -v nano || command -v vi || echo vi)}}"; '
        'export EDITOR="$KUBE_EDITOR"; '
    )
    return f"{prelude}exec {k9s_cmd}"


@router.websocket("/{cluster_id}/k9s")
async def k9s_terminal(websocket: WebSocket, cluster_id: UUID, token: str | None = None):
    db = SessionLocal()
    client = None
    chan = None
    user: User | None = None
    started = 0.0
    host_label = ""
    try:
        if not _k9s_enabled():
            await websocket.close(code=4403)
            return
        user = _resolve_user(token, db)
        if user is None:
            await websocket.close(code=4401)  # unauthorized
            return
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            await websocket.close(code=4404)
            return

        await websocket.accept()

        # ── init 프레임 수신 (SSH 자격증명 + 터미널 크기) ──────────────────────
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=60)
            init = json.loads(raw)
        except (asyncio.TimeoutError, ValueError, TypeError):
            await websocket.send_text("\r\n[init 프레임 없음 — 종료]\r\n")
            await websocket.close(code=1008)
            return
        if init.get("type") != "init":
            await websocket.send_text("\r\n[잘못된 init 프레임]\r\n")
            await websocket.close(code=1008)
            return

        host = str(init.get("host") or "").strip()
        if not host:
            await websocket.send_text("\r\n[host 미지정]\r\n")
            await websocket.close(code=1008)
            return
        port = int(init.get("port") or 22)
        username = str(init.get("username") or "root").strip() or "root"
        password = init.get("password") or None
        private_key = init.get("privateKey") or init.get("private_key") or None
        if not password and not private_key:
            await websocket.send_text("\r\n[password 또는 private_key 필요]\r\n")
            await websocket.close(code=1008)
            return
        cols = int(init.get("cols") or 120)
        rows = int(init.get("rows") or 40)
        namespace = init.get("namespace") or None
        readonly = bool(init.get("readonly") or False)
        run_cmd = _build_k9s_command(namespace, readonly, init.get("extraFlags"))
        host_label = f"{username}@{host}:{port}"

        target = SSHTarget(
            host=host, port=port, username=username,
            password=password, private_key=private_key,
        )

        loop = asyncio.get_event_loop()
        await websocket.send_text(f"\r\n\x1b[36m[{host_label} 접속 중…]\x1b[0m\r\n")

        # ── SSH 연결 + PTY 셸 오픈 (블로킹 → executor) ─────────────────────────
        try:
            client = await loop.run_in_executor(None, connect_client, target, 12)
            chan = await loop.run_in_executor(
                None,
                lambda: client.invoke_shell(
                    # PTY 단말 타입도 xterm 으로 요청 — 셸아웃 에디터의 terminfo 호환성
                    # 확보(prelude 의 TERM=xterm 과 일치). k9s 색상은 COLORTERM 로 유지.
                    term="xterm", width=max(20, cols), height=max(5, rows),
                ),
            )
        except Exception as e:  # noqa: BLE001
            await websocket.send_text(f"\r\n\x1b[31m[SSH 접속 실패] {str(e)[:200]}\x1b[0m\r\n")
            await websocket.close(code=1011)
            return

        chan.settimeout(0.1)
        # k9s 실행 — exec 로 셸을 치환. 실패(미설치) 시 원격 셸의 에러가 그대로 흐른다.
        chan.send(f"{run_cmd}\n")

        started = time.time()
        audit_logger.record(
            db, action="k9s.ssh.open", actor=user, status="success",
            target_type="cluster", target_id=str(cluster_id),
            details={"cluster": cluster.name, "host": host_label,
                     "namespace": namespace, "readonly": readonly},
        )

        def _read_chunk() -> str | None:
            """블로킹(0.1s) — 채널에서 읽어 반환. EOF/에러면 None, 데이터 없으면 ''."""
            try:
                data = chan.recv(65536)
            except socket.timeout:
                return ""
            except Exception:  # noqa: BLE001
                return None
            if not data:
                return None  # EOF — 원격 k9s 종료
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
                if time.time() - started > _MAX_SESSION_SECONDS:
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
            logger.warning("k9s stream error: %s", e)
        finally:
            input_task.cancel()
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
        if user is not None and started:
            try:
                audit_logger.record(
                    db, action="k9s.ssh.close", actor=user, status="success",
                    target_type="cluster", target_id=str(cluster_id),
                    details={"host": host_label,
                             "duration_seconds": round(time.time() - started, 1)},
                )
            except Exception:  # noqa: BLE001
                pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        db.close()
