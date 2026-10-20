"""요청 ID 추적(P1) — 응답 헤더·처리 안 된 예외·5xx 응답이 같은 ID 로 system_error_logs 에 남는다."""
import uuid

import pytest
from fastapi import APIRouter, HTTPException
from fastapi.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension, app
from app.models.audit_log import AuditLog
from app.models.system_error_log import SystemErrorLog
from app.services import audit_logger
from app.services.request_context import accept_or_new, get_request_id

_probe = APIRouter()


@_probe.get("/__test/boom")
def _boom():
    raise ZeroDivisionError("probe failure")


@_probe.get("/__test/http500")
def _http500():
    raise HTTPException(status_code=500, detail="커스텀 500 사유")


@_probe.get("/__test/http503")
def _http503():
    raise HTTPException(status_code=503, detail="웹훅 토큰 미설정")


@_probe.get("/__test/audit")
def _audit():
    db = SessionLocal()
    try:
        audit_logger.record(db, action="test.request_id", actor_username="probe")
    finally:
        db.close()
    return {"rid": get_request_id()}


app.include_router(_probe)


@pytest.fixture(scope="module", autouse=True)
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def _rows(rid):
    db = SessionLocal()
    try:
        return db.query(SystemErrorLog).filter(SystemErrorLog.request_id == rid).all()
    finally:
        db.close()


def test_client_id_is_echoed_and_bad_id_replaced(client):
    rid = "pep-" + uuid.uuid4().hex[:12]
    r = client.get("/health", headers={"X-Request-ID": rid})
    assert r.headers["x-request-id"] == rid
    r2 = client.get("/health", headers={"X-Request-ID": "bad id\n<script>"})
    assert r2.headers["x-request-id"] != "bad id\n<script>"
    assert accept_or_new("short") != "short"  # 8자 미만은 새로 만든다


def test_unhandled_exception_returns_request_id_and_is_recorded(client):
    rid = "pep-" + uuid.uuid4().hex[:12]
    r = client.get("/__test/boom", headers={"X-Request-ID": rid})
    assert r.status_code == 500
    body = r.json()
    assert body["request_id"] == rid and rid in body["detail"]
    assert r.headers["x-request-id"] == rid
    rows = _rows(rid)
    assert len(rows) == 1
    assert rows[0].error_type == "ZeroDivisionError"
    assert "probe failure" in rows[0].traceback
    assert rows[0].path == "/__test/boom" and rows[0].app_version == app.version


def test_http_500_is_recorded_with_body_reason_but_503_is_not(client):
    rid = "pep-" + uuid.uuid4().hex[:12]
    r = client.get("/__test/http500", headers={"X-Request-ID": rid})
    assert r.status_code == 500 and r.headers["x-request-id"] == rid
    rows = _rows(rid)
    assert len(rows) == 1 and "커스텀 500 사유" in (rows[0].message or "")
    rid2 = "pep-" + uuid.uuid4().hex[:12]
    client.get("/__test/http503", headers={"X-Request-ID": rid2})
    assert _rows(rid2) == []


def test_audit_log_carries_request_id(client):
    rid = "pep-" + uuid.uuid4().hex[:12]
    assert client.get("/__test/audit", headers={"X-Request-ID": rid}).json()["rid"] == rid
    db = SessionLocal()
    try:
        row = db.query(AuditLog).filter(AuditLog.action == "test.request_id").order_by(
            AuditLog.created_at.desc()).first()
        assert row.details["request_id"] == rid
        db.delete(row)
        db.commit()
    finally:
        db.close()


def test_admin_can_search_by_request_id(client):
    from app.auth.deps import get_current_user
    from app.models.user import User

    rid = "pep-" + uuid.uuid4().hex[:12]
    client.get("/__test/boom", headers={"X-Request-ID": rid})
    admin = User(username="probe-admin", hashed_password="x", role="admin")
    app.dependency_overrides[get_current_user] = lambda: admin
    try:
        r = client.get("/api/v1/system-errors", params={"request_id": rid[:10]})
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert any(i["request_id"] == rid and i["error_type"] == "ZeroDivisionError" for i in items)
        viewer = User(username="probe-viewer", hashed_password="x", role="viewer")
        app.dependency_overrides[get_current_user] = lambda: viewer
        assert client.get("/api/v1/system-errors").status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)
