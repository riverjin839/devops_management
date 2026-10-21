"""공개 화면 확장 — 공유 링크(만료·폐기·범위·클러스터 제한), NS 담당자(규칙·라벨), 기간(주간·월간) 리포트,
외부 노출 변경 이력.

PostgreSQL 필요(TestClient + 실제 세션). K8s 는 monkeypatch 로 대체한다.
"""
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

import pytest


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
def reset(db):
    from app.models.app_setting import AppSetting
    from app.models.public_share import PublicShareLink
    keys = ("daily_report.settings", "external_services.settings", "ns_owners.settings", "ns_owners.label_cache")
    db.query(AppSetting).filter(AppSetting.key.in_(keys)).delete(synchronize_session=False)
    db.query(PublicShareLink).delete()
    db.commit()
    yield
    db.query(AppSetting).filter(AppSetting.key.in_(keys)).delete(synchronize_session=False)
    db.query(PublicShareLink).delete()
    db.commit()


@pytest.fixture
def cluster(db):
    from app.models import Cluster
    c = Cluster(id=uuid.uuid4(), name=f"px-{uuid.uuid4().hex[:6]}", api_endpoint="https://x")
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


def _client(role=None):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    if role:
        app.dependency_overrides[get_current_user] = lambda: NS(id=uuid.uuid4(), username=f"u-{role}", role=role)
    else:
        app.dependency_overrides.pop(get_current_user, None)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    from app.main import app
    from app.auth.deps import get_current_user
    app.dependency_overrides.pop(get_current_user, None)


# ── 공유 링크 ──────────────────────────────────────────────────────────────────
def test_share_link_access_mode(db, reset, cluster):
    from app.models.public_share import PublicShareLink
    from app.services.k8s_efficiency import daily_report as dr
    admin = _client("admin")
    r = admin.post("/api/v1/public-share-links", json={"label": "고객 A", "page": "daily_report", "expires_days": 3})
    assert r.status_code == 200
    token, link_id = r.json()["token"], r.json()["id"]
    assert r.json()["state"] == "active" and token.startswith(r.json()["token_prefix"])
    assert "token" not in admin.get("/api/v1/public-share-links").json()["links"][0]  # 원문은 발급 때만
    assert _client("viewer").get("/api/v1/public-share-links").status_code == 403

    anon = _client()
    url = "/api/v1/public/daily-report/clusters"
    assert anon.get(url).status_code == 200                       # open — 토큰 불필요
    dr.set_settings(db, {"access_mode": "link"})
    r = anon.get(url)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "share_link_required"
    assert anon.get(url, params={"t": "nope"}).json()["detail"]["code"] == "share_link_invalid"
    ok = anon.get(url, params={"t": token})
    assert ok.status_code == 200 and str(cluster.id) in {c["id"] for c in ok.json()["clusters"]}
    assert ok.json()["link_expires_at"]
    # 범위: daily_report 전용 링크로 외부 서비스는 못 연다(그 화면도 link 모드일 때)
    from app.services import external_services as es
    es.set_settings(db, {"access_mode": "link"})
    r = anon.get("/api/v1/public/external-services/clusters", params={"t": token})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "share_link_scope"

    link = db.query(PublicShareLink).filter_by(id=uuid.UUID(link_id)).one()
    assert link.use_count >= 1
    link.expires_at = datetime.utcnow() - timedelta(minutes=1)
    db.commit()
    assert anon.get(url, params={"t": token}).json()["detail"]["code"] == "share_link_expired"
    link.expires_at = datetime.utcnow() + timedelta(days=1)
    db.commit()
    assert _client("admin").delete(f"/api/v1/public-share-links/{link_id}").json()["state"] == "revoked"
    anon = _client()
    assert anon.get(url, params={"t": token}).json()["detail"]["code"] == "share_link_invalid"


def test_share_link_cluster_restriction(db, reset, cluster):
    from app.models import Cluster
    from app.services.k8s_efficiency import daily_report as dr
    other = Cluster(id=uuid.uuid4(), name=f"px-o-{uuid.uuid4().hex[:6]}", api_endpoint="https://x")
    db.add(other)
    db.commit()
    try:
        dr.set_settings(db, {"access_mode": "link"})
        token = _client("admin").post("/api/v1/public-share-links", json={
            "label": "A 만", "page": "all", "expires_days": 1, "cluster_ids": [str(cluster.id)]}).json()["token"]
        anon = _client()
        ids = {c["id"] for c in anon.get("/api/v1/public/daily-report/clusters", params={"t": token}).json()["clusters"]}
        assert ids == {str(cluster.id)}
        assert anon.get("/api/v1/public/daily-report/report",
                        params={"cluster_id": str(other.id), "t": token}).status_code == 404
    finally:
        db.delete(other)
        db.commit()


