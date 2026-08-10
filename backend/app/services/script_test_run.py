"""스크립트 라이브러리 "테스트 실행" — 저장 전 초안도 즉시 검증할 수 있게 한다.

kind 별 분기:
  - shell            → SSH 로 원격 실행 (``ssh_runner.run_bulk`` 재사용)
  - ansible_playbook → ansible-runner 재사용 (``playbook_executor.run_playbook``)
  - python           → 아직 미지원. 대상 클러스터의 일회용 K8s Job 실행기는 Phase 2
                        구현 예정(설계 문서 §4.4) — 지금은 명확한 사유와 함께 거부한다.

자격증명은 절대 영속화하지 않는다(UI-First 원칙) — 이 모듈은 요청 스코프에서만 다룬다.
결과도 ``ExecutableScriptVersion`` 이나 다른 테이블에 쌓지 않는다(테스트이지 실제
잡이 아니므로 응답으로만 반환 — 설계 문서 §4.3).
"""
from __future__ import annotations

import asyncio
import shlex
import time
from typing import Any, Optional

from app.config import settings
from app.schemas.executable_script import ScriptTestRunTarget
from app.services.playbook_executor import run_playbook
from app.services.ssh_runner import SSHTarget, run_bulk

_OUTPUT_EXCERPT_CHARS = 2000


class ScriptTestRunError(Exception):
    """test-run 을 아예 시작할 수 없는 입력 오류 — 라우터가 400 으로 변환."""


def _require_ssh_target(target: ScriptTestRunTarget) -> SSHTarget:
    if not target.host:
        raise ScriptTestRunError("target.host 가 필요합니다 (kind=ssh).")
    if not target.password and not target.private_key:
        raise ScriptTestRunError("target.password 또는 target.private_key 중 하나는 필수입니다.")
    return SSHTarget(
        host=target.host, port=target.port, username=target.username,
        password=target.password, private_key=target.private_key,
    )


async def run_shell_test(content: str, target: ScriptTestRunTarget) -> dict[str, Any]:
    ssh_target = _require_ssh_target(target)
    command = f"bash -lc {shlex.quote(content)}"

    results = await run_bulk(
        [ssh_target], action="ssh", command=command, mode="sequential",
        connect_timeout=min(settings.check_timeout_seconds, 10),
        exec_timeout=settings.check_timeout_seconds, parallelism=1,
    )
    r = results[0]

    step = {
        "id": "ssh_exec", "label": "SSH 접속·실행",
        "status": "success" if r.status == "ok" else "failed",
        "detail": (
            f"{ssh_target.username}@{ssh_target.host} — {r.status}"
            + (f" (exit {r.exit_code})" if r.exit_code is not None else "")
        ),
        "started_ms": 0, "duration_ms": r.duration_ms,
    }
    command_rec = {
        "kind": "ssh", "command": command, "exit_code": r.exit_code,
        "duration_ms": r.duration_ms,
        "stdout": (r.stdout or "")[:_OUTPUT_EXCERPT_CHARS],
        "stderr": (r.stderr or "")[:_OUTPUT_EXCERPT_CHARS],
        "truncated": len(r.stdout or "") > _OUTPUT_EXCERPT_CHARS,
    }
    return {
        "status": r.status, "steps": [step], "commands": [command_rec],
        "stdout": r.stdout or "", "stderr": r.stderr or "",
        "exit_code": r.exit_code, "duration_ms": r.duration_ms, "error": r.error,
    }


async def run_ansible_test(
    content: str,
    inventory_content: Optional[str],
    params: Optional[dict],
    target: ScriptTestRunTarget,
) -> dict[str, Any]:
    inventory_hosts: Optional[list[str]] = None
    extra_vars: dict[str, Any] = dict(params or {})

    if not inventory_content:
        if target.kind == "ssh" and target.host:
            inventory_hosts = [target.host]
            extra_vars.setdefault("ansible_user", target.username)
            if target.password:
                extra_vars.setdefault("ansible_ssh_pass", target.password)
        else:
            raise ScriptTestRunError(
                "inventory_content 가 없으면 target(kind=ssh, host) 로부터 자동 생성합니다 — "
                "인벤토리를 직접 입력하거나 host 를 지정해주세요."
            )

    t0 = time.time()
    result = await asyncio.to_thread(
        run_playbook,
        playbook_content=content,
        inventory_content=inventory_content,
        inventory_hosts=inventory_hosts,
        extra_vars=extra_vars,
        ssh_private_key=target.private_key,
        timeout=settings.check_timeout_seconds,
    )
    duration_ms = result.duration_ms or int((time.time() - t0) * 1000)
    ok = result.status == "healthy"

    step = {
        "id": "ansible_run", "label": "ansible-playbook 실행",
        "status": "success" if ok else "failed",
        "detail": result.message[:200], "started_ms": 0, "duration_ms": duration_ms,
    }
    command_rec = {
        "kind": "ansible", "command": "ansible-playbook (임시 파일에서 실행)",
        "exit_code": 0 if ok else 1, "duration_ms": duration_ms,
        "stdout": result.raw_output[:_OUTPUT_EXCERPT_CHARS], "stderr": "",
        "truncated": len(result.raw_output) > _OUTPUT_EXCERPT_CHARS,
    }
    return {
        "status": "ok" if ok else "error",
        "steps": [step], "commands": [command_rec],
        "stdout": result.raw_output, "stderr": "",
        "exit_code": 0 if ok else 1, "duration_ms": duration_ms,
        "error": None if ok else result.message,
    }
