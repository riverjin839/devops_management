"""viewer 대상 클러스터 네트워크 정보 숨김 정책 (services/cluster_network_mask.py)."""
import uuid
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from app.models.app_setting import AppSetting
from app.models.cluster import Cluster, StatusEnum
from app.routers import clusters as clusters_router
from app.routers import ui_settings as ui_settings_router
from app.services import cluster_network_mask as mask_mod


def _user(role):
    u = MagicMock()
    u.id = f"{role}-uuid"
    u.username = role
    u.role = role
    return u


def _cluster():
    now = datetime(2026, 10, 8)
    return Cluster(
        id=uuid.uuid4(), name="prod-a", seq=10, api_endpoint="https://10.0.0.1:6443",
        status=StatusEnum.healthy, created_at=now, updated_at=now,
        kubeconfig_path="/tmp/k8s-monitor/x.yaml", region="seoul", operation_level="production",
        cidr="10.0.0.0/24", internal_ips="10.0.0.[1-3]", first_host="10.0.0.1", last_host="10.0.0.254",
        pod_cidr="10.244.0.0/16", svc_cidr="10.96.0.0/12", bond0_ip="10.0.0.5", bond0_mac="aa:bb:cc:dd:ee:ff",
        hostname="master-1", as_number="65001", node_ips='["10.0.0.1"]', cilium_config="ipv4-native-routing-cidr: 10.0.0.0/8",
        prometheus_url="http://10.0.0.9:9090", node_count=3,
    )


def _db_with_setting(value):
    db = MagicMock()
    row = AppSetting(key=mask_mod.CLUSTER_VIEWER_MASK_KEY, value=value) if value is not None else None
    db.query.return_value.filter.return_value.first.return_value = row
    return db


@pytest.mark.parametrize("raw,expected", [
    (None, False), ({}, False), ({"enabled": "yes"}, False), ({"enabled": True}, True), ("garbage", False),
])
def test_normalize_mask_setting(raw, expected):
    assert mask_mod.normalize_mask_setting(raw) == {"enabled": expected}


@pytest.mark.parametrize("role,enabled,expected", [
    ("viewer", True, True),
    ("viewer", False, False),
    ("operator", True, False),
    ("admin", True, False),
    ("unknown-role", True, True),  # 알 수 없는 역할은 가린다(fail-closed)
])
def test_should_mask_by_role_and_policy(role, enabled, expected):
    db = _db_with_setting({"enabled": enabled})
    assert mask_mod.should_mask(db, _user(role)) is expected


def test_should_mask_defaults_off_without_setting_row():
    assert mask_mod.should_mask(_db_with_setting(None), _user("viewer")) is False


def test_should_mask_fail_safe_on_db_error():
    db = MagicMock()
    db.query.side_effect = RuntimeError("relation app_settings does not exist")
    assert mask_mod.should_mask(db, _user("viewer")) is False
    db.rollback.assert_called_once()


def test_mask_cluster_blanks_network_fields_only():
    data = mask_mod.mask_cluster(_cluster())
    assert data["network_masked"] is True
    assert data["api_endpoint"] == ""
    for f in mask_mod.NETWORK_FIELDS:
        assert data[f] is None, f
    # 식별·운영 메타는 남는다 — 사이드바·상태 표시가 깨지지 않게
    assert data["name"] == "prod-a"
    assert data["region"] == "seoul"
    assert data["operation_level"] == "production"
    assert data["node_count"] == 3
    assert data["status"] == StatusEnum.healthy


def test_get_clusters_masks_for_viewer_when_enabled(monkeypatch):
    cluster = _cluster()
    db = MagicMock()
    db.query.return_value.order_by.return_value.all.return_value = [cluster]
    scope = MagicMock()
    scope.apply.side_effect = lambda q, _col: q
    monkeypatch.setattr(mask_mod, "get_mask_setting", lambda _db: {"enabled": True})

    viewer_resp = clusters_router.get_clusters(db, scope, _user("viewer"))
    assert viewer_resp.data[0].network_masked is True
    assert viewer_resp.data[0].cidr is None
    assert viewer_resp.data[0].api_endpoint == ""

    operator_resp = clusters_router.get_clusters(db, scope, _user("operator"))
    assert operator_resp.data[0].network_masked is False
    assert operator_resp.data[0].cidr == "10.0.0.0/24"
    assert cluster.cidr == "10.0.0.0/24"  # ORM 객체는 건드리지 않는다(커밋돼도 원본 유지)


def test_get_cluster_detail_and_cilium_config_masked_for_viewer(monkeypatch):
    cluster = _cluster()
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = cluster
    monkeypatch.setattr(mask_mod, "get_mask_setting", lambda _db: {"enabled": True})
    ran = []
    monkeypatch.setattr(clusters_router.subprocess, "run", lambda *a, **k: ran.append(a))

    detail = clusters_router.get_cluster(cluster.id, db, _user("viewer"))
    assert detail["network_masked"] is True and detail["bond0_ip"] is None

    cilium = clusters_router.get_cluster_cilium_config(cluster.id, db, _user("viewer"))
    assert cilium["source"] == "masked"
    assert cilium["stored"] is None and cilium["live"] is None
    assert ran == []  # viewer 요청으로 kubectl 을 돌리지 않는다

    assert clusters_router.get_cluster(cluster.id, db, _user("admin")) is cluster


def test_update_mask_setting_audits_only_on_change(monkeypatch):
    row = AppSetting(key=mask_mod.CLUSTER_VIEWER_MASK_KEY, value={"enabled": False})
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = row
    records = []
    monkeypatch.setattr(ui_settings_router.audit_logger, "record", lambda *a, **k: records.append(k))
    req = MagicMock()

    out = ui_settings_router.update_cluster_viewer_mask({"data": {"enabled": True}}, req, db, _user("admin"))
    assert out == {"data": {"enabled": True}}
    assert row.value == {"enabled": True}
    assert [r["action"] for r in records] == ["settings.cluster_viewer_mask.update"]
    assert records[0]["details"] == {"enabled_from": False, "enabled_to": True}

    ui_settings_router.update_cluster_viewer_mask({"data": {"enabled": True}}, req, db, _user("admin"))
    assert len(records) == 1  # 값이 그대로면 감사 기록을 남기지 않는다


def test_mask_setting_put_requires_admin():
    from fastapi.testclient import TestClient
    from app.auth.deps import get_current_user
    from app.database import get_db
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: _user("operator")
    app.dependency_overrides[get_db] = lambda: _db_with_setting({"enabled": False})
    try:
        client = TestClient(app)
        resp = client.put("/api/v1/ui-settings/cluster-viewer-mask", json={"data": {"enabled": True}})
        assert resp.status_code == 403
        got = client.get("/api/v1/ui-settings/cluster-viewer-mask")
        assert got.status_code == 200 and got.json() == {"data": {"enabled": False}}
    finally:
        app.dependency_overrides.clear()
