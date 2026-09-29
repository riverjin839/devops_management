"""백업 API 권한 회귀 테스트.

백업 export 는 kubeconfig·자격증명을 (include_sensitive=true 면 복호화된 채로) 포함하므로
meta/export/import 전부 admin 전용이어야 한다. 이전엔 export/meta 가 인증만 요구해
viewer 도 전체 데이터를 반출할 수 있었다. 또 Settings "접근 제어"가 화면 전용 API 를
서버 측에서도 차단하는지 함께 검증한다.
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
from app.models.app_setting import AppSetting
from app.models.audit_log import AuditLog
from app.models.user import User


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def _make_user(db, role):
    u = User(username=f"{role}-{uuid.uuid4().hex[:8]}", hashed_password="x", role=role)
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def as_user(db):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    created = []

    def _client(role):
        u = _make_user(db, role)
        created.append(u.id)
        app.dependency_overrides[get_current_user] = lambda: u
        return TestClient(app), u

    try:
        yield _client
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        db.query(AuditLog).filter(AuditLog.actor_user_id.in_(created)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(created)).delete(synchronize_session=False)
        db.commit()


@pytest.mark.parametrize("role", ["viewer", "operator"])
def test_non_admin_cannot_export_or_read_meta(as_user, role):
    c, _ = as_user(role)
    assert c.get("/api/v1/backup/export", params={"include_sensitive": "true"}).status_code == 403
    assert c.get("/api/v1/backup/meta").status_code == 403


def test_admin_export_is_audited(as_user, db):
    c, admin = as_user("admin")
    r = c.get("/api/v1/backup/export")
    assert r.status_code == 200
    row = (
        db.query(AuditLog)
        .filter(AuditLog.actor_user_id == admin.id, AuditLog.action == "backup.export")
        .first()
    )
    assert row is not None
    assert row.details["include_sensitive"] is False


@pytest.fixture
def mindmap_restricted(db):
    row = db.query(AppSetting).filter(AppSetting.key == "feature_access").first()
    before = None if row is None else row.value
    if row is None:
        row = AppSetting(key="feature_access", value={})
        db.add(row)
    row.value = {"/mindmap": {"roles": ["operator"], "users": []}}
    db.commit()
    yield
    row = db.query(AppSetting).filter(AppSetting.key == "feature_access").first()
    if before is None:
        db.delete(row)
    else:
        row.value = before
    db.commit()


def test_feature_access_enforced_on_dedicated_api(as_user, mindmap_restricted):
    c, _ = as_user("viewer")
    r = c.get("/api/v1/mindmaps")
    assert r.status_code == 403
    assert "/mindmap" in r.json()["detail"]
    # 공유 API 는 영향 없음
    assert c.get("/api/v1/ui-settings/feature-access").status_code == 200


def test_feature_access_allows_listed_role(as_user, mindmap_restricted):
    c, _ = as_user("operator")
    assert c.get("/api/v1/mindmaps").status_code != 403
