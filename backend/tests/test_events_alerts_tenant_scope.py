"""D-101~D-103 — K8s 이벤트·알람의 클러스터 귀속과 테넌트 범위 회귀 테스트.

이전에는
  - kubewatch ingest 가 cluster_id 를 항상 NULL 로 저장해 클러스터 필터가 늘 빈 목록이었고,
    NULL 행은 누구에게나 보여 테넌트 격리가 무력했으며 critical 알림이 전원에게 갔다(D-101).
  - 이벤트 삭제에 operator·범위 검사가 없었다(D-102).
  - 알람 확인·일괄 확인·삭제·분석이 테넌트 범위를 보지 않았고, 일괄 확인은 상태·검색 필터를 무시했다(D-103).
실제 DB 로 검증한다.
"""
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension
from app.models.alert_event import AlertEvent
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.k8s_event import K8sEvent
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.user import User
from app.models.user_notification import UserNotification

TOKEN = {"Authorization": "Bearer kw-test-token"}
CRASH = {
    "type": "MODIFIED",
    "object": {
        "kind": "Pod",
        "metadata": {"name": "api-abc", "namespace": "prod-api"},
        "status": {"reason": "CrashLoopBackOff", "message": "back-off"},
    },
}


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    """바인딩된 클러스터 1개 + 테넌트 1개 + 사용자(operator 멤버/operator 비멤버/viewer 멤버)."""
    tag = uuid.uuid4().hex[:8]
    bound = Cluster(name=f"ev-bound-{tag}", api_endpoint="https://bound:6443")
    users = {
        key: User(username=f"{key}-{tag}", hashed_password="x", role=role)
        for key, role in (("op_member", "operator"), ("op_outsider", "operator"), ("viewer_member", "viewer"))
    }
    tenant = Tenant(name=f"ev-team-{tag}")
    db.add_all([bound, tenant, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["op_member"].id),
        TenantMember(tenant_id=tenant.id, user_id=users["viewer_member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=bound.id, access="operate"),
    ])
    db.commit()
    yield {"bound": bound, "tag": tag, **users}
    uids = [u.id for u in users.values()]
    names = [u.username for u in users.values()]
    db.query(K8sEvent).filter(K8sEvent.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(K8sEvent).filter(K8sEvent.resource_name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(AlertEvent).filter(AlertEvent.alertname.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(UserNotification).filter(UserNotification.recipient.in_(names)).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == bound.id).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client_as():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def anon(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.config import settings

    monkeypatch.setattr(settings, "kubewatch_token", "kw-test-token")
    return TestClient(app)


def _payload(name: str) -> dict:
    return {**CRASH, "object": {**CRASH["object"], "metadata": {"name": name, "namespace": "prod-api"}}}


def _event(db, cluster_id, tag, **kw) -> K8sEvent:
    ev = K8sEvent(cluster_id=cluster_id, event_type="MODIFIED", resource_kind="Pod",
                  resource_name=f"pod-{tag}", namespace="ns", reason="OOMKilled", message="m",
                  severity="critical", **kw)
    db.add(ev)
    db.commit()
    return ev


def _alert(db, cluster_id, tag, **kw) -> AlertEvent:
    a = AlertEvent(cluster_id=cluster_id, fingerprint=uuid.uuid4().hex, alertname=f"Alert-{tag}",
                   severity=kw.pop("severity", "critical"), status=kw.pop("status", "firing"), **kw)
    db.add(a)
    db.commit()
    return a


# ── D-101 ingest 클러스터 귀속 ───────────────────────────────────────────────

def test_ingest_attributes_cluster_by_name_and_id(anon, world, db):
    bound = world["bound"]
    r = anon.post(f"/api/v1/events/kubewatch?cluster={bound.name}", json=_payload(f"by-name-{world['tag']}"),
                  headers=TOKEN)
    assert r.status_code == 201, r.text
    assert r.json()["cluster_id"] == str(bound.id)
    r = anon.post(f"/api/v1/events/kubewatch?cluster={bound.id}", json=_payload(f"by-id-{world['tag']}"),
                  headers=TOKEN)
    assert r.json()["cluster_id"] == str(bound.id)
    assert db.query(K8sEvent).filter(K8sEvent.cluster_id == bound.id).count() == 2


def test_ingest_unknown_cluster_is_stored_unattributed_with_warning(anon, world, db):
    r = anon.post("/api/v1/events/kubewatch?cluster=no-such-cluster", json=_payload(f"unk-{world['tag']}"),
                  headers=TOKEN)
    assert r.status_code == 201
    assert r.json()["cluster_id"] is None
    assert "no-such-cluster" in r.json()["warning"]


def test_critical_event_notifies_only_users_who_can_see_the_cluster(anon, world, db):
    bound = world["bound"]
    r = anon.post(f"/api/v1/events/kubewatch?cluster={bound.name}", json=_payload(f"notify-{world['tag']}"),
                  headers=TOKEN)
    assert r.status_code == 201
    got = {n.recipient for n in db.query(UserNotification).filter(
        UserNotification.type == "k8s_event",
        UserNotification.recipient.in_([world[k].username for k in ("op_member", "op_outsider", "viewer_member")]),
    ).all()}
    assert got == {world["op_member"].username, world["viewer_member"].username}


def test_cluster_filter_and_outsider_list_isolation(client_as, world, db):
    ev = _event(db, world["bound"].id, world["tag"])
    member = client_as(world["viewer_member"]).get(f"/api/v1/events/?cluster_id={world['bound'].id}")
    assert [e["id"] for e in member.json()["data"]] == [str(ev.id)]
    outsider = client_as(world["op_outsider"]).get("/api/v1/events/?limit=500")
    assert str(ev.id) not in {e["id"] for e in outsider.json()["data"]}


# ── D-102 이벤트 삭제·분석 ───────────────────────────────────────────────────

def test_event_delete_requires_operator_and_cluster_access(client_as, world, db):
    ev_id = _event(db, world["bound"].id, world["tag"]).id
    url = f"/api/v1/events/{ev_id}"
    assert client_as(world["viewer_member"]).delete(url).status_code == 403
    assert client_as(world["op_outsider"]).delete(url).status_code == 404
    assert client_as(world["op_outsider"]).get(f"{url}/analysis").status_code == 404
    assert client_as(world["op_outsider"]).post(f"{url}/analyze").status_code == 404
    assert client_as(world["op_member"]).delete(url).status_code == 204
    db.expire_all()
    assert db.query(K8sEvent).filter(K8sEvent.id == ev_id).count() == 0


# ── D-103 알람 범위 ──────────────────────────────────────────────────────────

def test_alert_single_actions_hide_other_tenant_alerts(client_as, world, db):
    a = _alert(db, world["bound"].id, world["tag"])
    base = f"/api/v1/observability/alerts/{a.id}"
    outsider = client_as(world["op_outsider"])
    assert outsider.post(f"{base}/ack", json={"acked": True}).status_code == 404
    assert outsider.get(f"{base}/analysis").status_code == 404
    assert outsider.post(f"{base}/analyze").status_code == 404
    assert outsider.delete(base).status_code == 404
    # 멤버는 viewer 여도 확인(ack)은 된다 — 역할 정책은 그대로, 범위만 추가
    assert client_as(world["viewer_member"]).post(f"{base}/ack", json={"acked": True}).status_code == 200
    assert client_as(world["viewer_member"]).delete(base).status_code == 403
    assert client_as(world["op_member"]).delete(base).status_code == 204


def test_ack_all_respects_tenant_scope_and_screen_filters(client_as, world, db):
    tag = world["tag"]
    bound_alert = _alert(db, world["bound"].id, tag)
    open_firing = _alert(db, None, f"{tag}-etcd")
    open_resolved = _alert(db, None, f"{tag}-etcd", status="resolved")
    other_name = _alert(db, None, f"{tag}-other")

    # 다른 테넌트 사용자가 "전체 클러스터"에서 눌러도 바인딩된 클러스터 알람은 건드리지 않는다
    r = client_as(world["op_outsider"]).post(
        f"/api/v1/observability/alerts/ack-all?severity=critical&status=firing&q={tag}-etcd")
    assert r.status_code == 200, r.text
    db.expire_all()
    acked = {x.id: x.acked for x in db.query(AlertEvent).filter(AlertEvent.alertname.like(f"%{tag}%")).all()}
    assert acked[open_firing.id] is True            # 조건에 맞음
    assert acked[open_resolved.id] is False         # 상태 필터 밖
    assert acked[other_name.id] is False            # 검색어 밖
    assert acked[bound_alert.id] is False           # 보이지 않는 클러스터
    assert r.json()["acked"] == 1
