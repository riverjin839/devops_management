"""효율화 라우터 — 권한(viewer 403), recommend_only 적용 거부(422), 정책 CRUD, 추천/이력 조회, run 조회.

PostgreSQL 필요(TestClient + 실제 세션). Celery 큐잉은 monkeypatch 로 대체한다.
"""
import uuid
from datetime import datetime
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


def _client(role: str):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    app.dependency_overrides[get_current_user] = lambda: NS(id=uuid.uuid4(), username="tester", role=role)
    return TestClient(app)


@pytest.fixture
def admin_client():
    c = _client("admin")
    try:
        yield c
    finally:
        from app.main import app
        from app.auth.deps import get_current_user
        app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def viewer_client():
    c = _client("viewer")
    try:
        yield c
    finally:
        from app.main import app
        from app.auth.deps import get_current_user
        app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def cluster(db):
    from app.models import Cluster
    c = Cluster(id=uuid.uuid4(), name=f"eff-test-{uuid.uuid4().hex[:6]}", api_endpoint="https://x")
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
def no_celery(monkeypatch):
    calls = []

    class _T:
        id = "task-1"

    import app.celery_app as ca
    for name in ("collect_k8s_efficiency_one", "run_k8s_efficiency_run", "run_k8s_efficiency_recommend"):
        monkeypatch.setattr(getattr(ca, name), "delay", lambda *a, _n=name, **k: (calls.append((_n, a)), _T())[1])
    return calls


def _rec(db, cluster, **kw):
    from app.models.k8s_efficiency import K8sRightsizeRecommendation
    base = dict(
        cluster_id=cluster.id, namespace="app", kind="Deployment", name="web", container="web", resource="cpu",
        pod_count=2, current_req=1000, target_req=250, savings=1500, usage_source="metrics", samples=20,
        window_days=7, status="open", created_at=datetime.utcnow(), updated_at=datetime.utcnow(),
    )
    base.update(kw)
    r = K8sRightsizeRecommendation(**base)
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def test_viewer_cannot_apply_or_change_policy(viewer_client, cluster):
    r = viewer_client.post(f"/api/v1/k8s/{cluster.id}/efficiency/apply", json={"recommendation_ids": [str(uuid.uuid4())], "dry_run": True})
    assert r.status_code == 403
    r = viewer_client.put(f"/api/v1/k8s/{cluster.id}/efficiency/policies/app", json={"auto_rightsize": True})
    assert r.status_code == 403
    r = viewer_client.put("/api/v1/k8s/efficiency/policy-defaults", json={"automation_enabled": True})
    assert r.status_code == 403
    # 조회는 가능
    assert viewer_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/recommendations").status_code == 200


