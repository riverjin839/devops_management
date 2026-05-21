"""kubectl exec 헬퍼 — pod exec 안전 실행 + 실패 시 manual command 안내 생성.

PSA restricted / distroless / 권한 부족 등의 케이스에서 raise 대신
(stdout, fallback_dict) tuple 반환. fallback_dict 가 None 이 아니면 실패.
"""
from __future__ import annotations

import logging
import shlex
from typing import Optional

from kubernetes import client
from kubernetes.stream import stream as k8s_stream

logger = logging.getLogger(__name__)


def make_manual_fallback(namespace: str, pod: str, command: list[str], reason: str) -> dict:
    """exec 실패 시 사용자에게 보여줄 manual command + 이유."""
    cmd_str = " ".join(shlex.quote(c) for c in command)
    return {
        "command": f"kubectl exec -n {namespace} {pod} -- {cmd_str}",
        "reason": reason[:300],
    }


def safe_pod_exec(
    v1: client.CoreV1Api,
    namespace: str,
    pod: str,
    command: list[str],
    *,
    container: Optional[str] = None,
    timeout: int = 5,
) -> tuple[Optional[str], Optional[dict]]:
    """K8s SDK 로 pod 안 명령 실행. 결과:
       (stdout_str, None)         — 성공
       (None, manual_fallback)    — 실패 (사용자에게 manual command 안내)
    """
    try:
        kwargs = dict(
            command=command,
            stderr=True, stdout=True, stdin=False, tty=False,
            _preload_content=True,
            _request_timeout=timeout,
        )
        if container:
            kwargs["container"] = container
        resp = k8s_stream(
            v1.connect_get_namespaced_pod_exec,
            pod, namespace, **kwargs,
        )
        if isinstance(resp, str) and resp.strip():
            return resp, None
        # 빈 응답 — 명령 없거나 silent failure 가능
        return resp or "", None
    except client.ApiException as e:
        status_code = getattr(e, "status", 0)
        reason = ""
        if status_code == 403:
            reason = "403 Forbidden — PSA restricted 또는 RBAC 권한 부족"
        elif status_code == 404:
            reason = "404 Not Found — pod 가 존재하지 않거나 container 없음"
        elif status_code in (400, 500):
            reason = f"K8s API {status_code} — 명령 또는 binary 누락 (distroless?)"
        else:
            reason = f"K8s API error {status_code}: {str(e)[:200]}"
        logger.warning("safe_pod_exec failed: ns=%s pod=%s cmd=%s err=%s",
                       namespace, pod, command, reason)
        return None, make_manual_fallback(namespace, pod, command, reason)
    except Exception as e:  # noqa: BLE001
        reason = f"exec 내부 오류: {str(e)[:200]}"
        logger.warning("safe_pod_exec exception: ns=%s pod=%s err=%s", namespace, pod, reason)
        return None, make_manual_fallback(namespace, pod, command, reason)
