"""클러스터 API 엔드포인트 허용 대역 정책 + reorder 단일 조회 (감사 7번)."""
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.app_setting import AppSetting
from app.models.cluster import Cluster, StatusEnum
from app.routers import clusters as clusters_router
from app.routers import ui_settings as ui_settings_router
from app.schemas.cluster import ClusterCreate, ClusterUpdate
from app.services import cluster_endpoint_policy as policy


def _user(role="operator"):
    u = MagicMock()
    u.id, u.username, u.role = f"{role}-uuid", role, role
    return u


# ── 정규화 ────────────────────────────────────────────────────────────────────

def test_normalize_dedupes_and_canonicalizes():
    out = policy.normalize_allowlist({"entries": [" 10.0.0.5/8 ", "10.0.0.0/8", "*.K8S.local", "", 3]})
    assert out == {"entries": ["10.0.0.0/8", "*.k8s.local"]}


def test_normalize_strict_rejects_bad_entry_lenient_skips_it():
    with pytest.raises(policy.InvalidAllowlistEntry):
        policy.normalize_allowlist({"entries": ["10.0.0.0/8", "http://bad"]}, strict=True)
    assert policy.normalize_allowlist({"entries": ["10.0.0.0/8", "http://bad"]}) == {"entries": ["10.0.0.0/8"]}


# ── 판정 ──────────────────────────────────────────────────────────────────────

def _no_dns(_host):
    raise AssertionError("DNS 를 조회하면 안 되는 경우")


@pytest.mark.parametrize("endpoint", ["https://10.1.2.3:6443", "10.1.2.3:6443", "https://[fd00::1]:6443"])
def test_ip_endpoint_inside_cidr_is_allowed(endpoint):
    entries = ["10.0.0.0/8", "fd00::/8"]
    assert policy.endpoint_denied_reason(entries, endpoint, resolver=_no_dns) is None


def test_ip_endpoint_outside_cidr_is_denied():
    reason = policy.endpoint_denied_reason(["10.0.0.0/8"], "https://169.254.169.254", resolver=_no_dns)
    assert reason and "허용 대역 밖" in reason


def test_empty_allowlist_or_empty_endpoint_allows_everything():
    assert policy.endpoint_denied_reason([], "https://8.8.8.8", resolver=_no_dns) is None
    assert policy.endpoint_denied_reason(["10.0.0.0/8"], "", resolver=_no_dns) is None


def test_hostname_entry_exact_and_wildcard():
    entries = ["api.k8s.local", "*.prod.local"]
    assert policy.endpoint_denied_reason(entries, "https://api.k8s.local:6443", resolver=_no_dns) is None
    assert policy.endpoint_denied_reason(entries, "https://a.b.prod.local", resolver=_no_dns) is None
    # hostname 항목만 있고 CIDR 이 없으면 DNS 를 보지 않고 거절
    assert policy.endpoint_denied_reason(entries, "https://evil.example", resolver=_no_dns)


def test_hostname_resolved_all_addresses_must_be_inside():
    entries = ["10.0.0.0/8"]
    assert policy.endpoint_denied_reason(entries, "https://api.lab", resolver=lambda h: ["10.0.0.7"]) is None
    # 하나라도 밖이면 거절 — DNS 응답 순서에 따라 우회되지 않게
    assert policy.endpoint_denied_reason(entries, "https://api.lab", resolver=lambda h: ["10.0.0.7", "8.8.8.8"])


def test_unresolvable_hostname_is_denied_with_reason():
    def boom(_h):
        raise OSError("Name or service not known")
    reason = policy.endpoint_denied_reason(["10.0.0.0/8"], "https://nope.lab", resolver=boom)
    assert reason and "해석할 수 없어" in reason


def test_get_allowlist_fail_safe_on_db_error():
    db = MagicMock()
    db.query.side_effect = RuntimeError("no table")
    assert policy.get_allowlist(db) == []
    db.rollback.assert_called_once()


# ── 라우터 적용 지점 ───────────────────────────────────────────────────────────

def test_create_cluster_rejects_endpoint_outside_allowlist_even_when_skipping_check(monkeypatch):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None  # 중복 이름 없음
    monkeypatch.setattr(clusters_router, "check_endpoint", lambda _db, ep: "허용 대역 밖" if "8.8.8.8" in ep else None)
    data = ClusterCreate(name="x", api_endpoint="https://8.8.8.8:6443", skip_connectivity_check=True)
    with pytest.raises(HTTPException) as exc:
        clusters_router.create_cluster(data, MagicMock(), db, _user())
    assert exc.value.status_code == 422
    db.add.assert_not_called()


