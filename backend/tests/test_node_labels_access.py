"""D-155 — 노드 라벨 변경(PATCH /clusters/{id}/nodes/{node}/labels)의 권한·감사 회귀 테스트.

예전에는 `get_db` 만 받아 바인딩 없는 클러스터면 viewer 도 운영 노드 라벨을 바꿀 수 있었고,
누가 바꿨는지 남지 않았다. 이제:
  - operator 이상만 허용(viewer → 403, K8s 호출 없음).
  - 성공·실패 모두 감사 로그 `node.labels.patch` 한 행(노드·추가·삭제 키).
K8s 호출(`NodeLabelService.patch_labels`)은 가짜로 바꾸고 DB 는 실제 Postgres 를 쓴다.
"""
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import k8s_node_label_service  # noqa: E402


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"nl-{tag}", api_endpoint="https://nl:6443")
    users = {
        role: User(username=f"nl-{role}-{tag}", hashed_password="x", role=role)
        for role in ("operator", "viewer")
    }
    db.add_all([cluster, *users.values()])
    db.commit()
    yield {"cluster": cluster, **users}
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
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
def fake_k8s(monkeypatch):
    calls: list[dict] = []

    def _patch(self, node_name, add, remove):  # noqa: ARG001 — 서비스 시그니처 그대로
        calls.append({"node": node_name, "add": dict(add), "remove": list(remove)})
        labels = {"kubernetes.io/hostname": node_name, **add}
        return {"name": node_name, "labels": labels, "taints": [], "role": "worker", "status": "ready"}

    monkeypatch.setattr(k8s_node_label_service.NodeLabelService, "__init__", lambda self, cluster: None)
    monkeypatch.setattr(k8s_node_label_service.NodeLabelService, "patch_labels", _patch)
    return calls


def _audit_rows(db, user):
    db.expire_all()
    return (
        db.query(AuditLog)
        .filter(AuditLog.actor_user_id == str(user.id), AuditLog.action == "node.labels.patch")
        .all()
    )


def _url(world, node="worker-1"):
    return f"/api/v1/clusters/{world['cluster'].id}/nodes/{node}/labels"


def test_viewer_cannot_patch_node_labels(db, world, client_as, fake_k8s):
    r = client_as(world["viewer"]).patch(_url(world), json={"add": {"team": "a"}, "remove": []})
    assert r.status_code == 403, r.text
    assert fake_k8s == []  # K8s 에 아무것도 나가지 않는다
    assert _audit_rows(db, world["viewer"]) == []


def test_operator_patch_records_audit(db, world, client_as, fake_k8s):
    r = client_as(world["operator"]).patch(
        _url(world), json={"add": {"team": "a"}, "remove": ["old-key"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["labels"]["team"] == "a"
    assert fake_k8s == [{"node": "worker-1", "add": {"team": "a"}, "remove": ["old-key"]}]

    rows = _audit_rows(db, world["operator"])
    assert len(rows) == 1
    row = rows[0]
    assert row.status == "success"
    assert row.target_type == "cluster"
    assert row.target_id == str(world["cluster"].id)
    assert row.details["node"] == "worker-1"
    assert row.details["add"] == {"team": "a"}
    assert row.details["remove"] == ["old-key"]


def test_failed_patch_is_audited_as_failure(db, world, client_as, monkeypatch):
    def _boom(self, node_name, add, remove):  # noqa: ARG001
        raise ValueError("invalid label key")

    monkeypatch.setattr(k8s_node_label_service.NodeLabelService, "__init__", lambda self, cluster: None)
    monkeypatch.setattr(k8s_node_label_service.NodeLabelService, "patch_labels", _boom)

    r = client_as(world["operator"]).patch(_url(world), json={"add": {"bad key": "x"}, "remove": []})
    assert r.status_code == 422, r.text

    rows = _audit_rows(db, world["operator"])
    assert len(rows) == 1
    assert rows[0].status == "failure"
    assert "invalid label key" in rows[0].details["error"]
