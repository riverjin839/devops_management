"""업무(WorkItem) → 내부 ServiceNow ITSM 수동 등록 — 실제 Postgres 사용.

ServiceNowService 는 fake/MockTransport 로 대체(네트워크 없음)하고, 핵심 검증 대상:
 - Jira 미연동 업무는 등록을 아예 시도하지 못한다(400).
 - 성공 시 업무에 sys_id/number/url/synced_at 이 영속화되고 감사 로그가 남는다.
 - 인증 실패(svc=None)와 등록 자체 실패(create_record 오류)가 각각 올바른
   `auth_issue`/`servicenow_register_error` 로 구분된다(프로비저닝의 *_auth_issue 패턴과 동일).
 - `ServiceNowService.create_record`/`current_user` 는 절대 raise 하지 않고 구조화된
   `{"status": ...}` dict 를 반환한다(fail-safe 계약, httpx.MockTransport 로 검증).
"""
import os
import uuid
from datetime import datetime

import httpx
import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.work_item import WorkItem  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
import app.routers.servicenow as servicenow_router  # noqa: E402
from app.routers.servicenow import _build_fields, register_work_item  # noqa: E402
from app.services.servicenow_service import ServiceNowService  # noqa: E402
from fastapi import HTTPException  # noqa: E402


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


class _Actor:
    id = "tester-id"
    username = "tester"
    role = "operator"
    display_name = "테스터"


def _make_work_item(db, **overrides) -> WorkItem:
    item = WorkItem(
        id=uuid.uuid4(), type="task", assignee="tester", primary_assignee="tester",
        category="테스트", content="본문", title="제목", started_at=datetime.utcnow(),
    )
    for k, v in overrides.items():
        setattr(item, k, v)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _cfg():
    return {
        "base_url": "https://itsm.example.com", "enabled": True, "verify_tls": True,
        "table_name": "incident",
        "field_mapping": {"short_description": "title", "description": "content"},
        "priority_map": {"high": "1", "medium": "2", "low": "3"},
    }


class _FakeServiceNowSvc:
    def __init__(self, result: dict):
        self.result = result
        self.calls = 0

    async def create_record(self, table, fields):
        self.calls += 1
        self.last_call = (table, fields)
        return self.result


def _patch(monkeypatch, *, svc=None, verified_detail: str = "인증 실패"):
    async def _verified(db, actor, cfg):
        if svc is None:
            return None, {"status": "error", "detail": verified_detail}
        return svc, {"status": "ok", "display_name": "테스터"}

    monkeypatch.setattr(servicenow_router, "_servicenow_service_verified", _verified)
    monkeypatch.setattr(servicenow_router, "_get_config", lambda db: _cfg())


# ── 라우터: /servicenow/register/{item_id} ──────────────────────────────────
async def test_register_blocked_without_jira_link(db, monkeypatch):
    item = _make_work_item(db)  # jira_issue_key 없음
    _patch(monkeypatch, svc=_FakeServiceNowSvc({"status": "ok"}))
    with pytest.raises(HTTPException) as exc:
        await register_work_item(item.id, db, _Actor())
    assert exc.value.status_code == 400


async def test_register_not_found(db, monkeypatch):
    _patch(monkeypatch, svc=_FakeServiceNowSvc({"status": "ok"}))
    with pytest.raises(HTTPException) as exc:
        await register_work_item(uuid.uuid4(), db, _Actor())
    assert exc.value.status_code == 404


