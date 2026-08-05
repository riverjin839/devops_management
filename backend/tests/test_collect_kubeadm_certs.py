"""DB-free 단위 테스트 — POST /clusters/{id}/collect-kubeadm-certs.

`_exec_ssh`/`_store_if_changed` 를 모킹해 라우터의 검증·per-host 결과 매핑만
검증한다(호출부에서 실제 SSH/DB 를 타지 않음).
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

import app.routers.versions as mod
from app.routers.versions import KubeadmCertsCollectRequest, collect_kubeadm_certs
from app.services.ssh_runner import SSHResult


def _payload(**overrides) -> KubeadmCertsCollectRequest:
    data = dict(hosts=["10.0.0.5"], port=22, username="root", password="pw")
    data.update(overrides)
    return KubeadmCertsCollectRequest(**data)


def _db_with_cluster():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(id="c1")
    return db


def test_missing_credential_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        collect_kubeadm_certs(
            cluster_id="c1", payload=_payload(password=None), db=_db_with_cluster(), _=None,
        )
    assert exc_info.value.status_code == 422


def test_cluster_not_found_raises_404():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    with pytest.raises(HTTPException) as exc_info:
        collect_kubeadm_certs(cluster_id="missing", payload=_payload(), db=db, _=None)
    assert exc_info.value.status_code == 404


def test_success_stores_snapshot_per_host(monkeypatch):
    monkeypatch.setattr(mod, "_exec_ssh", lambda *a, **kw: SSHResult(
        host="10.0.0.5", status="ok", exit_code=0,
        stdout="apiserver   Aug 12, 2026 10:11 UTC   362d\n", stderr="", duration_ms=10, error=None,
    ))
    monkeypatch.setattr(mod, "_store_if_changed", lambda *a, **kw: True)

    res = collect_kubeadm_certs(cluster_id="c1", payload=_payload(), db=_db_with_cluster(), _=None)

    assert res["changed"] == 1
    assert res["hosts"][0]["host"] == "10.0.0.5"
    assert res["hosts"][0]["stored"] is True
    assert res["errors"] == []


def test_ssh_failure_records_error_without_storing(monkeypatch):
    monkeypatch.setattr(mod, "_exec_ssh", lambda *a, **kw: SSHResult(
        host="10.0.0.5", status="connect_error", exit_code=None,
        stdout="", stderr="", duration_ms=5, error="연결 실패: [Errno 111] Connection refused",
    ))
    store_calls = []
    monkeypatch.setattr(mod, "_store_if_changed", lambda *a, **kw: store_calls.append(1) or True)

    res = collect_kubeadm_certs(cluster_id="c1", payload=_payload(), db=_db_with_cluster(), _=None)

    assert res["changed"] == 0
    assert store_calls == []                     # 실패한 호스트는 저장 시도조차 안 함
    assert "연결 실패" in res["hosts"][0]["error"]
    assert len(res["errors"]) == 1


def test_empty_output_treated_as_failure(monkeypatch):
    """kubeadm 이 설치 안 돼 있으면 명령은 'ok' 로 끝나도(rc 무시하는 _exec_ssh 관례상)
    출력이 비어있을 수 있다 — 빈 출력도 실패로 취급해야 스냅샷에 빈 데이터가 안 쌓인다."""
    monkeypatch.setattr(mod, "_exec_ssh", lambda *a, **kw: SSHResult(
        host="10.0.0.5", status="ok", exit_code=0, stdout="   \n", stderr="", duration_ms=5, error=None,
    ))
    monkeypatch.setattr(mod, "_store_if_changed", lambda *a, **kw: True)

    res = collect_kubeadm_certs(cluster_id="c1", payload=_payload(), db=_db_with_cluster(), _=None)

    assert res["changed"] == 0
    assert res["hosts"][0]["error"]
