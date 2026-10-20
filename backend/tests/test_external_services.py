"""외부 서비스 — 엔드포인트 추출·PTR 출력 파싱·SSH 스크립트 검증·수집 저장/캐시 병합·공개 API(비인증)·설정.

DB 가 필요한 테스트는 PostgreSQL 이 있어야 한다. K8s/SSH/DNS 는 monkeypatch 로 대체한다.
"""
import uuid
from types import SimpleNamespace as NS

import pytest

from app.services import external_services as es


def _svc(ns, name, stype, ports, lb=None, ext_ips=None):
    return NS(
        metadata=NS(namespace=ns, name=name),
        spec=NS(type=stype, ports=[NS(port=p, node_port=np, protocol="TCP", name=f"p{p}", target_port=p)
                                   for p, np in ports], external_i_ps=ext_ips),
        status=NS(load_balancer=NS(ingress=[NS(ip=i, hostname=None) for i in (lb or [])])),
    )


def _ing(ns, name, rules, lb_ips, tls_hosts=None):
    return NS(
        metadata=NS(namespace=ns, name=name),
        spec=NS(
            ingress_class_name="nginx",
            tls=[NS(hosts=tls_hosts)] if tls_hosts is not None else [],
            rules=[NS(host=h, http=NS(paths=[NS(path="/", backend=NS(service=NS(name="web", port=NS(number=8080, name=None))))]))
                   for h in rules],
        ),
        status=NS(load_balancer=NS(ingress=[NS(ip=i, hostname=None) for i in lb_ips])),
    )


def test_service_entries_kinds():
    lb = es.service_entries(_svc("pay", "api", "LoadBalancer", [(443, 31443)], lb=["10.0.0.5"]))
    assert [(e["kind"], e["ip"], e["port"]) for e in lb] == [("LoadBalancer", "10.0.0.5", 443)]
    np_ = es.service_entries(_svc("pay", "admin", "NodePort", [(80, 30080)]))
    assert [(e["kind"], e["ip"], e["port"]) for e in np_] == [("NodePort", None, 30080)]
    assert es.service_entries(_svc("pay", "admin", "NodePort", [(80, 30080)]), include_nodeport=False) == []
    ext = es.service_entries(_svc("pay", "x", "ClusterIP", [(53, None)], ext_ips=["192.168.1.9"]))
    assert [(e["kind"], e["ip"]) for e in ext] == [("ExternalIP", "192.168.1.9")]
    assert es.service_entries(_svc("pay", "internal", "ClusterIP", [(80, None)])) == []


def test_ingress_entries_tls_and_paths():
    out = es.ingress_entries(_ing("web", "site", ["a.example.com", "b.example.com"], ["10.0.0.7"],
                                  tls_hosts=["a.example.com"]))
    got = sorted((e["host"], e["scheme"], e["port"]) for e in out)
    assert got == [("a.example.com", "http", 80), ("a.example.com", "https", 443), ("b.example.com", "http", 80)]
    assert out[0]["paths"] == ["/ → web:8080"] and out[0]["ip"] == "10.0.0.7"


def test_parse_ptr_output_variants():
    nslookup = "5.0.0.10.in-addr.arpa\tname = api.corp.local.\n"
    host = "5.0.0.10.in-addr.arpa domain name pointer api2.corp.local.\n"
    getent = "10.0.0.5      api3.corp.local api3\n"
    assert es.parse_ptr_output("10.0.0.5", nslookup) == ["api.corp.local"]
    assert es.parse_ptr_output("10.0.0.5", host) == ["api2.corp.local"]
    assert es.parse_ptr_output("10.0.0.5", getent) == ["api3.corp.local", "api3"]
    assert es.parse_ptr_output("10.0.0.5", "api4.corp.local.\n") == ["api4.corp.local"]
    assert es.parse_ptr_output("10.0.0.5", "** server can't find 5.0.0.10.in-addr.arpa: NXDOMAIN") == []


def test_ssh_script_rejects_non_ip_and_splits():
    with pytest.raises(ValueError):
        es.build_ssh_script(["10.0.0.1; rm -rf /"], es.DEFAULT_PTR_COMMAND)
    script = es.build_ssh_script(["10.0.0.1"], "nslookup {ip}")
    assert "nslookup 10.0.0.1" in script and "@@PTR 10.0.0.1" in script
    blocks = es.split_ssh_output("@@PTR 10.0.0.1\nname = a.\n@@PTR 10.0.0.2\nfoo\n")
    assert blocks == {"10.0.0.1": "name = a.", "10.0.0.2": "foo"}


def test_lookup_ips_skips_hostnames_and_nodeport():
    entries = [{"ip": "10.0.0.5"}, {"ip": "10.0.0.5"}, {"ip": None}, {"ip": "elb.aws.com"}]
    assert es.lookup_ips(entries) == ["10.0.0.5"]


# ── DB ──────────────────────────────────────────────────────────────────────────
@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    from app.main import _ensure_pgvector_extension
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def settings_reset(db):
    from app.models.app_setting import AppSetting
    db.query(AppSetting).filter(AppSetting.key == es.SETTINGS_KEY).delete()
    db.commit()
    yield
    db.query(AppSetting).filter(AppSetting.key == es.SETTINGS_KEY).delete()
    db.commit()


