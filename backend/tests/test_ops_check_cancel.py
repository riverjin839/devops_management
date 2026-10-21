"""운영 점검 취소·큐잉 실패 폴백(P3) — 취소하면 남은 항목을 건너뛰고, 브로커 장애여도 요청이 물리지 않는다."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension, app
from app.models import Cluster, User
from app.models.ops_check import OpsCheckRun, OpsCheckRunItem
from app.services.ops_check_service import OpsCheckService


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def run(db):
    c = Cluster(name=f"oc-{uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:65530")
    db.add(c)
    db.commit()
    r = OpsCheckRun(cluster_id=c.id, status="pending", total=3, triggered_by="t")
    db.add(r)
    db.commit()
    for i in range(3):
        db.add(OpsCheckRunItem(run_id=r.id, source="deep_check", item_ref_id=str(uuid.uuid4()),
                               status="queued", name=f"item-{i}"))
    db.commit()
    yield r
    db.rollback()
    db.query(OpsCheckRunItem).filter(OpsCheckRunItem.run_id == r.id).delete(synchronize_session=False)
    db.query(OpsCheckRun).filter(OpsCheckRun.id == r.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


def test_cancel_marks_queued_items_and_stops_execution(db, run, monkeypatch):
    svc = OpsCheckService(db)
    executed: list[str] = []

    def _fake_item(cluster, item):  # noqa: ANN001
        executed.append(item.name)
        # 첫 항목 실행 중에 사용자가 취소한다(다른 세션).
        other = SessionLocal()
        try:
            OpsCheckService(other).cancel_run(run.id, actor="tester")
        finally:
            other.close()
        from app.models import StatusEnum
        return StatusEnum.healthy, "ok", None, 1

    monkeypatch.setattr(svc, "_run_item", _fake_item)
    svc.execute_run(run.id)
    db.expire_all()
    r = db.query(OpsCheckRun).filter(OpsCheckRun.id == run.id).first()
    items = {i.name: i.status for i in db.query(OpsCheckRunItem).filter(OpsCheckRunItem.run_id == run.id)}
    assert executed == ["item-0"]  # 실행 중이던 항목만 끝나고 나머지는 돌지 않는다
    assert r.status == "cancelled"
    assert items["item-0"] == "done"
    assert items["item-1"] == items["item-2"] == "cancelled"


def test_cancel_endpoint_and_finished_run_untouched(db, run):
    from app.auth.deps import get_current_user

    client = TestClient(app)
    app.dependency_overrides[get_current_user] = lambda: User(username="oc-op", hashed_password="x", role="operator")
    try:
        r = client.post(f"/api/v1/ops-checks/runs/{run.id}/cancel")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "cancelled"
        # 이미 끝난(취소된) 묶음을 다시 취소해도 그대로다.
        assert client.post(f"/api/v1/ops-checks/runs/{run.id}/cancel").json()["status"] == "cancelled"
        assert client.post(f"/api/v1/ops-checks/runs/{uuid.uuid4()}/cancel").status_code == 404
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_broker_failure_does_not_run_inside_request(db, run, monkeypatch):
    """브로커가 죽어도 POST /run 은 바로 돌려주고, 실행은 응답 뒤 백그라운드로 간다."""
    import app.celery_app as celery_app
    import app.routers.ops_check as router_mod
    from app.auth.deps import get_current_user

    class _Broken:
        @staticmethod
        def delay(*_a, **_kw):
            raise RuntimeError("broker down")

    monkeypatch.setattr(celery_app, "run_ops_check_batch", _Broken)
    deferred: list[str] = []
    monkeypatch.setattr(router_mod, "_execute_run_in_background", lambda rid: deferred.append(rid))
    monkeypatch.setattr(OpsCheckService, "execute_run", lambda *_a, **_kw: pytest.fail("요청 안에서 실행하면 안 된다"))

    client = TestClient(app)
    app.dependency_overrides[get_current_user] = lambda: User(username="oc-op2", hashed_password="x", role="operator")
    try:
        r = client.post("/api/v1/ops-checks/run", json={
            "cluster_id": str(run.cluster_id),
            "items": [{"source": "deep_check", "item_ref_id": str(uuid.uuid4()), "check_type": "x", "name": "n"}],
        })
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert r.status_code == 200, r.text
    assert deferred == [r.json()["id"]]
    db.query(OpsCheckRunItem).filter(OpsCheckRunItem.run_id == r.json()["id"]).delete(synchronize_session=False)
    db.query(OpsCheckRun).filter(OpsCheckRun.id == r.json()["id"]).delete(synchronize_session=False)
    db.commit()
