"""DB-free 단위 테스트 — cert_expiry_checker.py.

kube-apiserver 공식 이미지는 distroless 라 pod exec 이 실패하는 경우가 흔한데,
그 실패가 steps/commands 에 상세히 남는지(사용자 보고: "상세 로그가 안 나옴")와,
auto 모드에서 pod 실패 시 snapshot 으로 폴백하는지를 중점적으로 검증한다.
snapshot 경로가 실제로 스냅샷을 찾아 판정까지 가는 happy path 는 실 Postgres 가
필요해(SessionLocal) 여기서는 다루지 않는다 — "DB 연결 불가/스냅샷 없음" 등
DB 세션을 열기 전에 반환하는 분기만 다룬다.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models import StatusEnum
from app.services.deep_checkers.base import DeepCheckContext
from app.services.deep_checkers.cert_expiry_checker import (
    CertExpiryChecker,
    _parse_kubeadm_output,
    _residual_days,
    _verdict,
)


SAMPLE_OUTPUT = """CERTIFICATE                EXPIRES                  RESIDUAL TIME
apiserver                  Aug 12, 2026 10:11 UTC   362d
apiserver-etcd-client      Aug 12, 2026 10:11 UTC   362d
front-proxy-client         Aug 12, 2026 10:11 UTC   362d
ca                         Jan 01, 2035 00:00 UTC   9y
"""


def _pod(name: str, running: bool = True):
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name),
        status=SimpleNamespace(phase="Running" if running else "Pending"),
    )


def _ctx(**params) -> DeepCheckContext:
    return DeepCheckContext(
        cluster=SimpleNamespace(id="c1", api_endpoint=None),
        thresholds={"warning_days": 30, "critical_days": 7},
        params=params,
    )


# ── 순수 함수 ──────────────────────────────────────────────────────────────

def test_residual_days_parses_year_week_day_hour_units():
    assert _residual_days("9y") == 9 * 365
    assert _residual_days("1y64d") == 365 + 64
    assert _residual_days("23h") == 0  # int() 절삭
    assert _residual_days("362d") == 362
    assert _residual_days("no duration here") is None


def test_parse_kubeadm_output_skips_header_and_blank_lines():
    rows = _parse_kubeadm_output(SAMPLE_OUTPUT)
    names = [r["name"] for r in rows]
    assert names == ["apiserver", "apiserver-etcd-client", "front-proxy-client", "ca"]
    assert rows[0]["residual_days"] == 362
    assert rows[-1]["residual_days"] == 9 * 365


def test_verdict_uses_minimum_residual_days():
    rows = _parse_kubeadm_output(SAMPLE_OUTPUT)
    status, min_days = _verdict(rows, warning_days=30, critical_days=7)
    assert min_days == 362
    assert status == StatusEnum.healthy

    status, min_days = _verdict(rows + [{"residual_days": 3}], warning_days=30, critical_days=7)
    assert min_days == 3
    assert status == StatusEnum.critical


# ── source="pod" — 파드 탐색/실행 실패가 steps 에 상세히 남는지 ──────────────────

def test_pod_not_found_without_fallback_records_failed_step():
    checker = CertExpiryChecker()
    checker._v1 = MagicMock(return_value=MagicMock(
        list_namespaced_pod=MagicMock(return_value=SimpleNamespace(items=[]))
    ))
    outcome = checker.safe_run(_ctx(source="pod"))

    assert outcome.status == StatusEnum.pending
    assert outcome.details["reason"] == "kubeadm_not_found"
    step_ids = [s["id"] for s in outcome.steps]
    assert step_ids == ["locate_pod"]
    assert outcome.steps[0]["status"] == "failed"


def test_exec_failure_without_fallback_surfaces_stderr_in_step_detail():
    """kube-apiserver 가 distroless 라 exec 자체가 안 되는(흔한) 케이스 —
    예전엔 이 stderr 이 steps 에 전혀 안 남아 '상세 로그가 없다'는 문제가 있었다."""
    checker = CertExpiryChecker()
    checker._v1 = MagicMock(return_value=MagicMock(
        list_namespaced_pod=MagicMock(return_value=SimpleNamespace(items=[_pod("kube-apiserver-m1")]))
    ))
    checker._kubectl = MagicMock(return_value=SimpleNamespace(
        returncode=126, stdout="", stderr='OCI runtime exec failed: exec: "kubeadm": executable file not found in $PATH',
    ))

    outcome = checker.safe_run(_ctx(source="pod"))

    assert outcome.status == StatusEnum.pending
    assert outcome.details["returncode"] == 126
    assert "kubeadm" in outcome.details["stderr"]
    step_ids = [s["id"] for s in outcome.steps]
    assert step_ids == ["locate_pod", "exec_kubeadm"]
    exec_step = outcome.steps[-1]
    assert exec_step["status"] == "failed"
    assert "126" in exec_step["detail"]
    assert "kubeadm" in exec_step["detail"]


def test_pod_success_parses_rows_and_records_all_steps():
    checker = CertExpiryChecker()
    checker._v1 = MagicMock(return_value=MagicMock(
        list_namespaced_pod=MagicMock(return_value=SimpleNamespace(items=[_pod("kube-apiserver-m1")]))
    ))
    checker._kubectl = MagicMock(return_value=SimpleNamespace(
        returncode=0, stdout=SAMPLE_OUTPUT, stderr="",
    ))

    outcome = checker.safe_run(_ctx(source="pod"))

    assert outcome.status == StatusEnum.healthy
    assert outcome.details["source"] == "pod"
    assert outcome.details["min_residual_days"] == 362
    step_ids = [s["id"] for s in outcome.steps]
    assert step_ids == ["locate_pod", "exec_kubeadm", "parse", "verdict"]
    assert all(s["status"] == "success" for s in outcome.steps)


# ── source="auto" — pod 실패 시 snapshot 으로 폴백하는지 ───────────────────────

def test_auto_falls_back_to_snapshot_when_pod_not_found():
    checker = CertExpiryChecker()
    checker._v1 = MagicMock(return_value=MagicMock(
        list_namespaced_pod=MagicMock(return_value=SimpleNamespace(items=[]))
    ))
    # cluster=None → snapshot 경로가 DB 를 열기 전에 즉시 반환(DB-free 로 폴백 자체만 검증)
    ctx = DeepCheckContext(cluster=None, thresholds={}, params={"source": "auto"})

    outcome = checker.safe_run(ctx)

    assert outcome.status == StatusEnum.pending
    assert outcome.details["reason"] == "no_cluster_context"
    step_ids = [s["id"] for s in outcome.steps]
    assert step_ids == ["locate_pod", "snapshot"]
    assert outcome.steps[0]["status"] == "skipped"
    assert "폴백" in outcome.steps[0]["detail"]
    assert outcome.steps[1]["status"] == "failed"


def test_auto_falls_back_to_snapshot_when_exec_fails():
    checker = CertExpiryChecker()
    checker._v1 = MagicMock(return_value=MagicMock(
        list_namespaced_pod=MagicMock(return_value=SimpleNamespace(items=[_pod("kube-apiserver-m1")]))
    ))
    checker._kubectl = MagicMock(return_value=SimpleNamespace(
        returncode=126, stdout="", stderr="exec: kubeadm not found",
    ))
    ctx = DeepCheckContext(cluster=None, thresholds={}, params={"source": "auto"})

    outcome = checker.safe_run(ctx)

    assert outcome.status == StatusEnum.pending
    assert outcome.details["reason"] == "no_cluster_context"
    step_ids = [s["id"] for s in outcome.steps]
    assert step_ids == ["locate_pod", "exec_kubeadm", "snapshot"]
    assert outcome.steps[1]["status"] == "failed"   # exec_kubeadm 은 실패로 남되
    assert outcome.steps[2]["status"] == "failed"   # 폴백한 snapshot 도 실패


def test_source_pod_never_falls_back_even_when_exec_fails():
    checker = CertExpiryChecker()
    checker._v1 = MagicMock(return_value=MagicMock(
        list_namespaced_pod=MagicMock(return_value=SimpleNamespace(items=[_pod("kube-apiserver-m1")]))
    ))
    checker._kubectl = MagicMock(return_value=SimpleNamespace(
        returncode=126, stdout="", stderr="exec: kubeadm not found",
    ))
    outcome = checker.safe_run(_ctx(source="pod"))

    step_ids = [s["id"] for s in outcome.steps]
    assert "snapshot" not in step_ids
    assert "source=snapshot" in outcome.message


# ── source="snapshot" — DB 연결 불가/클러스터 컨텍스트 없음 분기 ─────────────────

def test_snapshot_source_without_cluster_context_is_pending():
    checker = CertExpiryChecker()
    ctx = DeepCheckContext(cluster=None, thresholds={}, params={"source": "snapshot"})

    outcome = checker.safe_run(ctx)

    assert outcome.status == StatusEnum.pending
    assert outcome.details["reason"] == "no_cluster_context"
    assert [s["id"] for s in outcome.steps] == ["snapshot"]
