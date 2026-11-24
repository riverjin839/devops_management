"""`GET /ops-checks/summary` — 점검 탭(카탈로그) 마지막 결과로 접은 클러스터 상태와 테넌트 가시 범위."""
import os
import uuid

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.security import create_access_token  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.addon import Addon  # noqa: E402
from app.models.cluster import Cluster, StatusEnum  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.ops_check_service import summary_level  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def world():
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8]
    ok = Cluster(name=f"sum-ok-{tag}", api_endpoint="https://a:6443")
    bad = Cluster(name=f"sum-bad-{tag}", api_endpoint="https://b:6443")
    empty = Cluster(name=f"sum-empty-{tag}", api_endpoint="https://c:6443")
    hidden = Cluster(name=f"sum-hidden-{tag}", api_endpoint="https://d:6443")
    tenant = Tenant(name=f"sum-team-{tag}")
    admin = User(username=f"sum-admin-{tag}", hashed_password="x", role="admin")
    viewer = User(username=f"sum-viewer-{tag}", hashed_password="x", role="viewer")
    db.add_all([ok, bad, empty, hidden, tenant, admin, viewer])
    db.commit()
    db.add_all([
        Addon(cluster_id=ok.id, name="cilium", type="cilium", status=StatusEnum.healthy),
        Addon(cluster_id=bad.id, name="etcd", type="etcd", status=StatusEnum.critical),
        Addon(cluster_id=bad.id, name="ingress", type="ingress", status=StatusEnum.warning),
        Addon(cluster_id=bad.id, name="coredns", type="coredns", status=StatusEnum.healthy),
        ClusterBinding(tenant_id=tenant.id, cluster_id=hidden.id, access="operate"),
    ])
    db.commit()
    w = {"ok": ok, "bad": bad, "empty": empty, "hidden": hidden, "admin": admin, "viewer": viewer}
    yield w
    ids = [ok.id, bad.id, empty.id, hidden.id]
    db.query(Addon).filter(Addon.cluster_id.in_(ids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_(ids)).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_(ids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete()
    db.query(User).filter(User.id.in_([admin.id, viewer.id])).delete(synchronize_session=False)
    db.commit()
    db.close()


def _get(user: User) -> dict[str, dict]:
    token = create_access_token(subject=user.username, role=user.role)
    r = TestClient(app).get("/api/v1/ops-checks/summary", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    return {row["cluster_id"]: row for row in r.json()}


def test_worst_status_and_problems(world):
    rows = _get(world["admin"])
    assert rows[str(world["ok"].id)]["status"] == "healthy"
    assert rows[str(world["empty"].id)]["status"] == "none"
    bad = rows[str(world["bad"].id)]
    assert bad["status"] == "critical"
    assert bad["counts"] == {"healthy": 1, "warning": 1, "critical": 1, "none": bad["counts"]["none"]}
    # 심각한 것부터.
    assert [p["name"] for p in bad["problems"]][:2] == ["etcd", "ingress"]
    assert bad["problems"][0]["source"] == "addon"


def test_respects_tenant_visibility(world):
    rows = _get(world["viewer"])
    assert str(world["hidden"].id) not in rows
    assert str(world["bad"].id) in rows


@pytest.mark.parametrize("raw,level", [
    ("ok", "healthy"), ("error", "critical"), ("timeout", "warning"), ("running", "none"), (None, "none"),
])
def test_summary_level(raw, level):
    assert summary_level(raw) == level
