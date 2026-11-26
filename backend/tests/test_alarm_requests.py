"""알람 등록 요청 — ``/alarm-requests`` 를 실제 Postgres 로 태운다.

요청 등록(요청자 고정·클러스터 이름 스냅샷) → 수정·취소 권한 → 관리자 처리 상태 전이 → 반영 완료 시
카탈로그 기본 임계치 갱신 → 알림 팬아웃까지.
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.security import create_access_token, hash_password  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.alarm_request import AlarmCatalogItem, AlarmRequest  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.user_notification import UserNotification  # noqa: E402
from app.services import alarm_requests as svc  # noqa: E402

PREFIX = "ar-test-"


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    s = SessionLocal()
    s.query(AlarmRequest).filter(AlarmRequest.metric_name.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.query(AlarmCatalogItem).filter(AlarmCatalogItem.metric_name.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.query(UserNotification).filter(UserNotification.type.in_(("alarm_request", "alarm_request_status"))).delete(
        synchronize_session=False)
    s.query(Cluster).filter(Cluster.name.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.query(User).filter(User.username.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.commit()
    s.close()


@pytest.fixture
def client():
    return TestClient(app)


def _user(db, role: str, name: str) -> User:
    u = User(username=f"{PREFIX}{role}-{uuid.uuid4().hex[:6]}", hashed_password=hash_password("x"),
             role=role, display_name=name, is_active=True)
    db.add(u)
    db.commit()
    return u


def _h(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(subject=user.username, role=user.role)}"}


def _cluster(db, name: str) -> Cluster:
    c = Cluster(name=f"{PREFIX}{name}", api_endpoint="https://127.0.0.1:6443")
    db.add(c)
    db.commit()
    return c


def _payload(clusters, metric=f"{PREFIX}Lag", **kw):
    body = {
        "service": "cnpg", "metric_name": metric, "meaning": "복제 지연",
        "thresholds": [{"severity": "warning", "base_expr": "lag > 30", "base_for": "5m",
                        "new_expr": "lag > 60", "new_for": "10m"}],
        "cluster_ids": [str(c.id) for c in clusters], "note": "오탐 축소",
    }
    body.update(kw)
    return body


def test_meta_and_seeded_catalog(client, db):
    viewer = _user(db, "viewer", "뷰어")
    svc.seed_catalog(db)
    meta = client.get("/api/v1/alarm-requests/meta", headers=_h(viewer)).json()
    assert {"k8s", "cilium", "aistor", "cnpg", "keycloak", "nexus", "jenkins", "argocd"} <= set(meta["services"])
    cat = client.get("/api/v1/alarm-requests/catalog?service=cnpg", headers=_h(viewer)).json()
    assert cat and all(i["service"] == "cnpg" for i in cat)
    assert "for" in cat[0]["thresholds"][0]


def test_create_fixes_requester_and_snapshots_clusters(client, db):
    viewer = _user(db, "viewer", "홍길동")
    admin = _user(db, "admin", "관리자")
    c1, c2 = _cluster(db, "prod-1"), _cluster(db, "prod-2")
    r = client.post("/api/v1/alarm-requests", json=_payload([c1, c2]), headers=_h(viewer))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["requested_by"] == viewer.username and body["requester_name"] == "홍길동"
    assert body["status"] == "requested" and body["code"].startswith("AR-")
    assert [c["name"] for c in body["clusters"]] == [c1.name, c2.name]
    assert body["history"][0]["action"] == "created"
    # 관리자에게 알림
    assert db.query(UserNotification).filter(UserNotification.type == "alarm_request",
                                             UserNotification.recipient_user_id == admin.id).count() == 1


def test_create_validation(client, db):
    viewer = _user(db, "viewer", "v")
    c1 = _cluster(db, "a")
    no_new = _payload([c1], thresholds=[{"severity": "warning", "base_expr": "x > 1", "base_for": "5m",
                                         "new_expr": "", "new_for": ""}])
    assert client.post("/api/v1/alarm-requests", json=no_new, headers=_h(viewer)).status_code == 422
    bad_for = _payload([c1], thresholds=[{"severity": "warning", "new_expr": "x > 1", "new_for": "5분"}])
    assert client.post("/api/v1/alarm-requests", json=bad_for, headers=_h(viewer)).status_code == 422
    unknown = _payload([c1], cluster_ids=[str(uuid.uuid4())])
    assert client.post("/api/v1/alarm-requests", json=unknown, headers=_h(viewer)).status_code == 422
    dup = _payload([c1], thresholds=[{"severity": "warning", "new_expr": "x"}, {"severity": "warning", "new_expr": "y"}])
    assert client.post("/api/v1/alarm-requests", json=dup, headers=_h(viewer)).status_code == 422


def test_edit_and_cancel_only_owner_while_requested(client, db):
    owner = _user(db, "viewer", "요청자")
    other = _user(db, "viewer", "다른 사람")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "b")
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1]), headers=_h(owner)).json()["id"]
    upd = _payload([c1], note="수정함")
    assert client.put(f"/api/v1/alarm-requests/{rid}", json=upd, headers=_h(other)).status_code == 403
    r = client.put(f"/api/v1/alarm-requests/{rid}", json=upd, headers=_h(owner))
    assert r.status_code == 200 and r.json()["note"] == "수정함"
    assert client.post(f"/api/v1/alarm-requests/{rid}/action", json={"action": "reviewing"},
                       headers=_h(op)).status_code == 200
    assert client.put(f"/api/v1/alarm-requests/{rid}", json=upd, headers=_h(owner)).status_code == 409
    assert client.delete(f"/api/v1/alarm-requests/{rid}", headers=_h(owner)).status_code == 409


def test_admin_actions_require_operator(client, db):
    viewer = _user(db, "viewer", "v")
    c1 = _cluster(db, "c")
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1]), headers=_h(viewer)).json()["id"]
    assert client.post(f"/api/v1/alarm-requests/{rid}/action", json={"action": "approved"},
                       headers=_h(viewer)).status_code == 403


def test_reject_requires_comment_and_notifies_requester(client, db):
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "d")
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1]), headers=_h(viewer)).json()["id"]
    url = f"/api/v1/alarm-requests/{rid}/action"
    assert client.post(url, json={"action": "rejected"}, headers=_h(op)).status_code == 422
    r = client.post(url, json={"action": "rejected", "comment": "네임스페이스 조건으로 다시"}, headers=_h(op))
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert r.json()["review_comment"] == "네임스페이스 조건으로 다시"
    # 끝 상태에서는 더 처리할 수 없다
    assert client.post(url, json={"action": "approved"}, headers=_h(op)).status_code == 409
    n = db.query(UserNotification).filter(UserNotification.type == "alarm_request_status",
                                          UserNotification.recipient_user_id == viewer.id).all()
    assert len(n) == 1 and "반려" in n[0].title


def test_apply_promotes_thresholds_to_catalog(client, db):
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "e")
    metric = f"{PREFIX}NewAlarm"
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1], metric=metric), headers=_h(viewer)).json()["id"]
    url = f"/api/v1/alarm-requests/{rid}/action"
    # 승인 전에는 반영할 수 없다
    assert client.post(url, json={"action": "applied"}, headers=_h(op)).status_code == 409
    assert client.post(url, json={"action": "approved"}, headers=_h(op)).status_code == 200
    r = client.post(url, json={"action": "applied"}, headers=_h(op))
    assert r.status_code == 200 and r.json()["status"] == "applied" and r.json()["applied_at"]
    db.expire_all()
    item = db.query(AlarmCatalogItem).filter(AlarmCatalogItem.metric_name == metric).one()
    assert item.thresholds == [{"severity": "warning", "expr": "lag > 60", "for": "10m"}]
    assert r.json()["catalog_item_id"] == item.id
    actions = [h["action"] for h in r.json()["history"]]
    assert actions == ["created", "approved", "applied"]


def test_catalog_crud_operator_only(client, db):
    viewer = _user(db, "viewer", "v")
    op = _user(db, "operator", "o")
    body = {"service": "nexus", "metric_name": f"{PREFIX}Blob", "meaning": "m",
            "thresholds": [{"severity": "warning", "expr": "x > 1", "for": "5m"}]}
    assert client.post("/api/v1/alarm-requests/catalog", json=body, headers=_h(viewer)).status_code == 403
    r = client.post("/api/v1/alarm-requests/catalog", json=body, headers=_h(op))
    assert r.status_code == 201, r.text
    iid = r.json()["id"]
    assert client.post("/api/v1/alarm-requests/catalog", json=body, headers=_h(op)).status_code == 409
    body["enabled"] = False
    assert client.put(f"/api/v1/alarm-requests/catalog/{iid}", json=body, headers=_h(op)).json()["enabled"] is False
    listed = client.get("/api/v1/alarm-requests/catalog?service=nexus", headers=_h(viewer)).json()
    assert iid not in [i["id"] for i in listed]
    assert client.delete(f"/api/v1/alarm-requests/catalog/{iid}", headers=_h(op)).status_code == 204


def test_foreign_catalog_id_is_ignored_and_not_overwritten(client, db):
    """다른 서비스·항목의 catalog_item_id 를 보내도 그 항목의 임계치를 덮어쓰지 않는다."""
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "f")
    victim = AlarmCatalogItem(service="nexus", metric_name=f"{PREFIX}Victim", meaning="m", enabled=True,
                              thresholds=[{"severity": "warning", "expr": "orig > 1", "for": "5m"}])
    db.add(victim)
    db.commit()
    metric = f"{PREFIX}Other"
    body = _payload([c1], metric=metric, catalog_item_id=victim.id)
    r = client.post("/api/v1/alarm-requests", json=body, headers=_h(viewer))
    assert r.status_code == 201 and r.json()["catalog_item_id"] is None
    rid = r.json()["id"]
    url = f"/api/v1/alarm-requests/{rid}/action"
    assert client.post(url, json={"action": "approved"}, headers=_h(op)).status_code == 200
    assert client.post(url, json={"action": "applied"}, headers=_h(op)).status_code == 200
    db.expire_all()
    assert db.get(AlarmCatalogItem, victim.id).thresholds == [{"severity": "warning", "expr": "orig > 1", "for": "5m"}]
    created = db.query(AlarmCatalogItem).filter(AlarmCatalogItem.metric_name == metric).one()
    assert created.service == "cnpg" and created.id != victim.id