@pytest.fixture
def cluster(db):
    from app.models import Cluster
    c = Cluster(id=uuid.uuid4(), name=f"es-test-{uuid.uuid4().hex[:6]}", api_endpoint="https://x")
    db.add(c)
    db.commit()
    try:
        yield c
    finally:
        try:
            db.delete(c)
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()


@pytest.fixture
def fake_k8s(monkeypatch):
    svcs = [_svc("pay", "api", "LoadBalancer", [(443, 31443)], lb=["10.0.0.5"]),
            _svc("kube-system", "dns", "LoadBalancer", [(53, 30053)], lb=["10.0.0.9"])]
    ings = [_ing("web", "site", ["shop.example.com"], ["10.0.0.7"])]
    nodes = [NS(metadata=NS(name="w1"), status=NS(addresses=[NS(type="InternalIP", address="172.16.0.1")]))]

    class Core:
        def __init__(self, _api): ...
        def list_service_for_all_namespaces(self, **_): return NS(items=svcs)
        def list_node(self, **_): return NS(items=nodes)

    class Net:
        def __init__(self, _api): ...
        def list_ingress_for_all_namespaces(self, **_): return NS(items=ings)

    import kubernetes.client as kc
    import app.services.k8s_client_pool as pool
    monkeypatch.setattr(kc, "CoreV1Api", Core)
    monkeypatch.setattr(kc, "NetworkingV1Api", Net)
    monkeypatch.setattr(pool, "get_api_client", lambda c: object())


def test_collect_saves_snapshot_and_keeps_ssh_names(db, cluster, settings_reset, fake_k8s, monkeypatch):
    es.set_settings(db, {"exclude_namespaces": ["kube-system"]})
    monkeypatch.setattr(es, "resolve_ssh", lambda ips, t, cmd, emit: {ip: ([f"n{ip[-1]}.corp"] if ip == "10.0.0.5" else [])
                                                                      for ip in ips})
    monkeypatch.setattr(es, "resolve_backend", lambda ips, timeout, emit: {ip: [] for ip in ips})
    logs = []
    res = es.collect(db, cluster, resolver="ssh", ssh_target=NS(host="m1"), actor="op",
                     emit=lambda lvl, msg: logs.append((lvl, msg)))
    assert res["ok"] and res["by_kind"] == {"LoadBalancer": 1, "Ingress": 1}
    assert any("스냅샷 저장" in m for _, m in logs)

    # 다음 정기 수집(backend, 이름 없음) — SSH 로 찾은 이름은 유지
    es.collect(db, cluster, resolver="backend", actor="schedule")
    view = es.public_view(db, cluster)
    by_ip = {e["ip"]: e for e in view["entries"]}
    assert by_ip["10.0.0.5"]["ptr_names"] == ["n5.corp"] and by_ip["10.0.0.5"]["ptr_source"] == "ssh"
    assert by_ip["10.0.0.7"]["host"] == "shop.example.com"
    assert view["collected_by"] == "정기 수집"
    assert view["node_ips"] == [{"name": "w1", "internal_ip": "172.16.0.1", "external_ip": None}]


def test_collect_k8s_failure_is_failsafe(db, cluster, settings_reset, monkeypatch):
    import app.services.k8s_client_pool as pool

    def boom(_c):
        raise RuntimeError("kubeconfig 없음")
    monkeypatch.setattr(pool, "get_api_client", boom)
    res = es.collect(db, cluster, resolver="none")
    assert res["ok"] is False and "kubeconfig" in res["error"]


def test_public_api_and_settings_auth(db, cluster, settings_reset):
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    r = client.get("/api/v1/public/external-services/clusters")
    assert r.status_code == 200 and str(cluster.id) in {c["id"] for c in r.json()["clusters"]}
    r = client.get(f"/api/v1/public/external-services/{cluster.id}")
    assert r.status_code == 200 and r.json()["entries"] == [] and r.json()["collected_at"] is None
    assert client.post(f"/api/v1/external-services/{cluster.id}/collect/stream", json={}).status_code == 401
    assert client.put("/api/v1/external-services/settings", json={"public_enabled": False}).status_code == 401
    es.set_settings(db, {"public_enabled": False})
    assert client.get("/api/v1/public/external-services/clusters").status_code == 404


def test_collect_stream_requires_operator_and_ssh_creds(db, cluster):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    app.dependency_overrides[get_current_user] = lambda: NS(id=uuid.uuid4(), username="v", role="viewer")
    try:
        client = TestClient(app)
        assert client.post(f"/api/v1/external-services/{cluster.id}/collect/stream",
                           json={"resolver": "backend"}).status_code == 403
        app.dependency_overrides[get_current_user] = lambda: NS(id=uuid.uuid4(), username="a", role="admin")
        r = client.post(f"/api/v1/external-services/{cluster.id}/collect/stream",
                        json={"resolver": "ssh", "ssh": {"host": "m1"}})
        assert r.status_code == 422
        r = client.put("/api/v1/external-services/settings", json={"ptr_command": "nslookup"})
        assert r.status_code == 422
    finally:
        app.dependency_overrides.pop(get_current_user, None)
