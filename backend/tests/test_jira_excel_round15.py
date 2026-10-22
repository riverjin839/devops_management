"""Jira 엑셀 가져오기 저장 경로 — R-4 15차 B-1·B-2·B-4·B-5·B-6 회귀 테스트.

- B-1 테넌트: 안 보이는 기존 업무는 덮지 않고(행 오류), 새 업무는 지정/기본 공유 범위로 만든다.
  라이브 가져오기(`POST /jira/import`)도 같은 규칙.
- B-2 덮어쓰기: dry_run diff · only_keys · 빈 셀 유지 · 본문/칸반은 비었을 때만.
- B-4 원자성: 행별 savepoint — 한 행의 DB 오류는 그 행만. 요청 안 중복 키는 첫 행만.
- B-5 상한: 파일 10MB · 붙여넣기 2MB · 저장 2000행 → 413. 미리보기 truncated/duplicates.
- B-6 jira_url: 클라이언트 값 무시, 서버 base_url 로 재구성. 키 형식 검증.

핸들러를 직접 호출하고 실제 DB 로 검증한다.
"""
import os
import uuid
from datetime import date, datetime
from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.audit_log import AuditLog
from app.models.project import Project
from app.models.tenant import Tenant, TenantMember
from app.models.user import User
from app.models.work_item import WorkItem
from app.routers import jira as jira_router
from app.schemas.jira import (
    JiraExcelPasteRequest, JiraExcelRow, JiraExcelSaveRequest, JiraImportRequest,
)
from app.services.tenant_scope import TenantScope, user_tenant_ids

BASE = "https://jira.example.com"


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


@pytest.fixture(autouse=True)
def _jira_cfg(monkeypatch):
    cfg = {"base_url": BASE, "enabled": True}
    monkeypatch.setattr(jira_router, "_get_config", lambda _db: dict(cfg))
    return cfg


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    prefix = f"T{tag.upper()}"
    users = {
        k: User(username=f"{k}-{tag}", hashed_password="x", role="operator")
        for k in ("member", "multi", "outsider")
    }
    t1 = Tenant(name=f"team1-{tag}")
    t2 = Tenant(name=f"team2-{tag}")
    db.add_all([t1, t2, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=t1.id, user_id=users["member"].id),
        TenantMember(tenant_id=t1.id, user_id=users["multi"].id),
        TenantMember(tenant_id=t2.id, user_id=users["multi"].id),
    ])
    private_project = Project(name=f"private-{tag}", tenant_id=t1.id)
    db.add(private_project)
    db.commit()

    w = {"tag": tag, "prefix": prefix, "t1": t1, "t2": t2, "project": private_project, **users}
    yield w

    db.rollback()
    db.query(WorkItem).filter(WorkItem.jira_issue_key.like(f"{prefix}%")).delete(synchronize_session=False)
    db.query(Project).filter(Project.name.like(f"%{tag}%")).delete(synchronize_session=False)
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_([str(u) for u in uids])).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


def _scope(db, user) -> TenantScope:
    return TenantScope(is_admin=user.role == "admin", tenant_ids=user_tenant_ids(db, user))


def _item(key, **kw):
    base = dict(type="task", assignee="홍길동", primary_assignee="홍길동", category="Jira",
                title=f"old {key}", content="기존 본문", kanban_status="in_progress",
                started_at=datetime.utcnow(), jira_issue_key=key, jira_status="To Do",
                jira_url=f"{BASE}/browse/{key}")
    base.update(kw)
    return WorkItem(**base)


def _row(key, **kw):
    return JiraExcelRow(key=key, **{"summary": f"new {key}", **kw})


def _save(db, user, rows, **kw):
    return jira_router.import_excel_save(
        JiraExcelSaveRequest(rows=rows, **kw), db=db, actor=user, scope=_scope(db, user),
    )


def _get(db, key):
    db.expire_all()
    return db.query(WorkItem).filter(WorkItem.jira_issue_key == key).all()


# ── B-1 테넌트 ──────────────────────────────────────────────────────────────────

def test_save_does_not_touch_item_of_other_tenant(db, world):
    key = f"{world['prefix']}-1"
    db.add(_item(key, tenant_id=world["t1"].id))
    db.commit()

    res = _save(db, world["outsider"], [_row(key, status="Done")])

    assert res.status == "ok"
    assert res.items[0].action == "error"
    assert res.items[0].error == "다른 공유 범위의 항목과 키가 겹칩니다"
    assert res.updated == 0 and res.imported == 0
    rows = _get(db, key)
    assert len(rows) == 1  # 같은 키로 새로 만들지도 않는다
    assert rows[0].title == f"old {key}"
    assert world["outsider"].username not in (rows[0].jira_watchers or [])


