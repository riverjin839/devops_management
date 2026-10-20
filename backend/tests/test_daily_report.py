"""일일 리포트 — 일 단위 집계·롤업 저장·비효율 랭킹·공개 API(비인증)·보관기간·테넌트 격리.

PostgreSQL 필요(TestClient + 실제 세션).
"""
import uuid
from datetime import timedelta

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
def settings_reset(db):
    from app.models.app_setting import AppSetting
    from app.services.k8s_efficiency import daily_report as dr
    db.query(AppSetting).filter(AppSetting.key == dr.SETTINGS_KEY).delete()
    db.commit()
    yield
    db.query(AppSetting).filter(AppSetting.key == dr.SETTINGS_KEY).delete()
    db.commit()


@pytest.fixture
def cluster(db):
    from app.models import Cluster
    c = Cluster(id=uuid.uuid4(), name=f"dr-test-{uuid.uuid4().hex[:6]}", api_endpoint="https://x")
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


def _seed(db, cluster, day, ns, cpu_req, cpu_uses, mem_req=2 * 1024 ** 3, mem_use=1024 ** 3):
    """현지 day 정오 근처에 샘플 여러 개."""
    from app.models.k8s_efficiency import K8sNamespaceSample
    from app.services.k8s_efficiency import daily_report as dr
    start, _ = dr.day_window_utc(day)
    for i, u in enumerate(cpu_uses):
        db.add(K8sNamespaceSample(
            cluster_id=cluster.id, namespace=ns, sampled_at=start + timedelta(hours=6, minutes=10 * i),
            pod_count=2, cpu_req_m=cpu_req, cpu_lim_m=cpu_req * 2, mem_req_b=mem_req, mem_lim_b=mem_req * 2,
            cpu_use_m=u, mem_use_b=mem_use, usage_source="metrics"))
    db.commit()


def test_aggregate_day_stats(db, cluster):
    from app.services.k8s_efficiency import daily_report as dr
    day = dr.today_local() - timedelta(days=1)
    _seed(db, cluster, day, "team-a", 1000, [100, 200, 300])
    rows = dr.aggregate_day(db, cluster.id, day)
    assert len(rows) == 1
    r = rows[0]
    assert r["samples"] == 3 and r["cpu_req_m"] == 1000 and r["cpu_lim_m"] == 2000
    assert r["cpu_use_avg_m"] == 200 and r["cpu_use_min_m"] == 100 and r["cpu_use_max_m"] == 300
    assert r["cpu_rate_min"] == pytest.approx(0.1) and r["cpu_rate_max"] == pytest.approx(0.3)
    # 다른 날 샘플은 섞이지 않는다
    assert dr.aggregate_day(db, cluster.id, day - timedelta(days=1)) == []


def test_build_report_backfill_then_rollup_and_rank(db, cluster, settings_reset):
    from app.services.k8s_efficiency import daily_report as dr
    day = dr.today_local() - timedelta(days=1)
    _seed(db, cluster, day, "busy", 1000, [900, 950])
    _seed(db, cluster, day, "idle", 2000, [20, 40])
    _seed(db, cluster, day, "tiny", 50, [1, 1])          # min_cpu_req_m(100) 미만 → 랭킹 제외
    _seed(db, cluster, day, "kube-system", 4000, [1, 1])  # 시스템 NS 제외

    rep = dr.build_report(db, cluster, day, "cpu_rate")
    assert rep["source"] == "backfill"
    assert [it["namespace"] for it in rep["items"]] == ["idle", "busy"]
    assert rep["items"][0]["rank"] == 1 and rep["items"][0]["cpu"]["slack"] == 1970
    assert rep["items"][0]["gpu"] == {"req": None, "lim": None}
    assert rep["summary"]["namespaces"] == 4

    rep2 = dr.build_report(db, cluster, day, "cpu_slack")
    assert rep2["source"] == "rollup"
    assert rep2["items"][0]["namespace"] == "idle"


def test_today_is_live_not_stored(db, cluster, settings_reset):
    from app.models.k8s_efficiency import K8sNsDailyReport
    from app.services.k8s_efficiency import daily_report as dr
    today = dr.today_local()
    start, _ = dr.day_window_utc(today)
    from app.models.k8s_efficiency import K8sNamespaceSample
    db.add(K8sNamespaceSample(cluster_id=cluster.id, namespace="live", sampled_at=start + timedelta(minutes=1),
                              pod_count=1, cpu_req_m=500, mem_req_b=1024 ** 3, cpu_use_m=10, mem_use_b=1))
    db.commit()
    rep = dr.build_report(db, cluster, today)
    assert rep["source"] == "live" and rep["is_today"]
    assert db.query(K8sNsDailyReport).filter(K8sNsDailyReport.cluster_id == cluster.id).count() == 0


