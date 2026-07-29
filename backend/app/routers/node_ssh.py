"""개별 노드 SSH 터미널 — 임의의 호스트에 로그인 셸을 열어 웹 터미널로 브리지.

k9s 콘솔(`k9s_ssh.py`)이 control-plane 의 `k9s` TUI 만 띄우는 것과 달리, 여기는
**아무 노드에나 붙는 범용 셸**이다. 대상 선택은 기존 base 툴을 그대로 재사용한다:
- 노드 목록: `GET /api/v1/clusters/{id}/node-list` (`bulk_exec.py`) — mc/bulk-exec 와 동일
- SSH 연결/호스트키: `services/ssh_runner`(TOFU) — bulk-exec/etcdctl/mc 와 동일
- PTY ↔ WebSocket 브리지: `services/ssh_pty` (k9s 콘솔과 공유)

엔드포인트:
- `POST /node-ssh/test`      — 연결/자격증명만 검증(명령 실행 없음). 일반 REST(operator).
- `WS  /node-ssh/session`    — 인터랙티브 셸. 전역 `_auth` 미적용이라 핸들러가 직접 토큰 검증.

UI-First: 접속 후 실행할 명령(`initialCommand`)·셸 종류·터미널 타입은 코드에 박지 않고
화면에서 입력받아 init 프레임으로 넘긴다(환경마다 sudo 정책·기본 셸이 다르므로).
셸을 얻은 사용자는 어차피 임의 명령을 칠 수 있으므로 initialCommand 는 권한을 넓히지
않는다 — 다만 무엇이 실행됐는지 감사 로그에 남긴다.

`PEP_NODE_SSH_ENABLED=false` 로 전역 비활성화 가능.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import SessionLocal, get_db
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.ssh_pty import (
    CLOSE_DISABLED,
    CLOSE_UNAUTHORIZED,
    PtyInitError,
    bridge_pty,
    env_flag_enabled,
    receive_init,
    reject_init,
    resolve_ws_user,
)
from app.services.ssh_runner import SSHTarget, test_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/node-ssh", tags=["node-ssh"])

# 터미널 타입 화이트리스트 — 서버에 없는 terminfo 를 요청하면 셸아웃 에디터가 깨진다.
_ALLOWED_TERMS = {"xterm", "xterm-256color", "vt100", "linux"}
_DEFAULT_TERM = "xterm"


def _node_ssh_enabled() -> bool:
    return env_flag_enabled("PEP_NODE_SSH_ENABLED", default=True)


# ── 연결 테스트 (REST) ───────────────────────────────────────────────────────

class NodeSshTestRequest(BaseModel):
    host: str = Field(..., min_length=1, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: Optional[str] = None
    private_key: Optional[str] = None
    connect_timeout: int = Field(default=8, ge=1, le=60)


class NodeSshTestResponse(BaseModel):
    host: str
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    duration_ms: int = 0
    error: Optional[str] = None


@router.post("/test", response_model=NodeSshTestResponse)
def test_node_ssh(
    body: NodeSshTestRequest,
    current_user: User = Depends(require_operator),
) -> NodeSshTestResponse:
    """터미널을 열기 전에 host/자격증명만 확인한다(명령 실행 없음).

    이 라우터는 WebSocket 때문에 전역 `_auth` 없이 마운트되므로 인증 의존성을
    엔드포인트에 직접 건다.
    """
    result = test_connection(
        SSHTarget(
            host=body.host.strip(),
            port=body.port,
            username=body.username.strip(),
            password=body.password or None,
            private_key=body.private_key or None,
        ),
        connect_timeout=body.connect_timeout,
    )
    return NodeSshTestResponse(
        host=result.host,
        status=result.status,
        duration_ms=result.duration_ms,
        error=result.error,
    )


# ── 인터랙티브 셸 (WebSocket) ────────────────────────────────────────────────

@router.websocket("/session")
async def node_ssh_terminal(
    websocket: WebSocket,
    token: str | None = None,
    cluster_id: str | None = None,
):
    """개별 노드 로그인 셸을 웹 터미널로 브리지.

    `cluster_id` 는 감사 로그의 맥락 표시에만 쓴다(클러스터 밖 관리 서버도 붙을 수
    있어야 하므로 필수가 아니다). 실제 대상은 init 프레임의 host 다.
    """
    db = SessionLocal()
    user: User | None = None
    duration: float | None = None
    label = ""
    cluster_name: str | None = None
    initial_command = ""
    node_name = ""
    try:
        if not _node_ssh_enabled():
            await websocket.close(code=CLOSE_DISABLED)
            return
        user = resolve_ws_user(token, db)
        if user is None:
            await websocket.close(code=CLOSE_UNAUTHORIZED)
            return

        cluster_uuid: UUID | None = None
        if cluster_id:
            try:
                cluster_uuid = UUID(cluster_id)
            except (ValueError, AttributeError):
                cluster_uuid = None
        if cluster_uuid is not None:
            cluster = db.query(Cluster).filter(Cluster.id == cluster_uuid).first()
            cluster_name = cluster.name if cluster else None

        await websocket.accept()

        try:
            init = await receive_init(websocket)
        except PtyInitError as e:
            await reject_init(websocket, str(e))
            return

        label = init.label
        node_name = str(init.raw.get("nodeName") or "").strip()[:128]
        initial_command = str(init.raw.get("initialCommand") or "").strip()
        term = str(init.raw.get("term") or _DEFAULT_TERM)
        if term not in _ALLOWED_TERMS:
            term = _DEFAULT_TERM

        def _log_open() -> None:
            audit_logger.record(
                db, action="node.ssh.open", actor=user, status="success",
                target_type="cluster" if cluster_uuid else "host",
                target_id=str(cluster_uuid) if cluster_uuid else init.host,
                details={
                    "cluster": cluster_name,
                    "host": label,
                    "node": node_name or None,
                    "initial_command": initial_command or None,
                },
            )

        duration = await bridge_pty(
            websocket,
            init,
            command=initial_command or None,
            term=term,
            target_meta={
                "name": node_name or None,
                "cluster_id": str(cluster_uuid) if cluster_uuid else None,
                "cluster_name": cluster_name,
            },
            on_open=_log_open,
        )
    finally:
        if user is not None and duration is not None:
            try:
                audit_logger.record(
                    db, action="node.ssh.close", actor=user, status="success",
                    target_type="host", target_id=label,
                    details={"host": label, "node": node_name or None,
                             "duration_seconds": duration},
                )
            except Exception:  # noqa: BLE001
                pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        db.close()