def test_save_does_not_touch_item_in_private_project(db, world):
    key = f"{world['prefix']}-2"
    db.add(_item(key, project_id=world["project"].id))
    db.commit()

    res = _save(db, world["outsider"], [_row(key)])
    assert res.items[0].action == "error"

    res = _save(db, world["member"], [_row(key)])
    assert res.items[0].action == "update"
    assert _get(db, key)[0].title == f"new {key}"


def test_save_defaults_to_single_tenant(db, world):
    key = f"{world['prefix']}-3"
    res = _save(db, world["member"], [_row(key)])
    assert res.imported == 1
    assert res.tenant_id == world["t1"].id
    assert _get(db, key)[0].tenant_id == world["t1"].id


def test_save_without_membership_is_shared(db, world):
    key = f"{world['prefix']}-4"
    res = _save(db, world["outsider"], [_row(key)])
    assert res.imported == 1
    assert _get(db, key)[0].tenant_id is None


def test_save_multi_tenant_requires_choice(db, world):
    key = f"{world['prefix']}-5"
    with pytest.raises(HTTPException) as ei:
        _save(db, world["multi"], [_row(key)])
    assert ei.value.status_code == 422
    assert ei.value.detail == "공유 범위를 선택하세요"
    assert _get(db, key) == []

    # dry_run 은 범위 없이도 미리보기를 돌려준다.
    res = _save(db, world["multi"], [_row(key)], dry_run=True)
    assert res.items[0].action == "create"

    res = _save(db, world["multi"], [_row(key)], tenant_id=world["t2"].id)
    assert res.imported == 1
    assert _get(db, key)[0].tenant_id == world["t2"].id


def test_save_rejects_unassignable_tenant(db, world):
    with pytest.raises(HTTPException) as ei:
        _save(db, world["outsider"], [_row(f"{world['prefix']}-6")], tenant_id=world["t1"].id)
    assert ei.value.status_code == 403


# ── B-2 덮어쓰기 규칙 · dry_run · only_keys ─────────────────────────────────────

def test_dry_run_reports_changes_without_writing(db, world):
    key = f"{world['prefix']}-10"
    db.add(_item(key))
    db.commit()

    res = _save(db, world["member"], [_row(key, status="In Review", due_date="2026-11-30")], dry_run=True)

    assert res.dry_run is True
    item = res.items[0]
    assert item.action == "update"
    changed = {c.field: c for c in item.changes}
    assert set(changed) == {"title", "jira_status", "due_date"}
    assert changed["title"].before == f"old {key}"
    assert changed["title"].after == f"new {key}"
    assert changed["jira_status"].before == "To Do"
    row = _get(db, key)[0]
    assert row.title == f"old {key}" and row.jira_status == "To Do" and row.due_date is None


def test_overwrite_rules_keep_local_values(db, world):
    key = f"{world['prefix']}-11"
    db.add(_item(key, due_date=date(2026, 1, 1)))
    db.commit()

    # 빈 셀(요약·상태·마감일 없음) → 아무것도 안 바뀐다 → skip
    res = _save(db, world["member"], [JiraExcelRow(key=key)])
    assert res.items[0].action == "skip"
    row = _get(db, key)[0]
    assert row.title == f"old {key}" and row.jira_status == "To Do" and row.due_date == date(2026, 1, 1)

    # 본문·칸반은 기존 값이 있으면 유지, 제목·Jira 상태·마감일은 엑셀이 소유
    res = _save(db, world["member"], [_row(key, status="Done", due_date="2026-12-24", description="엑셀 본문")])
    assert res.items[0].action == "update"
    row = _get(db, key)[0]
    assert row.title == f"new {key}"
    assert row.jira_status == "Done"
    assert row.due_date == date(2026, 12, 24)
    assert row.content == "기존 본문"
    assert row.kanban_status == "in_progress"
    assert world["member"].username in row.jira_watchers


def test_overwrite_fills_empty_content(db, world):
    key = f"{world['prefix']}-12"
    db.add(_item(key, content=""))
    db.commit()
    res = _save(db, world["member"], [_row(key, description="엑셀 본문")], dry_run=True)
    assert "content" in {c.field for c in res.items[0].changes}
    _save(db, world["member"], [_row(key, description="엑셀 본문")])
    assert _get(db, key)[0].content == "엑셀 본문"


