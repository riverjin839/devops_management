"""k9s TUI 를 control-plane 서버에 SSH 로 접속해 웹 터미널로 스트리밍.

전제:
- 각 클러스터의 control-plane(master) 서버에 `k9s` 바이너리가 설치되어 있고, 해당
  서버 계정의 기본 kubeconfig(`~/.kube/config`) 로 클러스터에 접근 가능하다.
- 브라우저(xterm.js) ↔ FastAPI WebSocket ↔ paramiko PTY 브리지는 공용 유틸
  `services/ssh_pty` 가 담당한다(노드 SSH 터미널 `node_ssh.py` 와 공유).
  프로토콜(init/stdin/resize 프레임)과 보안 정책 상세는 그 모듈의 docstring 참고.

보안:
- WS 는 전역 `_auth` 가 적용되지 않으므로 핸들러 내부에서 직접 토큰을 검증하고,
  역할이 admin/operator 일 때만 accept 한다(viewer 차단). k8s_exec 와 동일 정책.
- 세션 open/close 를 감사 로그(`k9s.ssh.open` / `k9s.ssh.close`) 에 남긴다.
- SSH 인증정보는 이 세션에만 사용되고 DB 에 저장하지 않는다(etcdctl/bulk-exec 와 동일).
- `PEP_K9S_SSH_ENABLED=false` 로 전역 비활성화 가능.
- 실행 명령은 서버가 검증된 조각으로만 조립한다(namespace 정규식·readonly bool).
"""
from __future__ import annotations

import logging
import re
import shlex
from uuid import UUID

from fastapi import APIRouter, WebSocket

from app.database import SessionLocal
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.ssh_pty import (
    CLOSE_DISABLED,
    CLOSE_NOT_FOUND,
    CLOSE_UNAUTHORIZED,
    PtyInitError,
    bridge_pty,
    env_flag_enabled,
    receive_init,
    reject_init,
    resolve_ws_user,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k9s-ssh"])

_NS_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,62}$")  # k8s 네임스페이스 형식


def _k9s_enabled() -> bool:
    return env_flag_enabled("PEP_K9S_SSH_ENABLED", default=True)


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
    user: User | None = None
    duration: float | None = None
    host_label = ""
    try:
        if not _k9s_enabled():
            await websocket.close(code=CLOSE_DISABLED)
            return
        user = resolve_ws_user(token, db)
        if user is None:
            await websocket.close(code=CLOSE_UNAUTHORIZED)
            return
        cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if cluster is None:
            await websocket.close(code=CLOSE_NOT_FOUND)
            return

        await websocket.accept()

        try:
            init = await receive_init(websocket)
        except PtyInitError as e:
            await reject_init(websocket, str(e))
            return

        host_label = init.label
        namespace = init.raw.get("namespace") or None
        readonly = bool(init.raw.get("readonly") or False)
        run_cmd = _build_k9s_command(namespace, readonly, init.raw.get("extraFlags"))

        def _log_open() -> None:
            audit_logger.record(
                db, action="k9s.ssh.open", actor=user, status="success",
                target_type="cluster", target_id=str(cluster_id),
                details={"cluster": cluster.name, "host": host_label,
                         "namespace": namespace, "readonly": readonly},
            )

        duration = await bridge_pty(
            websocket,
            init,
            command=run_cmd,
            target_meta={
                "cluster_id": str(cluster_id),
                "cluster_name": cluster.name,
            },
            on_open=_log_open,
        )
    finally:
        if user is not None and duration is not None:
            try:
                audit_logger.record(
                    db, action="k9s.ssh.close", actor=user, status="success",
                    target_type="cluster", target_id=str(cluster_id),
                    details={"host": host_label, "duration_seconds": duration},
                )
            except Exception:  # noqa: BLE001
                pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        db.close()