def test_rollup_recent_and_purge(db, cluster, settings_reset):
    from app.models.k8s_efficiency import K8sNsDailyReport
    from app.services.k8s_efficiency import daily_report as dr
    dr.set_settings(db, {"retention_days": 3})
    y = dr.today_local() - timedelta(days=1)
    _seed(db, cluster, y, "a", 1000, [10])
    old = dr.today_local() - timedelta(days=10)
    db.add(K8sNsDailyReport(cluster_id=cluster.id, report_date=old, namespace="old"))
    db.commit()
    res = dr.rollup_recent(db, days=1)
    assert res["built"][f"{cluster.name}:{y.isoformat()}"] == 1
    assert res["purged"] >= 1
    dates = {r.report_date for r in db.query(K8sNsDailyReport).filter(K8sNsDailyReport.cluster_id == cluster.id)}
    assert dates == {y}


def test_public_api_no_auth_and_bounds(db, cluster, settings_reset):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.k8s_efficiency import daily_report as dr
    client = TestClient(app)
    r = client.get("/api/v1/public/daily-report/clusters")
    assert r.status_code == 200
    assert str(cluster.id) in {c["id"] for c in r.json()["clusters"]}

    r = client.get("/api/v1/public/daily-report/report", params={"cluster_id": str(cluster.id)})
    assert r.status_code == 200 and r.json()["is_today"] is True

    future = (dr.today_local() + timedelta(days=1)).isoformat()
    assert client.get("/api/v1/public/daily-report/report",
                      params={"cluster_id": str(cluster.id), "date": future}).status_code == 400
    too_old = (dr.today_local() - timedelta(days=31)).isoformat()
    assert client.get("/api/v1/public/daily-report/report",
                      params={"cluster_id": str(cluster.id), "date": too_old}).status_code == 400
    assert client.get("/api/v1/public/daily-report/report",
                      params={"cluster_id": str(cluster.id), "rank_by": "bogus"}).status_code == 422

    # 설정 변경 API 는 인증 필요
    assert client.put("/api/v1/daily-report/settings", json={"top_n": 5}).status_code == 401

    dr.set_settings(db, {"public_enabled": False})
    assert client.get("/api/v1/public/daily-report/clusters").status_code == 404


def test_public_excludes_tenant_bound_cluster(db, cluster, settings_reset):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models.tenant import ClusterBinding, Tenant
    t = Tenant(name=f"t-{uuid.uuid4().hex[:6]}")
    db.add(t)
    db.flush()
    db.add(ClusterBinding(tenant_id=t.id, cluster_id=cluster.id, access="operate"))
    db.commit()
    try:
        client = TestClient(app)
        ids = {c["id"] for c in client.get("/api/v1/public/daily-report/clusters").json()["clusters"]}
        assert str(cluster.id) not in ids
        assert client.get("/api/v1/public/daily-report/report",
                          params={"cluster_id": str(cluster.id)}).status_code == 404
    finally:
        db.delete(t)
        db.commit()


def test_search_by_namespace_workload_and_pod(db, cluster, settings_reset):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models.k8s_efficiency import K8sWorkloadSample
    from app.services.k8s_efficiency import daily_report as dr
    day = dr.today_local() - timedelta(days=1)
    _seed(db, cluster, day, "team-billing", 2000, [20, 40])
    _seed(db, cluster, day, "team-search", 1000, [900])
    start, _ = dr.day_window_utc(day)
    db.add(K8sWorkloadSample(cluster_id=cluster.id, namespace="team-search", kind="Deployment", name="indexer",
                             sampled_at=start + timedelta(hours=7), pods=["indexer-7f9c-abcde", "indexer-7f9c-xyz12"]))
    db.commit()

    by_ns = dr.search_report(db, cluster, day, "BILLING")
    assert [it["namespace"] for it in by_ns["items"]] == ["team-billing"]
    assert by_ns["items"][0]["rank"] == 1 and by_ns["items"][0]["match"]["namespace"] is True

    by_pod = dr.search_report(db, cluster, day, "xyz12")
    assert [it["namespace"] for it in by_pod["items"]] == ["team-search"]
    wl = by_pod["items"][0]["match"]["workloads"][0]
    assert wl["name"] == "indexer" and wl["pods"] == ["indexer-7f9c-xyz12"]

    by_wl = dr.search_report(db, cluster, day, "indexer")
    assert by_wl["items"][0]["match"]["workloads"][0]["pod_matches"] == 2

    assert dr.search_report(db, cluster, day, "nomatch")["total"] == 0

    client = TestClient(app)
    r = client.get("/api/v1/public/daily-report/search",
                   params={"cluster_id": str(cluster.id), "date": day.isoformat(), "q": "team"})
    assert r.status_code == 200 and r.json()["total"] == 2
    assert client.get("/api/v1/public/daily-report/search",
                      params={"cluster_id": str(cluster.id), "q": "a"}).status_code == 422