def test_only_keys_applies_selected_rows(db, world):
    k1, k2 = f"{world['prefix']}-20", f"{world['prefix']}-21"
    res = _save(db, world["member"], [_row(k1), _row(k2)], only_keys=[k2])
    actions = {i.jira_key: i.action for i in res.items}
    assert actions == {k1: "skip", k2: "create"}
    assert _get(db, k1) == []
    assert len(_get(db, k2)) == 1


# ── B-6 jira_url · 키 검증 ─────────────────────────────────────────────────────

def test_jira_url_rebuilt_from_server_base_url(db, world):
    key = f"{world['prefix']}-30"
    _save(db, world["member"], [_row(key, jira_url="javascript:alert(1)")])
    assert _get(db, key)[0].jira_url == f"{BASE}/browse/{key}"


def test_jira_url_kept_when_base_url_empty(db, world, _jira_cfg):
    key = f"{world['prefix']}-31"
    db.add(_item(key, jira_url="https://old/browse/X-1"))
    db.commit()
    _jira_cfg["base_url"] = ""
    _save(db, world["member"], [_row(key, jira_url="javascript:alert(1)")])
    assert _get(db, key)[0].jira_url == "https://old/browse/X-1"


def test_invalid_rows_are_row_errors_others_saved(db, world):
    good = f"{world['prefix']}-40"
    rows = [
        _row(f"{world['prefix'].lower()}-41"),            # 소문자 → 형식 오류
        _row(f"{world['prefix']}{'X' * 50}-42"),          # 50자 초과
        _row(f"{world['prefix']}-43", status="S" * 101),  # 상태 100자 초과
        _row(good),
    ]
    res = _save(db, world["member"], rows)
    assert [i.action for i in res.items] == ["error", "error", "error", "create"]
    assert "형식" in res.items[0].error
    assert "50자" in res.items[1].error
    assert "100자" in res.items[2].error
    assert len(res.errors) == 3
    assert res.imported == 1 and len(_get(db, good)) == 1


# ── B-4 원자성 · 중복 키 · 응답 상한 · 감사 ─────────────────────────────────────

def test_db_error_rolls_back_only_that_row(db, world, monkeypatch):
    real = jira_router.map_issue_type
    # type 컬럼은 String(20) — "Boom" 행만 flush 에서 길이 초과로 실패하게 만든다.
    monkeypatch.setattr(
        jira_router, "map_issue_type",
        lambda t: ("x" * 30, None) if t == "Boom" else real(t),
    )
    k1, k2, k3 = (f"{world['prefix']}-5{i}" for i in range(3))
    res = _save(db, world["member"], [_row(k1), _row(k2, issue_type="Boom"), _row(k3)])

    assert res.status == "ok"
    assert [i.action for i in res.items] == ["create", "error", "create"]
    assert res.items[1].error.startswith("저장 실패")
    assert res.imported == 2
    assert len(_get(db, k1)) == 1 and _get(db, k2) == [] and len(_get(db, k3)) == 1


def test_duplicate_keys_first_row_wins(db, world):
    key = f"{world['prefix']}-60"
    res = _save(db, world["member"], [_row(key, summary="첫 행"), _row(key, summary="둘째 행")])
    assert [i.action for i in res.items] == ["create", "skip"]
    assert "중복" in res.items[1].error
    assert len(res.warnings) == 1
    rows = _get(db, key)
    assert len(rows) == 1 and rows[0].title == "첫 행"


def test_items_capped_at_200_with_truncated(db, world):
    rows = [_row(f"{world['prefix']}-{1000 + i}") for i in range(250)]
    res = _save(db, world["member"], rows, dry_run=True)
    assert res.imported == 250
    assert len(res.items) == 200
    assert res.truncated is True
    assert res.total == 250


def test_audit_details_include_keys(db, world):
    k1, k2 = f"{world['prefix']}-70", f"{world['prefix']}-71"
    _save(db, world["member"], [_row(k1), _row(k2)])
    log = (
        db.query(AuditLog)
        .filter(AuditLog.actor_user_id == str(world["member"].id),
                AuditLog.action == "work_item.jira_excel_import")
        .order_by(AuditLog.created_at.desc())
        .first()
    )
    assert log is not None
    assert log.details["keys"] == [k1, k2]
    assert log.details["tenant_id"] == str(world["t1"].id)


# ── B-5 상한 · 미리보기 truncated/duplicates ───────────────────────────────────

def test_excel_upload_over_10mb_is_413(db, world):
    big = UploadFile(file=BytesIO(b"x" * (10 * 1024 * 1024 + 1)), filename="big.xlsx")
    with pytest.raises(HTTPException) as ei:
        jira_router.import_excel(file=big, db=db, _=world["member"])
    assert ei.value.status_code == 413
    assert "10MB" in ei.value.detail