# ── NS 담당자 ──────────────────────────────────────────────────────────────────
def test_owner_rules_labels_and_refresh(db, reset, cluster, monkeypatch):
    from app.services import ns_owners
    ns_owners.set_settings(db, {"rules": [
        {"pattern": "pay-*", "owner": "결제팀", "contact": "#pay"},
        {"pattern": "pay-legacy", "owner": "늦은 규칙"},                      # 첫 일치가 이긴다
        {"pattern": "web", "owner": "다른 클러스터", "cluster_id": str(uuid.uuid4())},
    ], "label_keys": ["team"]})

    nss = [NS(metadata=NS(name="web", labels={"team": "프론트"}, annotations={})),
           NS(metadata=NS(name="ml", labels={}, annotations={"team": "ML팀"})),
           NS(metadata=NS(name="bare", labels={}, annotations={}))]

    class Core:
        def __init__(self, _api): ...
        def list_namespace(self, **_): return NS(items=nss)
    import kubernetes.client as kc
    import app.services.k8s_client_pool as pool
    monkeypatch.setattr(kc, "CoreV1Api", Core)
    monkeypatch.setattr(pool, "get_api_client", lambda c: object())
    assert ns_owners.refresh_labels(db, cluster)["found"] == 2

    resolve = ns_owners.resolver(db, cluster.id)
    assert resolve("pay-legacy") == {"owner": "결제팀", "contact": "#pay", "source": "rule"}
    assert resolve("web") == {"owner": "프론트", "contact": None, "source": "label:team"}
    assert resolve("ml")["owner"] == "ML팀" and resolve("bare") is None
    ns_owners.set_settings(db, {"show_contact": False})
    assert ns_owners.resolver(db, cluster.id)("pay-x")["contact"] is None

    # 라벨 조회 실패는 이전 캐시를 유지
    monkeypatch.setattr(pool, "get_api_client", lambda c: (_ for _ in ()).throw(RuntimeError("down")))
    assert ns_owners.refresh_labels(db, cluster)["ok"] is False
    assert ns_owners.resolver(db, cluster.id)("web")["owner"] == "프론트"


def test_owners_api_admin_only(db, reset):
    body = {"rules": [{"pattern": "a-*", "owner": "A팀"}], "label_keys": ["owner"]}
    assert _client("viewer").put("/api/v1/daily-report/owners", json=body).status_code == 403
    r = _client("admin").put("/api/v1/daily-report/owners", json=body)
    assert r.status_code == 200 and r.json()["rules"][0]["owner"] == "A팀"
    assert _client("viewer").get("/api/v1/daily-report/owners").json()["label_keys"] == ["owner"]


def _seed(db, cluster, day, ns, cpu_req, uses):
    from app.models.k8s_efficiency import K8sNamespaceSample
    from app.services.k8s_efficiency import daily_report as dr
    start, _ = dr.day_window_utc(day)
    for i, u in enumerate(uses):
        db.add(K8sNamespaceSample(cluster_id=cluster.id, namespace=ns, sampled_at=start + timedelta(hours=3, minutes=10 * i),
                                  pod_count=2, cpu_req_m=cpu_req, cpu_lim_m=cpu_req * 2, mem_req_b=2 * 1024 ** 3,
                                  mem_lim_b=4 * 1024 ** 3, cpu_use_m=u, mem_use_b=1024 ** 3, usage_source="metrics"))
    db.commit()


def test_report_and_search_carry_owner(db, reset, cluster):
    from app.services import ns_owners
    from app.services.k8s_efficiency import daily_report as dr
    ns_owners.set_settings(db, {"rules": [{"pattern": "pay-*", "owner": "결제팀"}]})
    day = dr.today_local() - timedelta(days=1)
    _seed(db, cluster, day, "pay-api", 1000, [10, 20])
    _seed(db, cluster, day, "web", 1000, [500])
    rep = dr.build_report(db, cluster, day)
    by_ns = {it["namespace"]: it for it in rep["items"]}
    assert by_ns["pay-api"]["owner"]["owner"] == "결제팀" and by_ns["web"]["owner"] is None
    found = dr.search_report(db, cluster, day, "결제")
    assert [it["namespace"] for it in found["items"]] == ["pay-api"] and found["items"][0]["match"]["owner"]


