"""15차 라운드(A-5·A-18) — 클러스터 링크(/links) 서버 계약 회귀 테스트.

- GET: ``version``(updated_at ISO, 없으면 "0")을 ``data.version``·최상위 ``version`` 에 싣는다.
  그룹은 호출자에게 보이는 클러스터만, 고아 그룹(클러스터 없음)은 admin 만.
- PUT: admin 전용. ``version`` 불일치 → 409. 안 보이는 그룹은 저장 문서에서 다시 합친다.
  링크 URL 은 http(s) 만(422). ``cluster_groups`` 배열 순서 = 저장 순서.
실제 DB 로 검증한다. 전역 AppSetting 행(cluster_links)은 테스트 전후로 복원한다.
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
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.app_setting import AppSetting
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.user import User

KEY = "cluster_links"
URL = "/api/v1/ui-settings/cluster-links"
CONFLICT = "다른 곳에서 링크가 바뀌었습니다. 새로고침 후 다시 저장하세요."


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def db(_schema):
    session = SessionLocal()
    yield session
    session.close()


def _link(i, url=None):
    return {"id": f"l{i}", "label": f"link {i}", "url": url or f"https://example.com/{i}", "description": None}


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    c_open = Cluster(name=f"open-{tag}", api_endpoint="https://open:6443")
    c_bound = Cluster(name=f"bound-{tag}", api_endpoint="https://bound:6443")
    users = {
        k: User(username=f"{k}-{tag}", hashed_password="x", role=role)
        for k, role in (("admin", "admin"), ("member", "operator"), ("outsider", "operator"))
    }
    tenant = Tenant(name=f"team-{tag}")
    db.add_all([c_open, c_bound, tenant, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="operate"),
    ])
    db.commit()

    orphan_id = str(uuid.uuid4())
    saved = db.query(AppSetting).filter(AppSetting.key == KEY).first()
    backup = None if saved is None else (saved.value, saved.updated_at)
    doc = {
        "common_links": [_link(0), _link(9, "javascript:alert(1)")],
        "cluster_groups": [
            {"cluster_id": str(c_bound.id), "cluster_name": "bound", "links": [_link(1)]},
            {"cluster_id": str(c_open.id), "cluster_name": "open",
             "links": [_link(2), _link(3, "javascript:alert(1)")]},
            {"cluster_id": orphan_id, "cluster_name": "gone", "links": [_link(4)]},
        ],
    }
    if saved is None:
        db.add(AppSetting(key=KEY, value=doc))
    else:
        saved.value = doc
    db.commit()

    yield {"open": c_open, "bound": c_bound, "orphan": orphan_id, "tenant": tenant, **users}

    db.rollback()
    row = db.query(AppSetting).filter(AppSetting.key == KEY).first()
    if backup is None:
        if row is not None:
            db.delete(row)
    else:
        if row is None:
            row = AppSetting(key=KEY, value=backup[0])
            db.add(row)
        row.value, row.updated_at = backup
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_([c_open.id, c_bound.id])).delete(
        synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_([c_open.id, c_bound.id])).delete(synchronize_session=False)
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


def _group_ids(body):
    return [g["cluster_id"] for g in body["data"]["cluster_groups"]]


def _stored(db):
    db.expire_all()
    return db.query(AppSetting).filter(AppSetting.key == KEY).one().value


def test_get_filters_groups_by_cluster_scope(client_as, world):
    open_id, bound_id = str(world["open"].id), str(world["bound"].id)

    body = client_as(world["outsider"]).get(URL).json()
    assert _group_ids(body) == [open_id]  # 다른 테넌트 클러스터·고아 그룹 제외

    body = client_as(world["member"]).get(URL).json()
    assert _group_ids(body) == [bound_id, open_id]  # 고아 그룹은 admin 만

    body = client_as(world["admin"]).get(URL).json()
    assert _group_ids(body) == [bound_id, open_id, world["orphan"]]  # 저장 순서 그대로


def test_get_returns_version_and_hides_unsafe_urls(client_as, world, db):
    body = client_as(world["admin"]).get(URL).json()
    version = body["version"]
    assert version and version != "0"
    assert body["data"]["version"] == version
    assert version == _stored_version(db)
    assert [link["id"] for link in body["data"]["common_links"]] == ["l0"]
    open_group = next(g for g in body["data"]["cluster_groups"] if g["cluster_id"] == str(world["open"].id))
    assert [link["id"] for link in open_group["links"]] == ["l2"]


def _stored_version(db):
    db.expire_all()
    return db.query(AppSetting).filter(AppSetting.key == KEY).one().updated_at.isoformat()


def test_put_is_admin_only(client_as, world):
    r = client_as(world["member"]).put(URL, json={"common_links": [], "cluster_groups": []})
    assert r.status_code == 403


def test_put_version_mismatch_is_409(client_as, world, db):
    c = client_as(world["admin"])
    version = c.get(URL).json()["version"]
    r = c.put(URL, json={"common_links": [_link(5)], "cluster_groups": [], "version": "stale"})
    assert r.status_code == 409
    assert r.json()["detail"] == CONFLICT
    assert [link["id"] for link in _stored(db)["common_links"]] == ["l0", "l9"]  # 변경 없음

    r = c.put(URL, json={"common_links": [_link(5)], "cluster_groups": [], "version": version})
    assert r.status_code == 200, r.text
    new_version = r.json()["version"]
    assert new_version != version and r.json()["data"]["version"] == new_version
    # 같은(이제 낡은) 버전으로 다시 저장 → 409
    r = c.put(URL, json={"common_links": [], "cluster_groups": [], "version": version})
    assert r.status_code == 409


def test_put_without_version_skips_check(client_as, world):
    r = client_as(world["admin"]).put(URL, json={"common_links": [_link(6)], "cluster_groups": []})
    assert r.status_code == 200


def test_put_with_zero_version_when_no_row(client_as, world, db):
    db.query(AppSetting).filter(AppSetting.key == KEY).delete(synchronize_session=False)
    db.commit()
    r = client_as(world["admin"]).put(URL, json={"common_links": [_link(7)], "cluster_groups": [], "version": "0"})
    assert r.status_code == 200, r.text
    assert r.json()["version"] != "0"


def test_put_preserves_group_order(client_as, world, db):
    open_id, bound_id = str(world["open"].id), str(world["bound"].id)
    c = client_as(world["admin"])
    groups = [
        {"cluster_id": open_id, "cluster_name": "open", "links": [_link(2)]},
        {"cluster_id": bound_id, "cluster_name": "bound", "links": [_link(1)]},
    ]
    r = c.put(URL, json={"common_links": [], "cluster_groups": groups})
    assert r.status_code == 200
    assert _group_ids(r.json()) == [open_id, bound_id]  # admin 이 고아 그룹을 뺐으니 삭제됨
    assert [g["cluster_id"] for g in _stored(db)["cluster_groups"]] == [open_id, bound_id]
    assert _group_ids(c.get(URL).json()) == [open_id, bound_id]


@pytest.mark.parametrize("bad", ["javascript:alert(1)", "ftp://host/x", "/relative/path", "example.com", "https://"])
def test_put_rejects_non_http_urls(client_as, world, bad):
    c = client_as(world["admin"])
    r = c.put(URL, json={"common_links": [_link(1, bad)], "cluster_groups": []})
    assert r.status_code == 422, bad
    group = {"cluster_id": str(world["open"].id), "cluster_name": "open", "links": [_link(2, bad)]}
    r = c.put(URL, json={"common_links": [], "cluster_groups": [group]})
    assert r.status_code == 422, bad


def test_put_merges_back_groups_hidden_from_caller(world, db):
    """PUT 은 admin 전용이라 지금은 숨은 그룹이 없지만, 저장 로직 자체가 안 보이는 그룹을 지우지
    않는지(편집 권한이 넓어져도 안전한지) 핸들러를 직접 불러 검증한다."""
    from app.routers.ui_settings import update_cluster_links
    from app.schemas.ui_settings import ClusterLinksUpdate
    from app.services.cluster_access import ClusterScope, hidden_cluster_ids

    outsider = world["outsider"]
    scope = ClusterScope(hidden_cluster_ids(db, outsider))
    open_id, bound_id = str(world["open"].id), str(world["bound"].id)
    payload = ClusterLinksUpdate(
        common_links=[],
        cluster_groups=[
            {"cluster_id": open_id, "cluster_name": "open", "links": []},
            # 안 보이는 클러스터의 그룹을 요청으로 덮어쓰려는 시도 — 무시돼야 한다
            {"cluster_id": bound_id, "cluster_name": "hijack", "links": []},
        ],
    )
    resp = update_cluster_links(payload, db=db, actor=outsider, scope=scope)
    assert [g.cluster_id for g in resp.data.cluster_groups] == [open_id]
    stored = _stored(db)["cluster_groups"]
    assert [g["cluster_id"] for g in stored] == [open_id, bound_id, world["orphan"]]
    bound = next(g for g in stored if g["cluster_id"] == bound_id)
    assert bound["cluster_name"] == "bound" and [link["id"] for link in bound["links"]] == ["l1"]
