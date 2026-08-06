"""cert_expiry 체커 단위 테스트 — 클러스터/DB 불필요.

배경: "kubeadm certs check-expiration 실행 에러 .. 여전히 상세로그가 안나옴" 리포트.
실패 시 message 가 고정 문구("권한 또는 바이너리 부재")라 실제 stderr(예: 표준
kube-apiserver 이미지에 kubeadm 바이너리가 없어 나는 "executable file not found")가
details 에만 묻혀 있었다. message 자체에 stderr 발췌를 담아 셀 툴팁/실행 목록에서도
바로 보이는지 검증한다.
"""
from types import SimpleNamespace as NS

from app.models import StatusEnum
from app.services.deep_checkers.base import DeepCheckContext
from app.services.deep_checkers.cert_expiry_checker import CertExpiryChecker


def _running_pod(name: str) -> NS:
    return NS(metadata=NS(name=name), status=NS(phase="Running"))


def test_kubeadm_exec_failure_surfaces_stderr_in_message(monkeypatch):
    checker = CertExpiryChecker()
    monkeypatch.setattr(
        CertExpiryChecker, "_v1",
        lambda self, ctx: NS(list_namespaced_pod=lambda **kw: NS(items=[_running_pod("kube-apiserver-node1")])),
    )
    stderr = (
        'OCI runtime exec failed: exec failed: unable to start container process: '
        'exec: "kubeadm": executable file not found in $PATH: unknown'
    )
    monkeypatch.setattr(
        CertExpiryChecker, "_kubectl",
        lambda self, ctx, *args, **kw: NS(returncode=126, stdout="", stderr=stderr),
    )

    out = checker.safe_run(DeepCheckContext(thresholds={}, params={}))

    assert out.status == StatusEnum.pending
    assert "kubeadm" in out.message
    assert "executable file not found" in out.message, out.message
    assert out.details["stderr"] == stderr
    assert out.details["returncode"] == 126


def test_kubeadm_exec_failure_falls_back_to_exit_code_when_no_output(monkeypatch):
    checker = CertExpiryChecker()
    monkeypatch.setattr(
        CertExpiryChecker, "_v1",
        lambda self, ctx: NS(list_namespaced_pod=lambda **kw: NS(items=[_running_pod("kube-apiserver-node1")])),
    )
    monkeypatch.setattr(
        CertExpiryChecker, "_kubectl",
        lambda self, ctx, *args, **kw: NS(returncode=1, stdout="", stderr=""),
    )

    out = checker.safe_run(DeepCheckContext(thresholds={}, params={}))

    assert out.status == StatusEnum.pending
    assert "exit code 1" in out.message


def test_kubeadm_success_reports_min_residual_days(monkeypatch):
    checker = CertExpiryChecker()
    monkeypatch.setattr(
        CertExpiryChecker, "_v1",
        lambda self, ctx: NS(list_namespaced_pod=lambda **kw: NS(items=[_running_pod("kube-apiserver-node1")])),
    )
    stdout = (
        "CERTIFICATE                EXPIRES                  RESIDUAL TIME\n"
        "admin.conf                 Aug 12, 2027 10:11 UTC   362d\n"
        "apiserver                  Sep 01, 2026 10:11 UTC   26d\n"
    )
    monkeypatch.setattr(
        CertExpiryChecker, "_kubectl",
        lambda self, ctx, *args, **kw: NS(returncode=0, stdout=stdout, stderr=""),
    )

    out = checker.safe_run(DeepCheckContext(
        thresholds={"warning_days": 30, "critical_days": 7}, params={},
    ))

    assert out.status == StatusEnum.warning
    assert out.details["min_residual_days"] == 26
