"""NS 마이그레이션 라우터 — 권한(viewer 403·같은 클러스터 422), run 큐잉/조회, 프로필 CRUD.

PostgreSQL 필요(TestClient + 실제 세션). Celery 큐잉은 monkeypatch 로 대체한다.
"""
import uuid
from types import SimpleNamespace as NS

import pytest


@pytest.fixture
def db():
    from app.database import Base, SessionLocal, engine
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

    from app.auth.deps import get_current_user
    from app.main import app
    app.dependency_overrides[get_current_user] = lambda: NS(id=uuid.uuid4(), username="tester", role=role,
                                                             display_name="tester")
    return TestClient(app)


@pytest.fixture
def client_for():
    made = []

    def make(role):
        made.append(role)
        return _client(role)
    yield make
    from app.auth.deps import get_current_user
    from app.main import app
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def clusters(db):
    from app.models import Cluster
    cs = [Cluster(id=uuid.uuid4(), name=f"nsm-{n}-{uuid.uuid4().hex[:6]}", api_endpoint="https://x") for n in ("dev", "prod")]
    db.add_all(cs)
    db.commit()
    try:
        yield cs
    finally:
        from app.models.ns_migration import NsMigrationProfile, NsMigrationRun
        ids = [c.id for c in cs]
        db.query(NsMigrationRun).filter(NsMigrationRun.source_cluster_id.in_(ids)).delete(synchronize_session=False)
        db.query(NsMigrationProfile).filter(NsMigrationProfile.source_cluster_id.in_(ids)).delete(synchronize_session=False)
        for c in cs:
            db.delete(c)
        db.commit()


@pytest.fixture
def no_celery(monkeypatch):
    calls = []

    class _T:
        id = "task-1"

    import app.celery_app as ca
    monkeypatch.setattr(ca.run_ns_migration, "delay", lambda *a: calls.append(a) or _T())
    return calls


def _body(cs, **over):
    b = {"source_cluster_id": str(cs[0].id), "target_cluster_id": str(cs[1].id),
         "source_namespace": "team-a", "target_namespace": "team-a", "kinds": ["ServiceAccount", "Deployment"]}
    b.update(over)
    return b


def test_kinds_catalog(db, client_for):
    r = client_for("viewer").get("/api/v1/ns-migration/kinds")
    assert r.status_code == 200
    kinds = {k["kind"]: k["group"] for k in r.json()["data"]}
    assert kinds["ServiceAccount"] == "base" and kinds["Deployment"] == "workload" and kinds["Secret"] == "secret"


def test_viewer_cannot_run(client_for, clusters, no_celery):
    r = client_for("viewer").post("/api/v1/ns-migration/runs", json=_body(clusters))
    assert r.status_code == 403
    assert no_celery == []


def test_same_cluster_and_bad_input_rejected(client_for, clusters, no_celery):
    c = client_for("operator")
    assert c.post("/api/v1/ns-migration/runs",
                  json=_body(clusters, target_cluster_id=str(clusters[0].id))).status_code == 422
    assert c.post("/api/v1/ns-migration/runs", json=_body(clusters, kinds=["Pod"])).status_code == 422
    assert c.post("/api/v1/ns-migration/runs", json=_body(clusters, target_namespace="Bad_NS")).status_code == 422


def test_create_and_get_run(client_for, clusters, no_celery):
    c = client_for("operator")
    r = c.post("/api/v1/ns-migration/runs", json=_body(clusters, mode="apply", rules=[
        {"type": "image_registry", "from": "dev/", "to": "prod/"}]))
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["run_state"] == "queued" and run["mode"] == "apply" and run["dry_run"] is False
    assert [s["id"] for s in run["steps"]] == ["collect", "compare", "apply"]
    assert run["spec"]["rules"][0]["from"] == "dev/"
    assert no_celery == [(run["id"],)]
    got = c.get(f"/api/v1/ns-migration/runs/{run['id']}").json()
    assert got["id"] == run["id"] and got["items"] == {"resources": [], "skipped": []}
    listed = c.get("/api/v1/ns-migration/runs").json()["data"]
    assert any(x["id"] == run["id"] for x in listed)


def test_profile_crud(client_for, clusters):
    c = client_for("operator")
    r = c.post("/api/v1/ns-migration/profiles", json={**_body(clusters), "name": "team-a 운영 반영",
                                                      "rules": [{"type": "replicas", "to": "3", "kind": "Deployment"}]})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert r.json()["rules"][0]["to"] == "3"
    r = c.put(f"/api/v1/ns-migration/profiles/{pid}", json={**_body(clusters, target_namespace="team-a-prod"), "name": "x"})
    assert r.json()["target_namespace"] == "team-a-prod"
    assert any(p["id"] == pid for p in c.get("/api/v1/ns-migration/profiles").json()["data"])
    assert c.delete(f"/api/v1/ns-migration/profiles/{pid}").status_code == 200
    assert client_for("viewer").post("/api/v1/ns-migration/profiles",
                                     json={**_body(clusters), "name": "v"}).status_code == 403


def test_namespaces_fail_safe(client_for, clusters):
    r = client_for("viewer").get(f"/api/v1/ns-migration/clusters/{clusters[0].id}/namespaces")
    assert r.status_code == 200
    assert r.json()["data"] == [] and r.json()["error"]


def test_execute_run_records_steps_logs_and_items(db, clusters, monkeypatch):
    from app.models.ns_migration import NsMigrationRun
    from app.services.ns_migration import engine
    from tests.test_ns_migration_engine import SOURCE, FakeDyn

    src_dyn, dst_dyn = FakeDyn(SOURCE), FakeDyn([])
    monkeypatch.setattr(engine, "dynamic_client", lambda c: src_dyn if c.id == clusters[0].id else dst_dyn)
    run = NsMigrationRun(source_cluster_id=clusters[0].id, target_cluster_id=clusters[1].id,
                         source_namespace="dev", target_namespace="prod", mode="apply", dry_run=False,
                         spec={"kinds": ["ServiceAccount", "ConfigMap"], "include_secrets": False, "rules": []},
                         steps=[], log_lines="")
    db.add(run)
    db.commit()
    engine.execute_run(db, run, clusters[0], clusters[1])
    db.refresh(run)
    assert run.run_state == "succeeded", run.log_lines
    assert {s["id"]: s["status"] for s in run.steps} == {"collect": "success", "compare": "success", "apply": "success"}
    assert run.summary["create"] == 3 and run.summary["skipped"] == 1
    assert "[ConfigMap/cfg] 생성 완료" in run.log_lines
    assert ("ConfigMap", "prod", "cfg") in dst_dyn.store
