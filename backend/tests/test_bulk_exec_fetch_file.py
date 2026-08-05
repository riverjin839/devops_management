"""DB-free 단위 테스트 — SCP "다른 노드에서 불러오기" (bulk_exec_fetch_file).

실제 SSH 접속 없이 `fetch_remote_file` 을 모킹해 라우터의 검증·응답 매핑만
검증한다(k8s_job_cleanup 의 `_run_kubectl` 모킹 패턴과 동일).
"""
from unittest.mock import MagicMock

import pytest

import app.routers.bulk_exec as mod
from app.schemas.bulk_exec import FetchFileRequest
from app.services.ssh_runner import FetchFileResult, SSHResult


class _Actor:
    id = "tester-id"
    username = "tester"
    role = "operator"


def _payload(**overrides) -> FetchFileRequest:
    data = dict(host="10.0.0.5", port=22, username="root", password="pw",
                remote_path="/etc/hostname", connect_timeout=8)
    data.update(overrides)
    return FetchFileRequest(**data)


@pytest.mark.asyncio
async def test_missing_credential_raises_422():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await mod.bulk_exec_fetch_file(
            _payload(password=None), request=None, db=MagicMock(), actor=_Actor(),
        )
    assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_success_maps_content_size_and_steps(monkeypatch):
    monkeypatch.setattr(mod, "fetch_remote_file", lambda *a, **kw: FetchFileResult(
        result=SSHResult(
            host="10.0.0.5", status="ok", exit_code=0,
            stdout="host-01\n", stderr="", duration_ms=12, error=None,
        ),
        steps=[
            {"id": "connect", "label": "SSH 연결", "status": "success", "detail": "root@10.0.0.5:22",
             "metrics": {}, "started_ms": 0, "duration_ms": 5},
            {"id": "stat", "label": "원격 파일 확인", "status": "success", "detail": "/etc/hostname (8 bytes)",
             "metrics": {"size_bytes": 8}, "started_ms": 5, "duration_ms": 2},
            {"id": "read", "label": "파일 읽기", "status": "success", "detail": "8 bytes 읽음",
             "metrics": {}, "started_ms": 7, "duration_ms": 1},
        ],
        commands=[
            {"kind": "ssh", "command": "ssh root@10.0.0.5:22", "exit_code": 0, "duration_ms": 5,
             "stdout": "", "stderr": "", "truncated": False},
        ],
    ))

    res = await mod.bulk_exec_fetch_file(
        _payload(), request=None, db=MagicMock(), actor=_Actor(),
    )
    assert res.status == "ok"
    assert res.content == "host-01\n"
    assert res.size == len("host-01\n".encode("utf-8"))
    assert res.error is None
    assert [s["id"] for s in res.steps] == ["connect", "stat", "read"]
    assert res.commands[0]["kind"] == "ssh"


@pytest.mark.asyncio
async def test_failure_propagates_error_and_step_detail_with_empty_content(monkeypatch):
    monkeypatch.setattr(mod, "fetch_remote_file", lambda *a, **kw: FetchFileResult(
        result=SSHResult(
            host="10.0.0.5", status="error", exit_code=None,
            stdout="", stderr="", duration_ms=5,
            error="파일을 찾을 수 없거나 읽을 권한이 없습니다: [Errno 2]",
        ),
        steps=[
            {"id": "connect", "label": "SSH 연결", "status": "success", "detail": "root@10.0.0.5:22",
             "metrics": {}, "started_ms": 0, "duration_ms": 5},
            {"id": "stat", "label": "원격 파일 확인", "status": "failed",
             "detail": "경로를 찾을 수 없거나 읽을 권한이 없습니다: [Errno 2]",
             "metrics": {}, "started_ms": 5, "duration_ms": 3},
        ],
        commands=[
            {"kind": "sftp", "command": "sftp stat /etc/hostname", "exit_code": None, "duration_ms": 3,
             "stdout": "", "stderr": "[Errno 2] No such file", "truncated": False},
        ],
    ))

    res = await mod.bulk_exec_fetch_file(
        _payload(), request=None, db=MagicMock(), actor=_Actor(),
    )
    assert res.status == "error"
    assert res.content == ""
    assert res.size == 0
    assert "찾을 수 없" in res.error
    assert res.steps[-1]["status"] == "failed"
    assert res.commands[-1]["kind"] == "sftp"
