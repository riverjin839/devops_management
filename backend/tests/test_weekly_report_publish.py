"""주간보고 Confluence 게시 — 동기·SSE·Celery 자동 게시 공용 본체 회귀 테스트.

게시는 보고서 빌드 → 대상(스페이스·부모·제목) → Confluence 세션 확인 → 본문 렌더 → 페이지
upsert → 감사 기록 순으로 진행된다. 예전에는 단건 요청이라 화면이 응답 뒤에 단계 줄을 지어냈고,
제목 템플릿 오류·빌드 예외가 빈 500 으로 끝났다. 이제 `/publish/stream` 이 단계를 실시간으로
흘리고, 동기 `/publish` 는 같은 본체를 noop emit 으로 부른다.

Confluence 는 가짜 서비스로 대체한다(실 DB 사용 — 감사 로그·사용자 행).
"""
import json
import os
import uuid
from datetime import datetime, timedelta

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.user_jira_credential import UserJiraCredential  # noqa: E402
import app.routers.jira as jira  # noqa: E402

PUBLISH = "/api/v1/jira/weekly-report/publish"
STREAM = "/api/v1/jira/weekly-report/publish/stream"

FAKE_REPORT = {
    "period_start": "2026-10-19",
    "period_end": "2026-10-23",
    "title": "주간보고 2026-10-19 ~ 2026-10-23",
    "summary": {"total": 2, "in_progress": 1, "done": 1, "delayed": 0, "note": ""},
    "progress": [{
        "category": "infra", "epic": "DL-1 플랫폼", "epic_key": "DL-1", "epic_name": "플랫폼",
        "epic_url": "", "planned_rate": 50, "actual_rate": 50, "achievement_rate": 100,
        "done_count": 1, "in_progress_count": 1, "total_count": 2,
    }],
    "details": [
        {"component": "infra", "task": "DL-1 플랫폼", "epic_key": "DL-1", "epic_name": "플랫폼",
         "epic_url": "", "sub_task": "노드 증설", "start": "2026-10-19", "due": "2026-10-30",
         "closed": "", "status": "진행", "issue": "", "note": "", "jira_key": "DL-2", "jira_url": ""},
        {"component": "infra", "task": "DL-1 플랫폼", "epic_key": "DL-1", "epic_name": "플랫폼",
         "epic_url": "", "sub_task": "인증서 갱신", "start": "2026-10-19", "due": "2026-10-20",
         "closed": "2026-10-20", "status": "완료", "issue": "", "note": "", "jira_key": "DL-3",
         "jira_url": ""},
    ],
    "owners": [
        {"task": "노드 증설", "assignee": "kim", "main_work": "증설", "issue_summary": ""},
        {"task": "인증서 갱신", "assignee": "lee", "main_work": "갱신", "issue_summary": ""},
    ],
}


class _FakeConfluence:
    """find_page/upsert_page 만 흉내내는 스텁 — calls 에 호출을 남긴다."""

    def __init__(self, *, existing_version=None, upsert_status="ok"):
        self.existing_version = existing_version
        self.upsert_status = upsert_status
        self.calls: list[tuple] = []

    async def find_page(self, space_key, title):
        self.calls.append(("find", space_key, title))
        if self.existing_version is None:
            return {"status": "ok", "found": False}
        return {"status": "ok", "found": True, "id": "777", "version": self.existing_version}

    async def upsert_page(self, space_key, title, body, *, parent_id=""):
        self.calls.append(("upsert", space_key, title, parent_id, len(body)))
        if self.upsert_status != "ok":
            return {"status": self.upsert_status, "detail": "Confluence 연결 불가"}
        action = "updated" if self.existing_version is not None else "created"
        return {"status": "ok", "action": action, "id": "777",
                "url": "https://conf.example/pages/777"}


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()  # 구버전 테스트 DB 에 새 컬럼 보강(create_all 은 기존 테이블을 고치지 않는다)


