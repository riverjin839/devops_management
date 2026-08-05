"""DB-free 단위 테스트 — SCP "다른 노드에서 불러오기" (bulk_exec_fetch_file).

실제 SSH 접속 없이 `fetch_remote_file` 을 모킹해 라우터의 검증·응답 매핑만
검증한다(k8s_job_cleanup 의 `_run_kubectl` 모킹 패턴과 동일).
"""
from unittest.mock import MagicMock

import pytest

import app.routers.bulk_exec as mod
from app.schemas.bulk_exec import FetchFileRequest
from app.services.ssh_runner import SSHResult


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
async def test_success_maps_content_and_size(monkeypatch):
    monkeypatch.setattr(mod, "fetch_remote_file", lambda *a, **kw: SSHResult(
        host="10.0.0.5", status="ok", exit_code=0,
        stdout="host-01\n", stderr="", duration_ms=12, error=None,
    ))

    res = await mod.bulk_exec_fetch_file(
        _payload(), request=None, db=MagicMock(), actor=_Actor(),
    )
    assert res.status == "ok"
    assert res.content == "host-01\n"
    assert res.size == len("host-01\n".encode("utf-8"))
    assert res.error is None


@pytest.mark.asyncio
async def test_failure_propagates_error_with_empty_content(monkeypatch):
    monkeypatch.setattr(mod, "fetch_remote_file", lambda *a, **kw: SSHResult(
        host="10.0.0.5", status="error", exit_code=None,
        stdout="", stderr="", duration_ms=5,
        error="파일을 찾을 수 없거나 읽을 권한이 없습니다: [Errno 2]",
    ))

    res = await mod.bulk_exec_fetch_file(
        _payload(), request=None, db=MagicMock(), actor=_Actor(),
    )
    assert res.status == "error"
    assert res.content == ""
    assert res.size == 0
    assert "찾을 수 없" in res.error