# ── 기간 리포트 ────────────────────────────────────────────────────────────────
def test_period_report_week(db, reset, cluster):
    from app.services.k8s_efficiency import daily_report as dr
    today = dr.today_local()
    for d, uses in ((3, [100]), (2, [300]), (1, [200])):
        _seed(db, cluster, today - timedelta(days=d), "steady-idle", 2000, uses)
        _seed(db, cluster, today - timedelta(days=d), "busy", 1000, [900])
    rep = dr.period_report(db, cluster, today - timedelta(days=1), "week", "cpu_rate")
    assert len(rep["series"]) == 7 and rep["days_with_data"] == 3
    assert rep["start"] == (today - timedelta(days=7)).isoformat()
    top = rep["items"][0]
    assert top["namespace"] == "steady-idle" and top["days"] == 3
    assert top["cpu"]["use_avg"] == 200 and top["cpu"]["use_min"] == 100 and top["cpu"]["use_max"] == 300
    assert top["cpu"]["rate_avg"] == pytest.approx(0.1)
    last = rep["series"][-1]
    assert last["cpu_rate"] == pytest.approx((200 + 900) / 3000)

    r = _client().get("/api/v1/public/daily-report/period",
                      params={"cluster_id": str(cluster.id), "period": "month"})
    assert r.status_code == 200 and len(r.json()["series"]) == 30
    assert _client().get("/api/v1/public/daily-report/period",
                         params={"cluster_id": str(cluster.id), "period": "year"}).status_code == 422


# ── 외부 노출 변경 이력 ─────────────────────────────────────────────────────────
def _svc(ns, name, ip, port):
    return NS(metadata=NS(namespace=ns, name=name),
              spec=NS(type="LoadBalancer", ports=[NS(port=port, node_port=None, protocol="TCP", name="p", target_port=port)],
                      external_i_ps=None),
              status=NS(load_balancer=NS(ingress=[NS(ip=ip, hostname=None)])))


def test_change_history_and_new_badge(db, reset, cluster, monkeypatch):
    from app.models.external_service import ExternalServiceChange
    from app.services import external_services as es
    from app.services import external_checks as chk
    from app.services import external_tls as tls
    current = {"svcs": [_svc("pay", "api", "10.0.0.5", 443)]}

    class Core:
        def __init__(self, _api): ...
        def list_service_for_all_namespaces(self, **_): return NS(items=current["svcs"])
        def list_node(self, **_): return NS(items=[])
        def list_namespace(self, **_): return NS(items=[])

    class Net:
        def __init__(self, _api): ...
        def list_ingress_for_all_namespaces(self, **_): return NS(items=[])
    import kubernetes.client as kc
    import app.services.k8s_client_pool as pool
    monkeypatch.setattr(kc, "CoreV1Api", Core)
    monkeypatch.setattr(kc, "NetworkingV1Api", Net)
    monkeypatch.setattr(pool, "get_api_client", lambda c: object())
    monkeypatch.setattr(es, "resolve_backend", lambda ips, t, emit: {ip: [] for ip in ips})
    monkeypatch.setattr(chk, "probe_backend", lambda targets, t, emit: {})
    monkeypatch.setattr(tls, "fetch_backend", lambda targets, t, emit: {})

    logs = []
    es.collect(db, cluster, emit=lambda lvl, m: logs.append(m))
    assert any("기준선" in m for m in logs)
    assert db.query(ExternalServiceChange).filter_by(cluster_id=cluster.id).count() == 0

    current["svcs"] = [_svc("web", "site", "10.0.0.9", 80)]
    logs.clear()
    es.collect(db, cluster, emit=lambda lvl, m: logs.append(m))
    assert any("새로 열림 1 · 사라짐 1" in m for m in logs)
    view = es.changes_view(db, cluster, 30)
    assert view["added"] == 1 and view["removed"] == 1
    assert {(i["change"], i["namespace"]) for i in view["items"]} == {("added", "web"), ("removed", "pay")}
    pv = es.public_view(db, cluster)
    assert pv["entries"][0]["is_new"] is True and pv["new_badge_days"] == 7

    # 보관 기간 밖 이력은 다음 수집 때 정리
    db.query(ExternalServiceChange).filter_by(cluster_id=cluster.id).update(
        {"detected_at": datetime.utcnow() - timedelta(days=200)})
    db.commit()
    es.collect(db, cluster)
    assert db.query(ExternalServiceChange).filter_by(cluster_id=cluster.id).count() == 0
    assert es.public_view(db, cluster)["entries"][0]["is_new"] is False

    r = _client().get(f"/api/v1/public/external-services/{cluster.id}/changes", params={"days": 30})
    assert r.status_code == 200 and r.json()["total"] == 0