def test_apply_rejects_operator_managed_and_creates_run(admin_client, db, cluster, no_celery):
    managed = _rec(db, cluster, recommend_only=True, hint="오퍼레이터 관리 — CR spec 에서 조정하세요",
                   managed_by={"kind": "StarRocksCluster", "name": "sr"}, name="cn")
    r = admin_client.post(f"/api/v1/k8s/{cluster.id}/efficiency/apply",
                          json={"recommendation_ids": [str(managed.id)], "dry_run": True})
    assert r.status_code == 422 and "오퍼레이터" in r.json()["detail"]

    ok = _rec(db, cluster)
    r = admin_client.post(f"/api/v1/k8s/{cluster.id}/efficiency/apply",
                          json={"recommendation_ids": [str(ok.id)], "dry_run": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["targets"][0]["requests"] == {"cpu": "250m"}
    assert no_celery and no_celery[-1][0] == "run_k8s_efficiency_run"
    run = admin_client.get(f"/api/v1/k8s/efficiency/runs/{body['run_id']}").json()
    assert run["run_state"] == "queued" and run["dry_run"] is True and run["run_type"] == "rightsize_apply"
    lst = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/runs").json()
    assert lst["count"] >= 1
    # dry-run 은 롤백 불가
    r = admin_client.post(f"/api/v1/k8s/efficiency/runs/{body['run_id']}/rollback")
    assert r.status_code == 422


def test_recommendations_list_totals_and_dismiss(admin_client, db, cluster):
    a = _rec(db, cluster)
    _rec(db, cluster, resource="memory", current_req=1024 ** 3, target_req=512 * 1024 ** 2, savings=1024 ** 3, recommend_only=True)
    r = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/recommendations").json()
    assert r["count"] == 2
    assert r["totals"]["cpu_m"] == 1500 and r["totals"]["applicable"] == 1 and r["totals"]["recommend_only"] == 1
    assert r["items"][0]["current_req_display"] in ("1000m", "1024Mi")
    d = admin_client.post(f"/api/v1/k8s/{cluster.id}/efficiency/recommendations/{a.id}/dismiss")
    assert d.status_code == 200 and d.json()["status"] == "dismissed"
    r = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/recommendations").json()
    assert r["count"] == 1


def test_policy_crud_and_validation(admin_client, cluster):
    bad = admin_client.put(f"/api/v1/k8s/{cluster.id}/efficiency/policies/app",
                           json={"quota_cpu_min_m": 2000, "quota_cpu_max_m": 1000})
    assert bad.status_code == 422
    body = {
        "auto_rightsize": True, "quota_elastic": True, "quota_name": "q", "quota_cpu_min_m": 1000, "quota_cpu_max_m": 8000,
        "rightsize_params": {"headroom_pct": 50},
        "custom_targets": [{"label": "StarRocks CN", "group": "starrocks.com", "version": "v1", "plural": "starrockslusters",
                            "name": "sr", "jsonpath": "spec.starRocksCnSpec.replicas", "min": 2, "max": 6}],
    }
    r = admin_client.put(f"/api/v1/k8s/{cluster.id}/efficiency/policies/app", json=body)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["auto_rightsize"] is True and p["custom_targets"][0]["jsonpath"] == "spec.starRocksCnSpec.replicas"
    lst = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/policies").json()
    assert lst["count"] == 1
    # custom scale: 범위 밖 값 거부
    r = admin_client.post(f"/api/v1/k8s/{cluster.id}/efficiency/custom-targets/scale",
                          json={"namespace": "app", "target_index": 0, "value": 99, "dry_run": True})
    assert r.status_code == 422
    assert admin_client.delete(f"/api/v1/k8s/{cluster.id}/efficiency/policies/app").status_code == 204
    assert admin_client.delete(f"/api/v1/k8s/{cluster.id}/efficiency/policies/app").status_code == 404


def test_history_endpoints_and_schedule(admin_client, db, cluster):
    from app.models.k8s_efficiency import K8sNamespaceSample
    now = datetime.utcnow()
    db.add(K8sNamespaceSample(cluster_id=cluster.id, namespace="app", sampled_at=now, pod_count=3, workload_count=1,
                              cpu_req_m=1000, mem_req_b=1024 ** 3, cpu_use_m=200, mem_use_b=512 * 1024 ** 2,
                              usage_source="metrics", quota_name="q", quota_hard_cpu_m=4000, quota_used_cpu_m=1000))
    db.commit()
    s = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/history/namespaces", params={"namespace": "app", "range": "24h"}).json()
    assert s["points"] and s["points"][-1]["cpu_req"] == 1000 and s["points"][-1]["cpu_quota"] == 4000
    rk = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/history/ranking", params={"range": "24h", "metric": "cpu"}).json()
    assert rk["items"][0]["namespace"] == "app" and abs(rk["items"][0]["avg_efficiency"] - 0.2) < 1e-6
    sm = admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/history/summary").json()
    assert sm["items"][0]["quota_name"] == "q"
    assert admin_client.get(f"/api/v1/k8s/{cluster.id}/efficiency/history/namespaces", params={"namespace": "app", "range": "1y"}).status_code == 422

    r = admin_client.put("/api/v1/k8s/efficiency/schedule", json={"enabled": True, "default_cron": "*/5 * * * *",
                                                                   "clusters": {str(cluster.id): {"enabled": False, "cron": None}}})
    assert r.status_code == 200 and r.json()["default_cron"] == "*/5 * * * *"
    g = admin_client.get("/api/v1/k8s/efficiency/schedule").json()
    assert g["default_cron"] == "*/5 * * * *" and g["clusters"][str(cluster.id)]["enabled"] is False
    assert admin_client.put("/api/v1/k8s/efficiency/schedule", json={"enabled": True, "default_cron": "bad"}).status_code == 422
    d = admin_client.put("/api/v1/k8s/efficiency/policy-defaults", json={"headroom_pct": 40, "quota": {"up_threshold": 0.9}}).json()
    assert d["headroom_pct"] == 40 and d["quota"]["up_threshold"] == 0.9 and d["automation_enabled"] is False
