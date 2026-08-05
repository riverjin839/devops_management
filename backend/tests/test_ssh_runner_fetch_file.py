"""DB/네트워크 없는 단위 테스트 — ssh_runner.fetch_remote_file 의 step/command 계측.

paramiko 실제 접속 대신 `_build_client` 를 모킹한 가짜 SSHClient/SFTPClient 로
연결·stat·읽기 각 단계에서 steps/commands 가 정확히 남는지 검증한다. 라우터
레벨 매핑은 test_bulk_exec_fetch_file.py 가 별도로 검증하므로, 여기서는 이
함수 자체의 단계별 성공/실패 분기(연결 실패는 커버 안 함 — _build_client 모킹이라
paramiko 예외 재현은 라우터 테스트의 관심사 밖)만 다룬다.
"""
import io
from unittest.mock import MagicMock

import app.services.ssh_runner as mod
from app.services.ssh_runner import SSHTarget


def _target() -> SSHTarget:
    return SSHTarget(host="10.0.0.5", port=22, username="root", password="pw")


def _fake_client_with_sftp(sftp: MagicMock) -> MagicMock:
    client = MagicMock()
    client.open_sftp.return_value = sftp
    return client


def test_success_records_three_success_steps_and_commands(monkeypatch):
    sftp = MagicMock()
    sftp.stat.return_value = MagicMock(st_size=13)
    sftp.file.return_value.__enter__.return_value = io.BytesIO(b"hello world!\n")
    monkeypatch.setattr(mod, "_build_client", lambda *a, **kw: _fake_client_with_sftp(sftp))

    out = mod.fetch_remote_file(_target(), "/etc/hostname", connect_timeout=5)

    assert out.result.status == "ok"
    assert out.result.stdout == "hello world!\n"
    assert [s["id"] for s in out.steps] == ["connect", "stat", "read"]
    assert all(s["status"] == "success" for s in out.steps)
    assert out.steps[1]["metrics"] == {"size_bytes": 13}
    assert [c["kind"] for c in out.commands] == ["ssh", "sftp", "sftp"]


def test_stat_not_found_fails_stat_step_and_stops(monkeypatch):
    sftp = MagicMock()
    sftp.stat.side_effect = IOError("[Errno 2] No such file")
    monkeypatch.setattr(mod, "_build_client", lambda *a, **kw: _fake_client_with_sftp(sftp))

    out = mod.fetch_remote_file(_target(), "/no/such/file", connect_timeout=5)

    assert out.result.status == "error"
    assert "찾을 수 없" in out.result.error
    ids = [s["id"] for s in out.steps]
    assert ids == ["connect", "stat"]          # read 단계는 도달하지 않음
    assert out.steps[-1]["status"] == "failed"
    assert out.commands[-1]["kind"] == "sftp"
    assert out.commands[-1]["exit_code"] is None


def test_oversized_file_fails_read_step_without_reading(monkeypatch):
    sftp = MagicMock()
    sftp.stat.return_value = MagicMock(st_size=10 * 1024 * 1024)  # 10MB > 2MB 상한
    monkeypatch.setattr(mod, "_build_client", lambda *a, **kw: _fake_client_with_sftp(sftp))

    out = mod.fetch_remote_file(_target(), "/big/file", connect_timeout=5)

    assert out.result.status == "error"
    assert "너무 큽니다" in out.result.error
    assert out.steps[-1]["id"] == "read"
    assert out.steps[-1]["status"] == "failed"
    sftp.file.assert_not_called()               # 용량 초과면 실제 읽기 시도조차 안 함


def test_non_utf8_content_fails_read_step(monkeypatch):
    sftp = MagicMock()
    sftp.stat.return_value = MagicMock(st_size=4)
    sftp.file.return_value.__enter__.return_value = io.BytesIO(b"\xff\xfe\x00\x01")
    monkeypatch.setattr(mod, "_build_client", lambda *a, **kw: _fake_client_with_sftp(sftp))

    out = mod.fetch_remote_file(_target(), "/binary/file", connect_timeout=5)

    assert out.result.status == "error"
    assert "UTF-8" in out.result.error
    assert out.steps[-1]["id"] == "read"
    assert out.steps[-1]["status"] == "failed"
