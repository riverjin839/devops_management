"""프로비저닝(업무 → Jira+Confluence 동시 생성) 부분 실패 → 재시도 흐름 — 실제 Postgres 사용.

핵심 검증: 한쪽만 성공했을 때 `provision_status='partial'` + 실패 사유가 업무에
영속화되는지, 재시도 호출이 이미 성공한 쪽을 건드리지 않고(멱등) 나머지만 채우는지,
인증 실패가 `*_auth_issue` 플래그로 정확히 올라오는지. ConfluenceService/JiraService
는 fake 로 대체(네트워크 없음).
"""
import os
import uuid
from datetime import datetime

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.models.work_item import WorkItem  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
import app.routers.jira as jira_router  # noqa: E402
from app.routers.jira import provision_work_item  # noqa: E402
from app.schemas.jira import ProvisionRequest  # noqa: E402


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


class _FakeJiraSvc:
    def __init__(self, result: dict):
        self.result = result
        self.calls = 0
        # 상호 링크(Description 뒤에 Confluence 링크 덧붙이기) PUT 호출 기록.
        self.update_calls: list[tuple] = []

    async def create_issue(self, *a, **kw):
        self.calls += 1
        return self.result

    async def update_issue(self, key, fields):
        self.update_calls.append((key, fields))
        return {"status": "ok"}


class _FakeConfluenceSvc:
    def __init__(self, result: dict):
        self.result = result
        self.calls = 0

    async def upsert_page(self, *a, **kw):
        self.calls += 1
        return self.result


def _uid() -> str:
    """다른 테스트 파일과 공유하는 실 DB 에서 jira_issue_id 부분 UNIQUE 제약과
    충돌하지 않도록, 픽스처마다 고정 문자열("1", "42" 등) 대신 매번 새 값을 쓴다."""
    return uuid.uuid4().hex[:12]


def _cfg_full():
    return {"base_url": "https://jira.example.com", "confluence_base_url": "https://c.example.com",
            "verify_tls": True, "jira_epic_field": ""}


def _patch(monkeypatch, *, jira_svc=None, jira_ok=True, conf_svc=None, conf_ok=True):
    async def _jira_verified(db, actor, cfg):
        return jira_svc, ({"status": "ok"} if jira_ok else {"status": "error"})

    async def _conf_verified(db, actor, cfg):
        return conf_svc, ({"status": "ok"} if conf_ok else {"status": "error", "detail": "Confluence 세션 없음"})

    monkeypatch.setattr(jira_router, "_jira_service_verified", _jira_verified)
    monkeypatch.setattr(jira_router, "_confluence_service_verified", _conf_verified)
    monkeypatch.setattr(jira_router, "_get_config", lambda db: _cfg_full())


async def test_partial_failure_persists_status_and_error(db, monkeypatch):
    """Jira 성공 + Confluence 실패 → provision_status='partial', 사유가 업무에 남는다."""
    item = _make_work_item(db)
    key, iid = f"OPS-{_uid()}", _uid()
    jira_svc = _FakeJiraSvc({"status": "ok", "key": key, "id": iid, "url": f"https://j/{key}"})
    conf_svc = _FakeConfluenceSvc({"status": "error", "detail": "권한 없음 (403)."})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS"),
        db, _Actor(),
    )
    assert res.status == "partial"
    assert res.jira_key == key
    assert res.confluence_url is None
    assert not res.jira_auth_issue and not res.confluence_auth_issue

    db.refresh(item)
    assert item.provision_status == "partial"
    assert item.provision_jira_error is None
    assert item.provision_confluence_error == "권한 없음 (403)."
    assert item.jira_issue_key == key
    assert item.confluence_page_id is None


async def test_retry_skips_already_succeeded_jira_side(db, monkeypatch):
    """재시도(둘 다 True 로 재요청)해도 이미 성공한 Jira 는 다시 만들지 않는다(멱등)."""
    existing_key = f"OPS-{_uid()}"
    item = _make_work_item(
        db, jira_issue_key=existing_key, jira_url=f"https://j/{existing_key}",
        provision_status="partial", provision_confluence_error="권한 없음 (403).",
    )
    new_key, page_id = f"OPS-{_uid()}", _uid()
    jira_svc = _FakeJiraSvc({"status": "ok", "key": new_key, "id": _uid(), "url": f"https://j/{new_key}"})
    conf_svc = _FakeConfluenceSvc({"status": "ok", "id": page_id, "url": f"https://c/{page_id}", "action": "created"})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS"),
        db, _Actor(),
    )
    assert res.status == "ok"
    assert jira_svc.calls == 0          # Jira 는 이미 연결돼 있어 호출조차 안 됨
    assert conf_svc.calls == 1
    assert res.jira_key == existing_key  # 기존 값 유지 (새로 만든 new_key 가 아님)
    assert res.confluence_url == f"https://c/{page_id}"

    db.refresh(item)
    assert item.provision_status == "ok"
    assert item.provision_jira_error is None
    assert item.provision_confluence_error is None
    assert item.confluence_page_id == page_id


async def test_retry_skips_already_succeeded_confluence_side(db, monkeypatch):
    """대칭 케이스 — Confluence 는 이미 연결돼 있으면 새 버전으로 다시 올리지 않는다."""
    existing_page_id = _uid()
    item = _make_work_item(
        db, confluence_page_id=existing_page_id, confluence_url=f"https://c/{existing_page_id}",
        provision_status="partial", provision_jira_error="프로젝트 키를 지정하세요.",
    )
    key, new_page_id = f"OPS-{_uid()}", _uid()
    jira_svc = _FakeJiraSvc({"status": "ok", "key": key, "id": _uid(), "url": f"https://j/{key}"})
    conf_svc = _FakeConfluenceSvc({"status": "ok", "id": new_page_id, "url": f"https://c/{new_page_id}", "action": "updated"})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS"),
        db, _Actor(),
    )
    assert res.status == "ok"
    assert conf_svc.calls == 0
    assert jira_svc.calls == 1
    assert res.confluence_page_id == existing_page_id  # 기존 값 유지
    # 이번에 만들지 않은 문서로 상호 링크 PUT 을 쏘지 않는다(멱등) — 예전에는 이 지점에서
    # conf_ok 만 보고 진입해 UnboundLocalError(page_title) 로 500 이 났다.
    assert jira_svc.update_calls == []


