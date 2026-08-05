"""DB-free unit tests for the non-SSH(K8s) batch-job pre-flight (_k8s_preflight).

예전엔 non-SSH 잡의 test-connection 이 422 로 거부돼 실행해 보기 전까지는 연결
문제를 알 수 없었다 — 이제 kubeconfig → kubectl 바이너리 → API → RBAC 를
단계별로 점검하고 실패 사유를 그대로 노출한다.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.routers.batch_jobs import _k8s_preflight


def _job(cluster=None):
    job = MagicMock()
    job.cluster = cluster
    return job


@pytest.mark.asyncio
async def test_preflight_no_cluster_fails_kubeconfig_and_skips_rest():
    res = await _k8s_preflight(_job(cluster=None), timeout=5)
    assert res.mode == "k8s"
    assert res.status == "error"
    by_check = {c.check: c for c in res.checks}
    assert by_check["kubeconfig"].ok is False
    assert "클러스터를 찾을 수 없습니다" in by_check["kubeconfig"].detail
    # 이후 체크는 확인 불가(None)로 short-circuit
    assert by_check["kubectl_binary"].ok is None
    assert by_check["api_server"].ok is None
    assert by_check["rbac_jobs"].ok is None


@pytest.mark.asyncio
async def test_preflight_path_only_cluster_explains_worker_volume_gap():
    """경로만 등록된 클러스터(DB content 없음) — Compose 워커 미공유 사유가 노출된다."""
    cluster = SimpleNamespace(
        name="prod", kubeconfig_content=None, kubeconfig_path="/tmp/nonexistent-kc.yaml", id="x",
    )
    res = await _k8s_preflight(_job(cluster=cluster), timeout=5)
    assert res.status == "error"
    by_check = {c.check: c for c in res.checks}
    assert by_check["kubeconfig"].ok is False
    assert "경로" in by_check["kubeconfig"].detail
    assert "컨테이너" in by_check["kubeconfig"].detail


@pytest.mark.asyncio
async def test_preflight_kubectl_binary_missing(monkeypatch, tmp_path):
    """kubeconfig 는 확보됐는데 kubectl 바이너리가 없는 컨테이너."""
    kc = tmp_path / "kc.yaml"
    kc.write_text("apiVersion: v1\nkind: Config\n")
    cluster = SimpleNamespace(
        name="prod", kubeconfig_content=None, kubeconfig_path=str(kc), id="x",
    )
    import shutil
    monkeypatch.setattr(shutil, "which", lambda name: None)

    res = await _k8s_preflight(_job(cluster=cluster), timeout=5)
    by_check = {c.check: c for c in res.checks}
    assert by_check["kubeconfig"].ok is True
    assert by_check["kubectl_binary"].ok is False
    assert "kubectl 을 찾을 수 없습니다" in by_check["kubectl_binary"].detail
    assert by_check["api_server"].ok is None
    assert res.status == "error"