def test_paste_over_2mb_is_413(db, world):
    with pytest.raises(HTTPException) as ei:
        jira_router.import_paste(JiraExcelPasteRequest(text="가" * (700 * 1024)), db=db, _=world["member"])
    assert ei.value.status_code == 413
    assert "2MB" in ei.value.detail


def test_save_over_2000_rows_is_413(db, world):
    rows = [_row(f"{world['prefix']}-{i}") for i in range(2001)]
    with pytest.raises(HTTPException) as ei:
        _save(db, world["member"], rows, dry_run=True)
    assert ei.value.status_code == 413


def test_paste_preview_reports_duplicates_and_truncation(db, world):
    p = world["prefix"]
    lines = ["Key\tSummary", f"{p}-1\ta", f"{p}-2\tb", f"{p}-1\tc"]
    res = jira_router.import_paste(JiraExcelPasteRequest(text="\n".join(lines)), db=db, _=world["member"])
    assert res.status == "ok"
    assert res.duplicates == [f"{p}-1"]
    assert res.truncated is False
    assert res.rows[0].jira_url == f"{BASE}/browse/{p}-1"

    many = ["Key\tSummary"] + [f"{p}-{i}\ts" for i in range(2001)]
    res = jira_router.import_paste(JiraExcelPasteRequest(text="\n".join(many)), db=db, _=world["member"])
    assert res.total == 2000
    assert res.truncated is True


# ── B-1 라이브 가져오기(POST /jira/import)도 같은 테넌트 규칙 ─────────────────────

class _FakeSvc:
    def __init__(self, issues):
        self._issues = issues

    async def search(self, jql, extra_fields=None):  # noqa: ARG002
        return {"status": "ok", "issues": self._issues, "total": len(self._issues)}


def _patch_live(monkeypatch, keys):
    issues = [{"key": k, "id": f"id-{k}", "fields": {}} for k in keys]

    async def _verified(db, actor, cfg):  # noqa: ARG001
        return _FakeSvc(issues), {}

    async def _no_chain(svc, issues, epic_field):  # noqa: ARG001
        return {}

    def _map(issue, base_url, **_kw):
        k = issue["key"]
        return {
            "jira_issue_id": issue["id"], "jira_issue_key": k, "title": f"live {k}",
            "content": "live body", "kanban_status": "todo", "priority": "medium",
            "type": "task", "type_label": None, "primary_assignee": "홍길동", "category": "Jira",
            "started_at": datetime.utcnow(), "closed_at": None, "jira_url": f"{base_url}/browse/{k}",
            "jira_status": "To Do", "jira_updated_at": datetime.utcnow(),
        }

    monkeypatch.setattr(jira_router, "_user_credential", lambda db, u: ("tok", "pat"))
    monkeypatch.setattr(jira_router, "_jira_service_verified", _verified)
    monkeypatch.setattr(jira_router, "_resolve_epic_chain", _no_chain)
    monkeypatch.setattr(jira_router, "map_jira_issue", _map)


async def test_live_import_respects_tenant_scope(db, world, monkeypatch):
    hidden, fresh = f"{world['prefix']}-80", f"{world['prefix']}-81"
    db.add(_item(hidden, tenant_id=world["t1"].id, jira_issue_id=f"id-{hidden}"))
    db.commit()
    _patch_live(monkeypatch, [hidden, fresh])

    res = await jira_router.import_issues(
        JiraImportRequest(scope="jql", jql="project = X"), db=db,
        actor=world["outsider"], scope=_scope(db, world["outsider"]),
    )
    assert res.status == "ok"
    assert any("다른 공유 범위의 항목과 키가 겹칩니다" in e for e in res.errors)
    assert res.imported == 1 and res.updated == 0
    assert {i.jira_key for i in res.items} == {fresh}
    hidden_rows = _get(db, hidden)
    assert len(hidden_rows) == 1 and hidden_rows[0].title == f"old {hidden}"
    assert _get(db, fresh)[0].tenant_id is None


async def test_live_import_assigns_single_tenant(db, world, monkeypatch):
    key = f"{world['prefix']}-82"
    _patch_live(monkeypatch, [key])
    res = await jira_router.import_issues(
        JiraImportRequest(scope="jql", jql="project = X"), db=db,
        actor=world["member"], scope=_scope(db, world["member"]),
    )
    assert res.imported == 1
    assert _get(db, key)[0].tenant_id == world["t1"].id