async def test_mutual_link_runs_only_when_confluence_created_now(db, monkeypatch):
    """Jira·Confluence 를 이번 호출에서 함께 만든 경우에는 상호 링크 PUT 이 나간다."""
    item = _make_work_item(db)
    key, page_id = f"OPS-{_uid()}", _uid()
    jira_svc = _FakeJiraSvc({"status": "ok", "key": key, "id": _uid(), "url": f"https://j/{key}"})
    conf_svc = _FakeConfluenceSvc(
        {"status": "ok", "id": page_id, "url": f"https://c/{page_id}", "action": "created"})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS"),
        db, _Actor(),
    )
    assert res.status == "ok"
    assert len(jira_svc.update_calls) == 1
    updated_key, fields = jira_svc.update_calls[0]
    assert updated_key == key
    # 링크 텍스트로 문서 제목이 들어가고, 빈 `[|url]` 이 아니어야 한다.
    assert f"[{item.title}|https://c/{page_id}]" in fields["description"]


async def test_auth_failure_sets_auth_issue_flags(db, monkeypatch):
    """세션/토큰 문제(svc=None)면 auth_issue 플래그가 서고, 프론트가 연결 설정 카드를 띄울 수 있다."""
    item = _make_work_item(db)
    conf_svc = _FakeConfluenceSvc({"status": "ok"})
    # jira_svc=None → "내 Jira 인증이 등록되지 않았습니다" 경로
    _patch(monkeypatch, jira_svc=None, conf_svc=conf_svc, conf_ok=False)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS"),
        db, _Actor(),
    )
    assert res.status == "error"
    assert res.jira_auth_issue is True
    assert res.confluence_auth_issue is True

    db.refresh(item)
    assert item.provision_status == "error"
    assert item.provision_jira_error == "내 Jira 인증이 등록되지 않았습니다."


async def test_epic_link_applied_persists_epic_key(db, monkeypatch):
    """create_issue 가 epic_link_applied=True 를 주면(실제로 Epic Link 필드가 실렸음)
    업무에도 jira_epic_key 가 그대로 기록된다."""
    item = _make_work_item(db)
    key = f"OPS-{_uid()}"
    jira_svc = _FakeJiraSvc({"status": "ok", "key": key, "id": _uid(), "url": f"https://j/{key}",
                             "epic_link_applied": True})
    conf_svc = _FakeConfluenceSvc({"status": "ok", "id": _uid(), "url": "https://c/x", "action": "created"})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS", epic_key="OPS-1"),
        db, _Actor(),
    )
    assert res.status == "ok"
    assert res.jira_detail == ""

    db.refresh(item)
    assert item.jira_epic_key == "OPS-1"


async def test_epic_link_not_applied_skips_epic_key_and_warns(db, monkeypatch):
    """Epic 을 선택해 Task 를 만들었는데 실제로는 Epic Link 필드가 안 실렸다면(관리자가
    jira_epic_field 를 설정하지 않은 등) 이슈는 생성됐어도 PEP DB 에 Epic 연결을 기록하지
    않고(실제 Jira 와 어긋나므로) jira_detail 에 경고를 남겨야 한다 — 회귀: 예전엔 이 경우도
    무조건 item.jira_epic_key 를 채워 "PEP 는 Epic 하위인데 실제 Jira 는 아니다" 라는 불일치가
    사용자 모르게 발생했다."""
    item = _make_work_item(db)
    key = f"OPS-{_uid()}"
    jira_svc = _FakeJiraSvc({"status": "ok", "key": key, "id": _uid(), "url": f"https://j/{key}",
                             "epic_link_applied": False})
    conf_svc = _FakeConfluenceSvc({"status": "ok", "id": _uid(), "url": "https://c/x", "action": "created"})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS", epic_key="OPS-1"),
        db, _Actor(),
    )
    assert res.status == "ok"  # 이슈 생성 자체는 성공
    assert res.jira_key == key
    assert "Epic 연결에 실패했습니다" in res.jira_detail

    db.refresh(item)
    assert item.jira_epic_key is None


async def test_create_issue_auth_failed_propagates_to_jira_auth_issue(db, monkeypatch):
    """create_issue 가 401(auth_failed=True) 을 주면 jira_auth_issue 로 그대로 전달된다
    (svc 자체는 존재하지만 토큰이 만료된 케이스 — svc=None 케이스와는 다른 경로)."""
    item = _make_work_item(db)
    page_id = _uid()
    jira_svc = _FakeJiraSvc({"status": "error", "detail": "인증 실패 — 토큰을 확인하세요 (401).",
                            "auth_failed": True})
    conf_svc = _FakeConfluenceSvc({"status": "ok", "id": page_id, "url": f"https://c/{page_id}", "action": "created"})
    _patch(monkeypatch, jira_svc=jira_svc, conf_svc=conf_svc)

    res = await provision_work_item(
        ProvisionRequest(work_item_id=str(item.id), remember_preset=False,
                         project_key="OPS", space_key="OPS"),
        db, _Actor(),
    )
    assert res.status == "partial"
    assert res.jira_auth_issue is True
    assert res.confluence_auth_issue is False
