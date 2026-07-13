"""Pod exec 인터랙티브 터미널 (WebSocket).

Lens 의 Pod Shell 에 대응. 브라우저 ↔ FastAPI WebSocket ↔ kubernetes SDK exec
스트림을 브리지한다. kubernetes 파이썬 SDK 의 exec WSClient 는 동기/블로킹이므로
블로킹 호출을 executor 로 오프로드한다.

보안:
- WS 는 전역 `_auth`(Authorization 헤더) 가 적용되지 않으므로 **핸들러 내부에서 직접**
  토큰을 검증한다. 토큰은 query param 으로 전달받아 `decode_access_token` 으로 확인하고,
  역할이 admin/operator 일 때만 accept 한다(viewer 차단).
- 세션 open/close 를 감사 로그(`k8s.exec.open` / `k8s.exec.close`) 에 남긴다.
- `PEP_K8S_EXEC_ENABLED=false` 로 전역 비활성화 가능.
- 실제 exec 권한은 kubeconfig 의 `pods/exec` RBAC 가 최종 결정.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from kubernetes import client as k8s_client, config as k8s_config
from kubernetes.stream import stream as k8s_stream

from app.auth.security import decode_access_token
from app.database import SessionLocal
from app.models import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k8s-exec"])

_ALLOWED_ROLES = {"admin", "operator"}
_MAX_SESSION_SECONDS = 60 * 60  # 1시간 상한 — 좀비 세션 방지


def _exec_enabled() -> bool:
    return (os.getenv("PEP_K8S_EXEC_ENABLED", "true").lower() not in ("false", "0", "no"))


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


@router.websocket("/{cluster_id}/exec")
async def pod_exec(
    websocket: WebSocket,
    cluster_id: UUID,
    namespace: str,
    pod: str,
    container: str | None = None,
    command: str = "/bin/sh",
    token: str | None = None,
):
    db = SessionLocal()
    try:
        if not _exec_enabled():
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
        kc = ensure_kubeconfig_file(cluster)
        if not kc or not os.path.exists(kc):
            await websocket.close(code=4422)
            return

        await websocket.accept()

        # exec 셸 — bash 우선 시도, 실패 시 sh. 단순화를 위해 전달받은 command 사용.
        cmd_list = [command] if command else ["/bin/sh"]
        try:
            api_client = k8s_config.new_client_from_config(config_file=kc)
            core_v1 = k8s_client.CoreV1Api(api_client)
            resp = k8s_stream(
                core_v1.connect_get_namespaced_pod_exec,
                pod,
                namespace,
                container=container or None,
                command=cmd_list,
                stderr=True,
                stdin=True,
                stdout=True,
                tty=True,
                _preload_content=False,
            )
        except Exception as e:  # noqa: BLE001
            await websocket.send_text(f"\r\n[exec 시작 실패] {str(e)[:200]}\r\n")
            await websocket.close(code=1011)
            return

        audit_logger.record(
            db, action="k8s.exec.open", actor=user, status="success",
            target_type="k8s.pod", target_id=f"{namespace}/{pod}",
            details={"cluster_id": str(cluster_id), "cluster": cluster.name,
                     "container": container, "command": cmd_list},
        )
        started = time.time()
        loop = asyncio.get_event_loop()

        def _read_chunk() -> str | None:
            """블로킹 — k8s 소켓에서 stdout/stderr 를 읽어 합쳐 반환. 닫혔으면 None."""
            if not resp.is_open():
                return None
            try:
                resp.update(timeout=1)
            except Exception:  # noqa: BLE001
                return None
            data = ""
            try:
                if resp.peek_stdout():
                    data += resp.read_stdout()
                if resp.peek_stderr():
                    data += resp.read_stderr()
            except Exception:  # noqa: BLE001
                return None
            return data

        _RESIZE_CHANNEL = 4  # K8s exec 프로토콜의 resize 채널

        async def _pump_input():
            """브라우저 → pod stdin / resize.

            xterm 클라이언트는 JSON 프레임(`{"type":"stdin"|"resize",...}`)을 보낸다.
            JSON 이 아닌 프레임은 통째로 stdin 취급 (구 라인 기반 클라이언트 하위호환).
            """
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
                                cols = int(obj.get("cols") or 0)
                                rows = int(obj.get("rows") or 0)
                                if cols > 0 and rows > 0:
                                    payload = json.dumps({"Width": cols, "Height": rows})
                                    await loop.run_in_executor(
                                        None, resp.write_channel, _RESIZE_CHANNEL, payload)
                                data = None
                        except (ValueError, TypeError):
                            data = msg  # JSON 아님 → stdin
                    if data:
                        await loop.run_in_executor(None, resp.write_stdin, data)
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
                    break  # 소켓 종료
                if chunk:
                    await websocket.send_text(chunk)
                else:
                    await asyncio.sleep(0.02)  # busy-loop 방지
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001
            logger.warning("exec stream error: %s", e)
        finally:
            input_task.cancel()
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass
            audit_logger.record(
                db, action="k8s.exec.close", actor=user, status="success",
                target_type="k8s.pod", target_id=f"{namespace}/{pod}",
                details={"cluster_id": str(cluster_id), "duration_seconds": round(time.time() - started, 1)},
            )
            try:
                await websocket.close()
            except Exception:  # noqa: BLE001
                pass
    finally:
        db.close()
