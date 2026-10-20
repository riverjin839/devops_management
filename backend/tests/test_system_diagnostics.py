"""시스템 진단(P2) — 섹션별 fail-safe, lock 대기 탐지, 버전 섞임·미룬 DDL 경고, admin 전용."""
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app.config import settings
from app.database import Base, engine
from app.main import _ensure_pgvector_extension, app
from app.services import boot_state, pod_heartbeat, system_diagnostics as diag

TABLE = "pep_diag_probe"

STATUSES = {"ok", "warning", "critical", "offline"}


@pytest.fixture(scope="module", autouse=True)
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)


def test_collect_never_raises_and_marks_broken_section_offline(monkeypatch):
    def _boom():
        raise ConnectionError("redis down")

    monkeypatch.setattr(pod_heartbeat, "redis_client", _boom)
    out = diag.collect("9.9.9")
    for key in ("responding_pod", "pods", "boot", "celery", "database", "runs", "errors"):
        assert out[key]["status"] in STATUSES, key
    assert out["pods"]["status"] == "offline" and "redis down" in out["pods"]["error"]
    assert out["overall"] in STATUSES
    assert out["thresholds"]["long_transaction_seconds"] > 0


def test_mixed_versions_and_pending_ddl_are_flagged(monkeypatch):
    monkeypatch.setattr(pod_heartbeat, "list_pods", lambda: [
        {"pod": "backend-a", "version": "1.57.0", "pending_ddl": [], "failed_steps": []},
        {"pod": "backend-b", "version": "1.59.0", "pending_ddl": ["users.password_changed_at"], "failed_steps": []},
    ])
    out = diag.pods_section("1.59.0")
    assert out["status"] == "warning"
    assert any("섞여" in p for p in out["problems"])
    assert any("미룬 DDL" in p for p in out["problems"])

    monkeypatch.setattr(boot_state, "pending_ddl_provider", lambda: ["users.password_changed_at"])
    assert diag.boot_section()["status"] == "critical"


def test_lock_wait_is_detected_with_blocking_pid(monkeypatch):
    monkeypatch.setitem(diag.THRESHOLDS, "lock_wait_critical_seconds", 0)
    with engine.begin() as c:
        c.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))
        c.execute(text(f"CREATE TABLE {TABLE} (id INT)"))
    other = create_engine(settings.database_url)
    holder = other.connect()
    holder.execute(text(f"LOCK TABLE {TABLE} IN ACCESS EXCLUSIVE MODE"))
    holder_pid = holder.execute(text("SELECT pg_backend_pid()")).scalar()

    def _waiter():
        with other.connect() as w:
            w.execute(text("SET lock_timeout = 4000"))
            try:
                w.execute(text(f"SELECT * FROM {TABLE}")).all()
            except Exception:  # noqa: BLE001
                pass

    t = threading.Thread(target=_waiter)
    t.start()
    try:
        time.sleep(0.5)
        out = diag._section("database", diag._with_session(diag.database_section))
        assert out["status"] == "critical", out
        assert any(holder_pid in w["blocked_by"] for w in out["lock_waits"])
    finally:
        holder.rollback()
        holder.close()
        t.join(timeout=10)
        other.dispose()
        with engine.begin() as c:
            c.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))


def test_query_literals_are_masked():
    assert diag._mask_query("UPDATE users SET hashed_password='abc''d' WHERE id='x'") == \
        "UPDATE users SET hashed_password='?' WHERE id='?'"


def test_endpoint_is_admin_only():
    from app.auth.deps import get_current_user
    from app.models.user import User

    client = TestClient(app)
    try:
        app.dependency_overrides[get_current_user] = lambda: User(username="d-admin", hashed_password="x", role="admin")
        r = client.get("/api/v1/system-diagnostics")
        assert r.status_code == 200, r.text
        assert r.json()["overall"] in STATUSES
        app.dependency_overrides[get_current_user] = lambda: User(username="d-op", hashed_password="x", role="operator")
        assert client.get("/api/v1/system-diagnostics").status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)