def test_update_cluster_checks_only_changed_endpoint(monkeypatch):
    cluster = Cluster(id=uuid.uuid4(), name="c", api_endpoint="https://8.8.8.8:6443")
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = cluster
    calls = []
    monkeypatch.setattr(clusters_router, "check_endpoint", lambda _db, ep: calls.append(ep) or "허용 대역 밖")
    monkeypatch.setattr(clusters_router.audit_logger, "record", lambda *a, **k: None)

    # 엔드포인트를 안 바꾸는 수정은 (정책 이전 등록분이어도) 막지 않는다
    clusters_router.update_cluster(cluster.id, ClusterUpdate(region="seoul"), MagicMock(), db, _user())
    assert calls == []

    with pytest.raises(HTTPException) as exc:
        clusters_router.update_cluster(cluster.id, ClusterUpdate(api_endpoint="https://1.1.1.1"), MagicMock(), db, _user())
    assert exc.value.status_code == 422 and calls == ["https://1.1.1.1"]
    assert cluster.api_endpoint == "https://8.8.8.8:6443"


def test_verify_does_not_contact_denied_endpoint(monkeypatch):
    cluster = Cluster(id=uuid.uuid4(), name="c", api_endpoint="https://8.8.8.8:6443", status=StatusEnum.healthy)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = cluster
    monkeypatch.setattr(clusters_router, "check_endpoint", lambda _db, ep: "허용 대역 밖입니다")
    monkeypatch.setattr(clusters_router.audit_logger, "record", lambda *a, **k: None)
    monkeypatch.setattr(clusters_router.httpx, "Client", lambda *a, **k: (_ for _ in ()).throw(AssertionError("HTTP 호출 금지")))
    monkeypatch.setattr(clusters_router.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("kubectl 금지")))

    out = clusters_router.verify_cluster(cluster.id, MagicMock(), db, _user())
    by = {r["check"]: r for r in out["results"]}
    assert by["api_server"]["ok"] is False and "허용 대역 밖" in by["api_server"]["detail"]
    assert by["kubeconfig_auth"]["ok"] is None and by["kubectl_nodes"]["ok"] is None
    assert out["status"] in (StatusEnum.pending, "pending")  # API 도달 불가로 판정


def test_reorder_uses_single_in_query_and_assigns_seq():
    a, b = Cluster(id=uuid.uuid4(), name="a", seq=1), Cluster(id=uuid.uuid4(), name="b", seq=2)
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [a, b]
    out = clusters_router.reorder_clusters(clusters_router.ReorderRequest(cluster_ids=[b.id, a.id]), db, _user())
    assert out == {"updated": 2}
    assert (b.seq, a.seq) == (1000, 1010)
    assert db.query.call_count == 1  # 예전엔 id 마다 1회
    db.commit.assert_called_once()


def test_reorder_missing_and_duplicate_ids():
    a = Cluster(id=uuid.uuid4(), name="a")
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [a]
    with pytest.raises(HTTPException) as exc:
        clusters_router.reorder_clusters(clusters_router.ReorderRequest(cluster_ids=[a.id, uuid.uuid4()]), db, _user())
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        clusters_router.reorder_clusters(clusters_router.ReorderRequest(cluster_ids=[a.id, a.id]), db, _user())
    assert exc.value.status_code == 422
    db.commit.assert_not_called()


# ── 설정 저장 ──────────────────────────────────────────────────────────────────

def test_update_allowlist_validates_and_audits_on_change(monkeypatch):
    row = AppSetting(key=policy.CLUSTER_ENDPOINT_ALLOWLIST_KEY, value={"entries": []})
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = row
    records = []
    monkeypatch.setattr(ui_settings_router.audit_logger, "record", lambda *a, **k: records.append(k))

    with pytest.raises(HTTPException) as exc:
        ui_settings_router.update_cluster_endpoint_allowlist({"data": {"entries": ["not a cidr!"]}}, MagicMock(), db, _user("admin"))
    assert exc.value.status_code == 422 and "not a cidr!" in exc.value.detail
    assert records == [] and row.value == {"entries": []}

    out = ui_settings_router.update_cluster_endpoint_allowlist({"data": {"entries": ["10.0.0.0/8"]}}, MagicMock(), db, _user("admin"))
    assert out == {"data": {"entries": ["10.0.0.0/8"]}}
    assert [r["action"] for r in records] == ["settings.cluster_endpoint_allowlist.update"]
    ui_settings_router.update_cluster_endpoint_allowlist({"data": {"entries": ["10.0.0.0/8"]}}, MagicMock(), db, _user("admin"))
    assert len(records) == 1
