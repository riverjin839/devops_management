"""DB-free 단위 테스트 — Isilon 실행 응답의 K8s NFS PV 조회 오류 필드(D-147).

PV 표가 "미실행 / PV 없음 / K8s 조회 실패" 를 구분하려면 응답이 조회 실패 사유를 실어야 한다.
조회 실패는 예외로 올리지 않고(fail-safe) 빈 목록 + ``k8s_nfs_pvs_error`` 로 돌려준다.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models.isilon_server import IsilonServer
from app.routers import isilon_nfs
from app.services import k8s_client_pool


def _server() -> IsilonServer:
    return IsilonServer(name="isilon-1", host="10.0.0.9", port=22, username="root")


def _pv(name: str, path: str | None, claim: tuple[str, str] | None = None):
    nfs = SimpleNamespace(path=path, server="10.0.0.9") if path else None
    claim_ref = SimpleNamespace(namespace=claim[0], name=claim[1]) if claim else None
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name),
        spec=SimpleNamespace(nfs=nfs, claim_ref=claim_ref),
        status=SimpleNamespace(phase="Bound"),
    )


def test_pv_lookup_failure_returns_empty_list_with_reason(monkeypatch):
    def _boom(*_a, **_kw):
        raise RuntimeError("in-cluster config not found")

    monkeypatch.setattr(k8s_client_pool, "get_incluster_api_client", _boom)

    pvs, error = isilon_nfs._list_k8s_nfs_pvs(_server())

    assert pvs == []
    assert error is not None
    assert "K8s PV 조회 실패" in error
    assert "in-cluster config not found" in error


def test_pv_lookup_success_has_no_error_and_keeps_only_nfs(monkeypatch):
    kubernetes = pytest.importorskip("kubernetes")
    monkeypatch.setattr(k8s_client_pool, "get_incluster_api_client", lambda *a, **kw: MagicMock())
    fake_v1 = MagicMock()
    fake_v1.list_persistent_volume.return_value = SimpleNamespace(items=[
        _pv("pv-nfs", "/ifs/data/a", ("ns1", "pvc-a")),
        _pv("pv-local", None),
    ])
    monkeypatch.setattr(kubernetes.client, "CoreV1Api", lambda *_a, **_kw: fake_v1)

    pvs, error = isilon_nfs._list_k8s_nfs_pvs(_server())

    assert error is None
    assert [p["pv"] for p in pvs] == ["pv-nfs"]
    assert pvs[0]["pvc"] == "ns1/pvc-a"


def test_run_response_carries_pv_error_field(monkeypatch):
    server = _server()
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = server
    monkeypatch.setattr(
        isilon_nfs.isilon_service, "run_selected_commands",
        lambda db, server, keys: {"connection_ok": True, "results": []},
    )
    monkeypatch.setattr(isilon_nfs, "_list_k8s_nfs_pvs", lambda s: ([], "K8s PV 조회 실패: forbidden"))

    result = isilon_nfs.run_commands(
        server_id=server.id, payload=isilon_nfs.IsilonRunRequest(keys=["exports"]), db=db, _=MagicMock(),
    )

    assert result["k8s_nfs_pvs"] == []
    assert result["k8s_nfs_pvs_error"] == "K8s PV 조회 실패: forbidden"
