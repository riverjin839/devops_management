"""hubble-relay 확인 실패(RBAC 거부 등)를 "미설치"와 구분한다(D-173 잔여)."""
from types import SimpleNamespace

from app.services import cilium_trace_service as svc


def _run(rc: int, stdout: str = "", stderr: str = ""):
    def fake(cmd, **kw):
        if "version" in cmd:
            return SimpleNamespace(returncode=0, stdout="Client: 1.15.0\n", stderr="")
        return SimpleNamespace(returncode=rc, stdout=stdout, stderr=stderr)
    return fake


def _agents(monkeypatch):
    agent = SimpleNamespace(pod_name="cilium-abc", ready=True, node_name="n1")
    monkeypatch.setattr(svc, "list_agents", lambda kc, namespace="kube-system": ([agent], None))


def test_relay_installed(monkeypatch):
    _agents(monkeypatch)
    monkeypatch.setattr(svc.subprocess, "run", _run(0, "service/hubble-relay\n"))
    out = svc.detect_status("/tmp/kc")
    assert out["hubble_relay_installed"] is True and out["hubble_relay_error"] is None


def test_relay_not_found_is_not_installed(monkeypatch):
    _agents(monkeypatch)
    monkeypatch.setattr(svc.subprocess, "run", _run(1, stderr='Error from server (NotFound): services "hubble-relay" not found'))
    out = svc.detect_status("/tmp/kc")
    assert out["hubble_relay_installed"] is False and out["hubble_relay_error"] is None


def test_relay_forbidden_is_check_failure(monkeypatch):
    _agents(monkeypatch)
    monkeypatch.setattr(svc.subprocess, "run", _run(1, stderr='Error from server (Forbidden): services "hubble-relay" is forbidden'))
    out = svc.detect_status("/tmp/kc")
    assert out["hubble_relay_installed"] is False and "Forbidden" in out["hubble_relay_error"]