async def test_register_success_persists_fields_and_audit_log(db, monkeypatch):
    jira_key = f"OPS-{_uid()}"
    item = _make_work_item(db, jira_issue_key=jira_key, jira_url=f"https://j/{jira_key}")
    number, sys_id = f"INC{_uid()}", _uid()
    svc = _FakeServiceNowSvc({"status": "ok", "sys_id": sys_id, "number": number,
                              "url": f"https://itsm.example.com/incident.do?sys_id={sys_id}"})
    _patch(monkeypatch, svc=svc)

    res = await register_work_item(item.id, db, _Actor())

    assert res.status == "ok"
    assert res.ticket_number == number
    assert svc.calls == 1
    assert [s.step for s in res.steps] == ["config", "auth", "payload", "create"]

    db.refresh(item)
    assert item.servicenow_sys_id == sys_id
    assert item.servicenow_number == number
    assert item.servicenow_url.endswith(sys_id)
    assert item.servicenow_synced_at is not None
    assert item.servicenow_register_error is None

    log = (
        db.query(AuditLog)
        .filter(AuditLog.action == "work_item.servicenow_register", AuditLog.target_id == str(item.id))
        .order_by(AuditLog.created_at.desc())
        .first()
    )
    assert log is not None
    assert log.details.get("number") == number


async def test_register_auth_failure_sets_auth_issue_and_error(db, monkeypatch):
    jira_key = f"OPS-{_uid()}"
    item = _make_work_item(db, jira_issue_key=jira_key)
    _patch(monkeypatch, svc=None, verified_detail="ServiceNow 세션이 없습니다.")

    res = await register_work_item(item.id, db, _Actor())

    assert res.status == "error"
    assert res.auth_issue is True
    db.refresh(item)
    assert item.servicenow_register_error == "ServiceNow 세션이 없습니다."
    assert item.servicenow_number is None


async def test_register_create_failure_persists_error_without_auth_issue(db, monkeypatch):
    jira_key = f"OPS-{_uid()}"
    item = _make_work_item(db, jira_issue_key=jira_key)
    svc = _FakeServiceNowSvc({"status": "error", "detail": "권한 없음 (403)."})
    _patch(monkeypatch, svc=svc)

    res = await register_work_item(item.id, db, _Actor())

    assert res.status == "error"
    assert res.auth_issue is False
    db.refresh(item)
    assert item.servicenow_register_error == "권한 없음 (403)."
    assert item.servicenow_number is None


# ── _build_fields (순수 함수) ─────────────────────────────────────────────────
def test_build_fields_maps_and_cross_references_jira():
    item = WorkItem(
        id=uuid.uuid4(), type="task", assignee="a", primary_assignee="a",
        category="c", content="본문 내용", title="짧은 제목", started_at=datetime.utcnow(),
        priority="high", jira_issue_key="OPS-1", jira_url="https://j/OPS-1",
    )
    fields = _build_fields(item, _cfg())
    assert fields["short_description"] == "짧은 제목"
    assert "본문 내용" in fields["description"]
    assert "OPS-1" in fields["description"] and "https://j/OPS-1" in fields["description"]
    assert fields["urgency"] == "1"


# ── ServiceNowService — fail-safe 계약(httpx.MockTransport) ─────────────────
BASE = "https://itsm.example.com"


def _svc(handler) -> ServiceNowService:
    return ServiceNowService(BASE, "cookie=abc", transport=httpx.MockTransport(handler))


async def test_service_create_record_success():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"result": {"sys_id": "abc123", "number": "INC0012345"}})

    res = await _svc(handler).create_record("incident", {"short_description": "x"})
    assert res["status"] == "ok"
    assert res["number"] == "INC0012345"
    assert res["url"].endswith("abc123")


async def test_service_create_record_401_flags_auth_failed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "User Not Authenticated"}})

    res = await _svc(handler).create_record("incident", {"short_description": "x"})
    assert res["status"] == "error"
    assert res.get("auth_failed") is True


async def test_service_create_record_never_raises_on_connect_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    res = await _svc(handler).create_record("incident", {"short_description": "x"})
    assert res["status"] == "offline"


async def test_service_current_user_ok():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"result": [{"sys_id": "u1", "name": "테스터"}]})

    res = await _svc(handler).current_user()
    assert res["status"] == "ok"
    assert res["display_name"] == "테스터"