@pytest.fixture
def db(_schema):
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def op(db):
    tag = uuid.uuid4().hex[:8]
    user = User(username=f"weekly-op-{tag}", hashed_password="x", role="operator")
    db.add(user)
    db.commit()
    yield user
    db.query(AuditLog).filter(AuditLog.actor_user_id == str(user.id)).delete(synchronize_session=False)
    db.query(UserJiraCredential).filter(UserJiraCredential.username == user.username).delete(
        synchronize_session=False)
    db.query(User).filter(User.id == user.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def settings_state(monkeypatch):
    """주간보고 설정·Jira 공통 설정을 DB 대신 메모리에서 — 전역 AppSetting 을 건드리지 않는다."""
    state = {
        "weekly": dict(jira.DEFAULT_WEEKLY_SETTINGS, space_key="TEAM", parent_page_id="42"),
        "cfg": {"base_url": "https://jira.example", "confluence_base_url": "https://conf.example",
                "verify_tls": True},
    }
    monkeypatch.setattr(jira, "_get_weekly_settings", lambda _db: dict(state["weekly"]))
    monkeypatch.setattr(jira, "_get_config", lambda _db: dict(state["cfg"]))
    return state


@pytest.fixture
def report(monkeypatch):
    state = {"raises": None, "calls": []}

    def fake_build(_db, *, anchor=None, project_filter="", base_url=""):
        state["calls"].append({"anchor": anchor, "project_filter": project_filter, "base_url": base_url})
        if state["raises"]:
            raise state["raises"]
        return json.loads(json.dumps(FAKE_REPORT))

    monkeypatch.setattr(jira.weekly_report_service, "build_report", fake_build)
    return state


@pytest.fixture
def confluence(monkeypatch):
    """세션 확인 헬퍼를 가짜로 — state['svc'] 가 None 이면 세션 없음."""
    state: dict = {"svc": _FakeConfluence(), "calls": 0}

    async def fake_verified(_db, _actor, _cfg, *, emit=jira.noop_emit):
        state["calls"] += 1
        jira.log_evt(emit, "info", "저장된 Confluence 세션으로 확인 중")
        if state["svc"] is None:
            return None, {"status": "error", "detail": "Confluence 세션이 없습니다 — 테스트"}
        return state["svc"], {"status": "ok", "display_name": "홍길동"}

    monkeypatch.setattr(jira, "_confluence_service_verified", fake_verified)
    return state


@pytest.fixture
def client(op):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: op
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _events(text: str) -> list[dict]:
    out = []
    for block in text.split("\n\n"):
        for ln in block.splitlines():
            if ln.startswith("data:"):
                out.append(json.loads(ln[5:].strip()))
    return out


def _audit_rows(db, user):
    db.expire_all()
    return db.query(AuditLog).filter(
        AuditLog.actor_user_id == str(user.id),
        AuditLog.action == "work_item.weekly_report_publish",
    ).all()


# ── 동기 게시 ────────────────────────────────────────────────────────────────
def test_sync_publish_ok_keeps_response_shape_and_records_audit(
    client, db, op, settings_state, report, confluence,
):
    res = client.post(PUBLISH, json={"week_of": "2026-10-21"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {"status", "detail", "action", "page_url", "page_id"}
    assert body["status"] == "ok"
    assert body["action"] == "created"
    assert body["page_id"] == "777"
    assert body["page_url"] == "https://conf.example/pages/777"
    assert "생성" in body["detail"]

    svc = confluence["svc"]
    upsert = [c for c in svc.calls if c[0] == "upsert"][0]
    # 제목은 설정 템플릿으로, 부모는 설정값으로
    assert upsert[1:4] == ("TEAM", "주간보고 2026-10-19 ~ 2026-10-23", "42")
    assert report["calls"][0]["base_url"] == "https://jira.example"

    rows = _audit_rows(db, op)
    assert len(rows) == 1
    assert rows[0].target_id == "777"
    assert rows[0].details["space"] == "TEAM"
    assert rows[0].details["action"] == "created"


def test_sync_publish_session_missing_returns_error_result(client, db, op, settings_state, report, confluence):
    confluence["svc"] = None
    res = client.post(PUBLISH, json={})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "error"
    assert "Confluence 세션이 없습니다" in body["detail"]
    assert body["page_id"] is None
    assert _audit_rows(db, op) == []


def test_sync_publish_upsert_offline_returns_offline(client, db, op, settings_state, report, confluence):
    confluence["svc"] = _FakeConfluence(upsert_status="offline")
    body = client.post(PUBLISH, json={}).json()
    assert body["status"] == "offline"
    assert body["detail"] == "Confluence 연결 불가"
    assert _audit_rows(db, op) == []


def test_sync_publish_without_space_stays_error_result(client, settings_state, report, confluence):
    """동기 경로는 기존처럼 스페이스 미지정을 status=error 결과로 돌려준다(422 아님)."""
    settings_state["weekly"]["space_key"] = ""
    res = client.post(PUBLISH, json={})
    assert res.status_code == 200
    assert res.json()["status"] == "error"
    assert "스페이스 키를 지정하세요" in res.json()["detail"]
    assert confluence["calls"] == 0


def test_sync_publish_build_exception_is_structured_error(client, settings_state, report, confluence):
    report["raises"] = RuntimeError("work_items 조회 실패")
    res = client.post(PUBLISH, json={})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "error"
    assert "보고서 빌드 실패" in body["detail"] and "work_items 조회 실패" in body["detail"]
    assert confluence["calls"] == 0


@pytest.mark.parametrize("template", ["주간보고 {week}", "주간보고 {}", "주간보고 {start"])
def test_sync_publish_bad_title_template_is_422(client, settings_state, report, confluence, template):
    settings_state["weekly"]["title_template"] = template
    res = client.post(PUBLISH, json={})
    assert res.status_code == 422
    assert "제목 템플릿이 잘못되었습니다" in res.json()["detail"]
    assert report["calls"] == [] and confluence["calls"] == 0


@pytest.mark.parametrize("path", [PUBLISH, STREAM])
def test_bad_week_of_is_422_instead_of_this_week(client, settings_state, report, confluence, path):
    """D-157: 형식이 틀린 주차를 조용히 '이번 주' 로 바꿔 게시하지 않는다."""
    res = client.post(path, json={"week_of": "2026/10/21"})
    assert res.status_code == 422
    assert "주차 날짜 형식" in res.json()["detail"]
    assert report["calls"] == [] and confluence["calls"] == 0


def test_publish_uses_requested_week_anchor(client, settings_state, report, confluence):
    """D-157: 화면이 보낸 주차(미리보기의 periodStart)를 그대로 빌드 기준일로 쓴다."""
    body = client.post(PUBLISH, json={"week_of": "2026-10-12"}).json()
    assert body["status"] == "ok"
    assert str(report["calls"][0]["anchor"]) == "2026-10-12"


def test_bad_template_is_ignored_when_title_is_given(client, settings_state, report, confluence):
    settings_state["weekly"]["title_template"] = "주간보고 {week}"
    body = client.post(PUBLISH, json={"title": "직접 {제목}"}).json()
    assert body["status"] == "ok"
    upsert = [c for c in confluence["svc"].calls if c[0] == "upsert"][0]
    assert upsert[2] == "직접 {제목}"


# ── SSE 스트림 ───────────────────────────────────────────────────────────────
def test_stream_emits_steps_in_order_then_result(client, db, op, settings_state, report, confluence):
    confluence["svc"] = _FakeConfluence(existing_version=3)
    res = client.post(STREAM, json={"space_key": "OPS", "parent_page_id": "9"})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/event-stream")
    evts = _events(res.text)
    assert "error" not in [e["type"] for e in evts], evts

    steps = [(e["name"], e["status"]) for e in evts if e["type"] == "step"]
    assert steps == [
        ("build", "running"), ("build", "done"),
        ("target", "running"), ("target", "done"),
        ("session", "running"), ("session", "done"),
        ("render", "running"), ("render", "done"),
        ("upsert", "running"), ("upsert", "done"),
        ("audit", "running"), ("audit", "done"),
    ]
    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert any("전체 2" in m and "진행 1" in m for m in logs)
    assert any("스페이스 OPS" in m and "상위 페이지 9" in m for m in logs)
    assert any("저장된 Confluence 세션으로 확인 중" in m for m in logs)
    assert any("세션 확인 완료" in m and "홍길동" in m for m in logs)
    assert any(m.startswith("표 4개") and "KB" in m for m in logs)
    assert any("v3" in m and "v4" in m for m in logs)
    assert any("갱신" in m and "777" in m for m in logs)

    assert evts[-1]["type"] == "result"
    result = evts[-1]["result"]
    assert result["status"] == "ok" and result["action"] == "updated" and result["page_id"] == "777"
    assert len(_audit_rows(db, op)) == 1


def test_stream_session_missing_marks_step_failed_and_returns_error_result(
    client, db, op, settings_state, report, confluence,
):
    confluence["svc"] = None
    evts = _events(client.post(STREAM, json={}).text)
    steps = [(e["name"], e["status"]) for e in evts if e["type"] == "step"]
    assert ("session", "failed") in steps
    assert ("render", "running") not in steps and ("upsert", "running") not in steps
    errors = [e for e in evts if e["type"] == "log" and e["level"] == "error"]
    assert errors and "Confluence 세션이 없습니다" in errors[-1]["message"]
    assert evts[-1]["type"] == "result"
    assert evts[-1]["result"]["status"] == "error"
    assert _audit_rows(db, op) == []


def test_stream_real_session_helper_explains_paths_without_cookie_values(client, op, settings_state, report):
    """실제 세션 헬퍼 — 자격이 하나도 없으면 시도한 경로를 줄로 남기고 error 결과로 끝난다."""
    evts = _events(client.post(STREAM, json={}).text)
    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert any("저장된 Confluence 세션 없음" in m for m in logs)
    assert any("자동 재로그인 불가" in m for m in logs)
    assert ("session", "failed") in [(e["name"], e["status"]) for e in evts if e["type"] == "step"]
    assert evts[-1]["result"]["status"] == "error"


def test_stream_without_space_is_422_before_stream(client, settings_state, report, confluence):
    settings_state["weekly"]["space_key"] = ""
    res = client.post(STREAM, json={})
    assert res.status_code == 422
    assert "Confluence 스페이스 키를 지정하세요" in res.json()["detail"]
    assert report["calls"] == [] and confluence["calls"] == 0


def test_stream_bad_template_is_422_before_stream(client, settings_state, report, confluence):
    settings_state["weekly"]["title_template"] = "주간보고 {week}"
    res = client.post(STREAM, json={})
    assert res.status_code == 422
    assert "{week}" in res.json()["detail"]


def test_stream_build_exception_fails_build_step(client, settings_state, report, confluence):
    report["raises"] = RuntimeError("DB 끊김")
    evts = _events(client.post(STREAM, json={}).text)
    assert ("build", "failed") in [(e["name"], e["status"]) for e in evts if e["type"] == "step"]
    assert evts[-1]["type"] == "result"
    assert evts[-1]["result"]["status"] == "error"
    assert "DB 끊김" in evts[-1]["result"]["detail"]


def test_stream_requires_operator(db, settings_state, report, confluence):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    viewer = User(username=f"weekly-viewer-{uuid.uuid4().hex[:8]}", hashed_password="x", role="viewer")
    app.dependency_overrides[get_current_user] = lambda: viewer
    try:
        res = TestClient(app).post(STREAM, json={})
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert res.status_code == 403


# ── Celery 자동 게시 — 같은 본체, 사유 코드·last_run_at 동작 유지 ────────────────────
@pytest.fixture
def auto_world(db, op):
    """자동 게시 설정(전역 AppSetting)을 잠시 바꾸고 원래 값으로 되돌린다."""
    from app.services import secret_box

    row = db.query(AppSetting).filter(AppSetting.key == jira.WEEKLY_SETTINGS_KEY).first()
    original = dict(row.value) if row and isinstance(row.value, dict) else None
    value = dict(jira.DEFAULT_WEEKLY_SETTINGS, auto_enabled=True, auto_cron="* * * * *",
                 space_key="AUTO", parent_page_id="")
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=jira.WEEKLY_SETTINGS_KEY, value=value))
    # 가장 최근 검증된 Confluence 세션 보유자 = 게시 주체
    db.add(UserJiraCredential(
        username=op.username, token_encrypted=secret_box.encrypt("t"), auth_type="sso",
        confluence_cookie_encrypted=secret_box.encrypt("c"),
        last_verified_at=datetime.utcnow() + timedelta(days=3650),
    ))
    db.commit()
    yield
    db.expire_all()
    row = db.query(AppSetting).filter(AppSetting.key == jira.WEEKLY_SETTINGS_KEY).first()
    if original is None:
        if row:
            db.delete(row)
    else:
        row.value = original
    db.commit()


def _stored_last_run(db):
    db.expire_all()
    row = db.query(AppSetting).filter(AppSetting.key == jira.WEEKLY_SETTINGS_KEY).first()
    return (row.value or {}).get("last_run_at")


def test_celery_dispatch_publishes_through_shared_core(db, op, auto_world, report, confluence):
    from app.celery_app import dispatch_weekly_report

    out = dispatch_weekly_report.run()
    assert out == {"dispatched": True, "result": "ok", "action": "created"}
    upsert = [c for c in confluence["svc"].calls if c[0] == "upsert"][0]
    assert upsert[1] == "AUTO"
    assert _stored_last_run(db)
    # 자동 게시는 기존처럼 감사 로그를 남기지 않는다
    assert _audit_rows(db, op) == []


def test_celery_dispatch_session_missing_keeps_reason_code(db, op, auto_world, report, confluence):
    from app.celery_app import dispatch_weekly_report

    confluence["svc"] = None
    out = dispatch_weekly_report.run()
    assert out == {"dispatched": False, "reason": "confluence_unavailable"}
    assert not _stored_last_run(db)
