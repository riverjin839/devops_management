"""멀티테넌시 5단계 — 감사 로그 테넌트 귀속 + 테넌트별 백그라운드 실행 동시성 상한 회귀 테스트.

- audit_logs.tenant_id/tenant_name: 대상 테넌트·클러스터 바인딩·행위자 단일 소속으로 추정한다.
- tenants.max_concurrent_runs: 클러스터 소유 테넌트의 Redis 슬롯을 넘는 실행은 재시도로 돌려보내고,
  대기 초과 시 실행 기록에 사유를 남긴다. Redis 가 없으면 제한하지 않는다(fail-open).
실제 DB(+Redis, 없으면 슬롯 테스트는 skip)로 검증한다.
"""
import json
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.ops_check import OpsCheckRun, OpsCheckRunItem
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.user import User
from app.services import audit_logger
from app.services import tenant_concurrency as tc


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()  # 구버전 테스트 DB 에도 audit_logs.tenant_* / tenants.max_concurrent_runs 보강


@pytest.fixture
def db(_schema):
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    users = {
        k: User(username=f"{k}-{tag}", hashed_password="x", role=role)
        for k, role in (("admin", "admin"), ("solo", "operator"), ("multi", "operator"), ("none", "operator"))
    }
    # 이름순: a < b — 소유 테넌트는 operate 우선이므로 read 로 묶인 a 보다 operate 인 b 가 소유자다.
    t_a = Tenant(name=f"a-{tag}")
    t_b = Tenant(name=f"b-{tag}", max_concurrent_runs=1)
    cluster = Cluster(name=f"c-{tag}", api_endpoint="https://c:6443", node_ips=json.dumps(["10.8.0.1"]))
    db.add_all([t_a, t_b, cluster, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=t_a.id, user_id=users["solo"].id),
        TenantMember(tenant_id=t_a.id, user_id=users["multi"].id),
        TenantMember(tenant_id=t_b.id, user_id=users["multi"].id),
        ClusterBinding(tenant_id=t_a.id, cluster_id=cluster.id, access="read"),
        ClusterBinding(tenant_id=t_b.id, cluster_id=cluster.id, access="operate"),
    ])
    db.commit()
    yield {"tag": tag, "a": t_a, "b": t_b, "cluster": cluster, **users}

    db.rollback()
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.action.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    run_ids = [r for (r,) in db.query(OpsCheckRun.id).filter(OpsCheckRun.cluster_id == cluster.id).all()]
    if run_ids:
        db.query(OpsCheckRunItem).filter(OpsCheckRunItem.run_id.in_(run_ids)).delete(synchronize_session=False)
        db.query(OpsCheckRun).filter(OpsCheckRun.id.in_(run_ids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


def _last(db, action):
    db.expire_all()
    return db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.created_at.desc()).first()


# ── 감사 로그 테넌트 귀속 ────────────────────────────────────────────────────

def test_audit_tenant_from_cluster_binding(db, world):
    tag, cid = world["tag"], world["cluster"].id
    # 멤버는 자기가 속한 바인딩 테넌트로 귀속된다(solo 는 read 바인딩인 a).
    audit_logger.record(db, action=f"t.solo.{tag}", actor=world["solo"], target_type="cluster", target_id=cid)
    assert _last(db, f"t.solo.{tag}").tenant_id == str(world["a"].id)
    # 두 테넌트에 다 속하면 operate 바인딩 쪽(b).
    audit_logger.record(db, action=f"t.multi.{tag}", actor=world["multi"], target_type="cluster", target_id=cid)
    assert _last(db, f"t.multi.{tag}").tenant_id == str(world["b"].id)
    # 멤버가 아닌 admin·자동화는 클러스터 소유 테넌트(operate 우선 → b).
    audit_logger.record(db, action=f"t.admin.{tag}", actor=world["admin"], target_type="cluster", target_id=cid)
    row = _last(db, f"t.admin.{tag}")
    assert row.tenant_id == str(world["b"].id) and row.tenant_name == world["b"].name
    audit_logger.record(db, action=f"t.auto.{tag}", actor_username="automation", target_type="cluster",
                        target_id=str(cid))
    assert _last(db, f"t.auto.{tag}").tenant_id == str(world["b"].id)


def test_audit_tenant_from_actor_membership(db, world):
    tag = world["tag"]
    audit_logger.record(db, action=f"t.w1.{tag}", actor=world["solo"], target_type="work_item", target_id="x")
    assert _last(db, f"t.w1.{tag}").tenant_id == str(world["a"].id)
    # 여러 테넌트 소속 / 무소속이면 추정하지 않는다.
    audit_logger.record(db, action=f"t.w2.{tag}", actor=world["multi"], target_type="work_item", target_id="x")
    assert _last(db, f"t.w2.{tag}").tenant_id is None
    audit_logger.record(db, action=f"t.w3.{tag}", actor=world["none"], target_type="work_item", target_id="x")
    assert _last(db, f"t.w3.{tag}").tenant_id is None


def test_audit_tenant_explicit_and_deleted_target(db, world):
    tag = world["tag"]
    gone = uuid.uuid4()
    audit_logger.record(db, action=f"t.del.{tag}", actor=world["admin"], target_type="tenant", target_id=gone,
                        tenant_name="removed-team")
    row = _last(db, f"t.del.{tag}")
    assert row.tenant_id == str(gone) and row.tenant_name == "removed-team"
    audit_logger.record(db, action=f"t.exp.{tag}", actor=world["multi"], tenant_id=world["a"].id)
    row = _last(db, f"t.exp.{tag}")
    assert row.tenant_id == str(world["a"].id) and row.tenant_name == world["a"].name


def test_audit_log_list_tenant_filter(db, world):
    from fastapi.testclient import TestClient
    from app.auth.deps import get_current_user
    from app.main import app

    tag = world["tag"]
    audit_logger.record(db, action=f"t.fa.{tag}", actor=world["solo"])
    audit_logger.record(db, action=f"t.fn.{tag}", actor=world["none"])
    app.dependency_overrides[get_current_user] = lambda: world["admin"]
    try:
        c = TestClient(app)
        r = c.get("/api/v1/audit-logs", params={"tenant_id": str(world["a"].id), "action_prefix": "t.f"})
        actions = {i["action"] for i in r.json()["items"]}
        assert f"t.fa.{tag}" in actions and f"t.fn.{tag}" not in actions
        assert r.json()["items"][0]["tenant_name"] == world["a"].name
        r = c.get("/api/v1/audit-logs", params={"tenant_id": "none", "action_prefix": f"t.fn.{tag}"})
        assert [i["action"] for i in r.json()["items"]] == [f"t.fn.{tag}"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── 동시 실행 상한 ───────────────────────────────────────────────────────────

def _redis_or_skip():
    try:
        import redis

        r = redis.Redis.from_url(os.environ["REDIS_URL"], socket_connect_timeout=1)
        r.ping()
        return r
    except Exception:  # noqa: BLE001
        pytest.skip("Redis 미가용 — 슬롯 테스트 생략")


class _Retry(Exception):
    pass


class _FakeTask:
    def __init__(self, task_id=None, retries=0):
        self.request = type("R", (), {"id": task_id or uuid.uuid4().hex, "retries": retries})()
        self.retry_kwargs = None

    def retry(self, **kw):
        self.retry_kwargs = kw
        return _Retry()


def test_owner_tenant_prefers_operate(db, world):
    assert tc.owner_tenant(db, world["cluster"].id).id == world["b"].id
    assert tc.owner_tenant(db, str(world["cluster"].id)).id == world["b"].id  # 태스크는 문자열 id 를 넘긴다
    assert tc.owner_tenant(db, "not-a-uuid") is None
    assert tc.owner_tenant(db, uuid.uuid4()) is None


def test_slots_acquire_release_snapshot(world):
    r = _redis_or_skip()
    slots = tc.TenantRunSlots(lambda: r)
    tid = f"test-{world['tag']}"
    assert slots.try_acquire(tid, 1, "t1", {"kind": "batch_job", "ref": "j1"}) is True
    assert slots.try_acquire(tid, 1, "t2", {"kind": "batch_job", "ref": "j2"}) is False
    slots.mark_waiting(tid, "t2", {"kind": "batch_job", "ref": "j2"})
    snap = slots.snapshot(tid)
    assert [m["ref"] for m in snap["running"]] == ["j1"]
    assert [m["ref"] for m in snap["waiting"]] == ["j2"]
    slots.release(tid, "t1")
    assert slots.try_acquire(tid, 1, "t2", {"kind": "batch_job", "ref": "j2"}) is True
    snap = slots.snapshot(tid)
    assert [m["ref"] for m in snap["running"]] == ["j2"] and snap["waiting"] == []  # 획득 시 대기 해제
    slots.release(tid, "t2")


def test_acquire_run_slot_waits_then_times_out(db, world):
    r = _redis_or_skip()
    slots = tc.TenantRunSlots(lambda: r)
    cid = world["cluster"].id
    held = tc.acquire_run_slot(_FakeTask(), db, cluster_id=cid, kind="ops_check", ref="r1", slots=slots)
    assert held.tenant_id == str(world["b"].id)  # b 의 상한 1 을 차지

    notes: list[str] = []
    task = _FakeTask()
    with pytest.raises(_Retry):
        tc.acquire_run_slot(task, db, cluster_id=cid, kind="ops_check", ref="r2", on_wait=notes.append,
                            slots=slots)
    assert task.retry_kwargs["countdown"] == tc.WAIT_INTERVAL
    assert "동시 실행 상한(1건)" in notes[0]
    assert [m["ref"] for m in slots.snapshot(str(world["b"].id))["waiting"]] == ["r2"]

    late = _FakeTask(task_id=task.request.id, retries=tc.MAX_WAIT_RETRIES)
    with pytest.raises(tc.TenantRunLimitTimeout):
        tc.acquire_run_slot(late, db, cluster_id=cid, kind="ops_check", ref="r2", slots=slots)
    assert slots.snapshot(str(world["b"].id))["waiting"] == []

    # 호출부별 대기 상한(점검 매트릭스는 stale 스위퍼보다 짧게)
    with pytest.raises(tc.TenantRunLimitTimeout):
        tc.acquire_run_slot(_FakeTask(retries=5), db, cluster_id=cid, kind="check_matrix_run", ref="r3",
                            slots=slots, max_wait_retries=5)

    held.release()
    ok = tc.acquire_run_slot(_FakeTask(task_id=task.request.id, retries=3), db, cluster_id=cid,
                             kind="ops_check", ref="r2", on_wait=notes.append, slots=slots)
    assert "슬롯 확보" in notes[-1]
    ok.release()


def test_acquire_run_slot_noop_without_limit_or_redis(db, world):
    # Redis 불가 → 제한 없이 진행
    s = tc.acquire_run_slot(_FakeTask(), db, cluster_id=world["cluster"].id, kind="deep_check", ref="x",
                            slots=tc.TenantRunSlots(lambda: None))
    assert s.tenant_id is None
    # 바인딩 없는 클러스터 → 제한 없음
    s = tc.acquire_run_slot(_FakeTask(), db, cluster_id=uuid.uuid4(), kind="deep_check", ref="x",
                            slots=tc.TenantRunSlots(lambda: None))
    assert s.tenant_id is None


def test_ops_check_task_records_timeout(db, world, monkeypatch):
    """대기 초과 시 운영 점검 항목에 사유가 남고 묶음이 종료된다(콘솔 "로그 보기"에 노출)."""
    from app import celery_app as ca

    run = OpsCheckRun(cluster_id=world["cluster"].id, status="pending", total=1, triggered_by="t")
    db.add(run)
    db.commit()
    db.add(OpsCheckRunItem(run_id=run.id, source="deep_check", item_ref_id=str(uuid.uuid4()), status="queued", name="x"))
    db.commit()

    def _timeout(*a, **kw):
        raise tc.TenantRunLimitTimeout("테넌트 상한 대기 초과")

    monkeypatch.setattr(tc, "acquire_run_slot", _timeout)
    out = ca.run_ops_check_batch.run(str(run.id))
    assert out["error"] == "tenant_limit_timeout"
    db.expire_all()
    run = db.query(OpsCheckRun).filter(OpsCheckRun.id == run.id).first()
    item = db.query(OpsCheckRunItem).filter(OpsCheckRunItem.run_id == run.id).first()
    assert run.status == "done" and item.status == "error" and "상한 대기 초과" in item.message


def test_tenant_limit_api(db, world):
    from fastapi.testclient import TestClient
    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: world["admin"]
    try:
        c = TestClient(app)
        r = c.put(f"/api/v1/tenants/{world['a'].id}", json={"max_concurrent_runs": 3})
        assert r.status_code == 200 and r.json()["max_concurrent_runs"] == 3
        assert c.put(f"/api/v1/tenants/{world['a'].id}", json={"max_concurrent_runs": -1}).status_code == 422
        slots = {s["tenant_name"]: s for s in c.get("/api/v1/tenants/run-slots").json()}
        assert slots[world["a"].name]["limit"] == 3 and slots[world["b"].name]["limit"] == 1
        # 0 = 제한 해제 → 목록에서 빠진다
        assert c.put(f"/api/v1/tenants/{world['a'].id}", json={"max_concurrent_runs": 0}).json()[
            "max_concurrent_runs"] is None
        assert world["a"].name not in {s["tenant_name"] for s in c.get("/api/v1/tenants/run-slots").json()}
        # 수정 감사 로그는 그 테넌트로 귀속된다
        row = _last(db, "tenant.update")
        assert row.tenant_id == str(world["a"].id)
        app.dependency_overrides[get_current_user] = lambda: world["solo"]
        assert c.get("/api/v1/tenants/run-slots").status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)
