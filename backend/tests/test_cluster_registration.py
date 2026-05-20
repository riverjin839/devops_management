import uuid
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import HTTPException

from app.models import Addon, Cluster
from app.routers import clusters as clusters_router
from app.schemas import ClusterCreate


def _fake_request():
    """create_cluster 가 require 하는 fastapi.Request mock — audit_logger 가 client.host / user-agent 만 읽음."""
    req = MagicMock()
    req.client = MagicMock(host="127.0.0.1")
    req.headers = {"user-agent": "pytest"}
    return req


def _fake_actor():
    """require_operator 의존성 mock — User 객체 대용. audit_logger 는 .id / .username 만 읽음."""
    actor = MagicMock()
    actor.id = "actor-uuid"
    actor.username = "tester"
    actor.role = "operator"
    return actor


def test_verify_cluster_connectivity_fails_when_kubeconfig_path_missing(monkeypatch):
    monkeypatch.setattr(clusters_router.os.path, "exists", lambda _: False)

    with pytest.raises(HTTPException) as exc_info:
        clusters_router._verify_cluster_connectivity(
            api_endpoint="https://example.com",
            kubeconfig_path="/not/found/config",
        )

    assert exc_info.value.status_code == 422
    assert "kubeconfig 파일을 찾을 수 없습니다" in exc_info.value.detail


def test_verify_cluster_connectivity_fails_on_connect_error(monkeypatch):
    monkeypatch.setattr(clusters_router.os.path, "exists", lambda _: True)

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, _url):
            raise httpx.ConnectError("connection failed")

    monkeypatch.setattr(clusters_router.httpx, "Client", FakeClient)

    with pytest.raises(HTTPException) as exc_info:
        clusters_router._verify_cluster_connectivity(
            api_endpoint="https://unreachable.cluster",
            kubeconfig_path=None,
        )

    assert exc_info.value.status_code == 422
    assert "클러스터 API 서버에 연결할 수 없습니다" in exc_info.value.detail


def test_verify_cluster_connectivity_fails_when_kubeconfig_server_mismatch(monkeypatch):
    monkeypatch.setattr(clusters_router.os.path, "exists", lambda _: True)

    class FakeHttpClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, _url):
            response = MagicMock()
            response.status_code = 200
            return response

    class FakeApiClient:
        class configuration:
            host = "https://another.cluster"

    monkeypatch.setattr(clusters_router.httpx, "Client", FakeHttpClient)
    monkeypatch.setattr(clusters_router.k8s_config, "new_client_from_config", lambda **_kwargs: FakeApiClient())

    with pytest.raises(HTTPException) as exc_info:
        clusters_router._verify_cluster_connectivity(
            api_endpoint="https://target.cluster",
            kubeconfig_path="/tmp/config.yaml",
        )

    assert exc_info.value.status_code == 422
    assert "API Endpoint가 일치하지 않습니다" in exc_info.value.detail


def test_verify_cluster_connectivity_fails_when_kubeconfig_auth_invalid(monkeypatch):
    monkeypatch.setattr(clusters_router.os.path, "exists", lambda _: True)

    class FakeHttpClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, _url):
            response = MagicMock()
            response.status_code = 200
            return response

    class FakeApiClient:
        class configuration:
            host = "https://target.cluster"

    class FakeCoreV1Api:
        def __init__(self, _api_client):
            pass

        def list_namespace(self, **_kwargs):
            raise clusters_router.ApiException(status=401, reason="Unauthorized")

    monkeypatch.setattr(clusters_router.httpx, "Client", FakeHttpClient)
    monkeypatch.setattr(clusters_router.k8s_config, "new_client_from_config", lambda **_kwargs: FakeApiClient())
    monkeypatch.setattr(clusters_router.k8s_client, "CoreV1Api", FakeCoreV1Api)

    with pytest.raises(HTTPException) as exc_info:
        clusters_router._verify_cluster_connectivity(
            api_endpoint="https://target.cluster",
            kubeconfig_path="/tmp/config.yaml",
        )

    assert exc_info.value.status_code == 422
    assert "kubeconfig 인증에 실패했습니다" in exc_info.value.detail


def test_create_cluster_registers_default_addons_and_saves_kubeconfig(monkeypatch):
    monkeypatch.setattr(clusters_router, "_verify_cluster_connectivity", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(clusters_router, "_save_kubeconfig_content", lambda _cid, _content: "/tmp/saved.yaml")

    health_checker_calls = []

    class FakeHealthChecker:
        def __init__(self, _db):
            pass

        def run_check(self, cluster_id):
            health_checker_calls.append(cluster_id)

    monkeypatch.setattr(clusters_router, "HealthChecker", FakeHealthChecker)

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    def _flush_assign_id():
        for call in db.add.call_args_list:
            obj = call.args[0]
            if isinstance(obj, Cluster) and obj.id is None:
                obj.id = uuid.uuid4()

    db.flush.side_effect = _flush_assign_id

    payload = ClusterCreate(
        name="dev-cluster",
        api_endpoint="https://cluster.local",
        kubeconfig_path=None,
        kubeconfig_content="apiVersion: v1\nclusters: []",
    )

    cluster = clusters_router.create_cluster(payload, request=_fake_request(), db=db, actor=_fake_actor())

    assert cluster.name == "dev-cluster"
    assert cluster.kubeconfig_path == "/tmp/saved.yaml"
    assert db.commit.called

    added_objects = [call.args[0] for call in db.add.call_args_list]
    addon_objects = [obj for obj in added_objects if isinstance(obj, Addon)]
    assert len(addon_objects) == len(clusters_router.DEFAULT_ADDONS)
    assert len(health_checker_calls) == 1


def test_create_cluster_rejects_duplicate_name():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = Cluster(
        name="already-exists",
        api_endpoint="https://cluster.local",
    )

    payload = ClusterCreate(
        name="already-exists",
        api_endpoint="https://cluster.local",
        kubeconfig_path=None,
        kubeconfig_content=None,
    )

    with pytest.raises(HTTPException) as exc_info:
        clusters_router.create_cluster(payload, request=_fake_request(), db=db, actor=_fake_actor())

    assert exc_info.value.status_code == 400
    assert "already exists" in exc_info.value.detail
