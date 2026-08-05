"""DB-free 단위 테스트 — Isilon NFS "선택 실행"(``run_selected_commands``).

mc 클라이언트처럼 등록된 명령 중 선택한 키만 실행하는 온디맨드 경로. 실제 SSH 접속 없이
``ssh_runner._build_client`` 를 모킹해 필터링/응답 매핑만 검증한다
(``test_bulk_exec_fetch_file.py`` 의 모킹 패턴과 동일).
"""
from unittest.mock import MagicMock

from app.models.isilon_server import IsilonCommand, IsilonServer
from app.services import isilon_service


def _server(**overrides) -> IsilonServer:
    s = IsilonServer(name="isilon-1", host="10.0.0.9", port=22, username="root")
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


def _cmd(key: str, command: str = "isi nfs exports list --format json") -> IsilonCommand:
    return IsilonCommand(
        key=key, label=key, section="custom", command=command,
        parse_mode="text", timeout_seconds=15, enabled=True,
        show_on_overview=True, sort_order=100, server_id=None,
    )


def test_unknown_keys_are_skipped_not_executed(monkeypatch):
    monkeypatch.setattr(isilon_service, "effective_commands", lambda db, server: [_cmd("exports")])
    server = _server()

    result = isilon_service.run_selected_commands(MagicMock(), server, ["exports", "does-not-exist"])

    assert result["skipped_keys"] == ["does-not-exist"]


def test_no_matching_keys_sets_connection_error_without_ssh(monkeypatch):
    monkeypatch.setattr(isilon_service, "effective_commands", lambda db, server: [_cmd("exports")])
    build_client = MagicMock()
    monkeypatch.setattr(isilon_service.ssh_runner, "_build_client", build_client)
    server = _server()

    result = isilon_service.run_selected_commands(MagicMock(), server, ["nope"])

    assert result["connection_ok"] is False
    assert result["connection_error"]
    assert result["results"] == []
    build_client.assert_not_called()


def test_missing_credentials_sets_connection_error(monkeypatch):
    monkeypatch.setattr(isilon_service, "effective_commands", lambda db, server: [_cmd("exports")])
    monkeypatch.setattr(
        isilon_service, "resolve_target",
        lambda server: isilon_service.ssh_runner.SSHTarget(
            host=server.host, port=22, username="root", password=None, private_key=None, name=server.name,
        ),
    )
    server = _server()

    result = isilon_service.run_selected_commands(MagicMock(), server, ["exports"])

    assert result["connection_ok"] is False
    assert "자격증명" in result["connection_error"]


def test_success_runs_only_selected_commands_in_order(monkeypatch):
    exports_cmd = _cmd("exports", "isi nfs exports list --format json")
    quotas_cmd = _cmd("quotas", "isi quota quotas list --format json")
    monkeypatch.setattr(
        isilon_service, "effective_commands",
        lambda db, server: [exports_cmd, quotas_cmd, _cmd("clients")],
    )
    monkeypatch.setattr(
        isilon_service, "resolve_target",
        lambda server: isilon_service.ssh_runner.SSHTarget(
            host=server.host, port=22, username="root", password="pw", private_key=None, name=server.name,
        ),
    )

    fake_client = MagicMock()

    def _exec_command(command, timeout=None, get_pty=False):
        stdout = MagicMock()
        stdout.read.return_value = f"ok:{command}".encode()
        stdout.channel.recv_exit_status.return_value = 0
        stderr = MagicMock()
        stderr.read.return_value = b""
        return MagicMock(), stdout, stderr

    fake_client.exec_command.side_effect = _exec_command
    monkeypatch.setattr(isilon_service.ssh_runner, "_build_client", lambda tgt, timeout: fake_client)

    server = _server()
    # 요청 배열 순서는 뒤섞였지만(quotas, exports) 결과는 항상 effective_commands() 순서(=화면
    # 표시 순서)를 따라야 한다.
    result = isilon_service.run_selected_commands(MagicMock(), server, ["quotas", "exports"])

    assert result["connection_ok"] is True
    assert result["connection_error"] is None
    assert [r["key"] for r in result["results"]] == ["exports", "quotas"]
    assert all(r["ok"] for r in result["results"])
    fake_client.close.assert_called_once()
