"""Jira 가져오기 담당자 매핑 — `_build_assignee_resolver` / `_resolve_self_assignee_name` 검증.

Jira displayName 이 "이름 회사명" 형태(회사 계정 표기)라 PEP 담당자 레지스트리와 문자열이
정확히 일치하지 않는 문제, 그리고 scope='me' 가져오기가 이름 매칭에 기대지 않고 로그인
사용자 자신의 신원으로 바로 확정되는지를 다룬다. 담당자 레지스트리(AppSetting)를 읽어야
해서 실제 테스트 DB 가 필요하다.
"""
import os

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension
from app.models.app_setting import AppSetting
from app.routers.jira import ASSIGNEES_KEY, _build_assignee_resolver, _resolve_self_assignee_name


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


class _Actor:
    """User 최소 스텁 — 두 헬퍼가 읽는 속성만."""

    def __init__(self, username="", display_name=None):
        self.username = username
        self.display_name = display_name


def _set_registry(db, entries):
    """실제 `assignees` 키를 이번 테스트용 값으로 덮고 원복 함수를 반환."""
    row = db.query(AppSetting).filter(AppSetting.key == ASSIGNEES_KEY).first()
    original = row.value if row else None
    if row is None:
        row = AppSetting(key=ASSIGNEES_KEY, value=entries)
        db.add(row)
    else:
        row.value = entries
    db.commit()

    def _restore():
        row2 = db.query(AppSetting).filter(AppSetting.key == ASSIGNEES_KEY).first()
        if original is None:
            db.delete(row2)
        else:
            row2.value = original
        db.commit()

    return _restore


# ── _build_assignee_resolver ────────────────────────────────────────────────
def test_resolver_strips_company_suffix_via_first_token(db):
    restore = _set_registry(db, [{"name": "홍길동", "employeeId": "E1"}])
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "홍길동 ACME회사"}) == "홍길동"
    finally:
        restore()


def test_resolver_exact_displayname_match_still_works(db):
    restore = _set_registry(db, [{"name": "홍길동", "employeeId": "E1"}])
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "홍길동"}) == "홍길동"
    finally:
        restore()


def test_resolver_matches_by_unique_email_over_fuzzy_name(db):
    # 레지스트리 이름이 Jira 표시명과 전혀 안 겹쳐도(동명이인 등으로 이름 표기가 다를 때)
    # 이메일이 고유 키라 안전하게 매칭된다.
    restore = _set_registry(db, [
        {"name": "김민수", "employeeId": "E1", "email": "kim@example.com"},
    ])
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "Minsu Kim 외주사", "emailAddress": "Kim@Example.com"}) == "김민수"
    finally:
        restore()


def test_resolver_falls_back_to_raw_displayname_when_unmatched(db):
    # 레지스트리에 없는 담당자는 (첫 토큰도) 매칭시키지 않고 Jira 원본 표시명 그대로 둔다 —
    # 잘못 잘라낸 이름으로 조용히 덮어쓰지 않기 위한 안전한 폴백.
    restore = _set_registry(db, [{"name": "홍길동", "employeeId": "E1"}])
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "미등록사용자 회사명"}) == "미등록사용자 회사명"
    finally:
        restore()


def test_resolver_self_name_short_circuits_all_matching(db):
    # self_name 이 주어지면(scope=me) Jira 쪽 표시명이 무엇이든 그대로 쓴다 — 매칭 자체를 생략.
    restore = _set_registry(db, [{"name": "홍길동", "employeeId": "E1"}])
    try:
        resolve = _build_assignee_resolver(db, self_name="김철수")
        assert resolve({"displayName": "아무개 회사명", "emailAddress": "unrelated@example.com"}) == "김철수"
    finally:
        restore()


# ── _resolve_self_assignee_name ─────────────────────────────────────────────
def test_resolve_self_assignee_name_uses_registry_employee_id_bridge(db):
    restore = _set_registry(db, [{"name": "홍길동", "employeeId": "E1"}])
    try:
        actor = _Actor(username="E1", display_name="Hong Gildong 회사명")
        # 로그인 username(사번)이 레지스트리 employeeId 와 일치 — 등록된 담당자 이름을 그대로 쓴다
        # (로그인 표시 이름에 회사명이 붙어 있어도 영향받지 않음).
        assert _resolve_self_assignee_name(actor, db) == "홍길동"
    finally:
        restore()


def test_resolve_self_assignee_name_falls_back_to_display_name(db):
    restore = _set_registry(db, [{"name": "홍길동", "employeeId": "E1"}])
    try:
        actor = _Actor(username="UNKNOWN", display_name="김철수")
        assert _resolve_self_assignee_name(actor, db) == "김철수"
    finally:
        restore()


def test_resolve_self_assignee_name_falls_back_to_username_when_no_display_name(db):
    restore = _set_registry(db, [])
    try:
        actor = _Actor(username="plainuser", display_name=None)
        assert _resolve_self_assignee_name(actor, db) == "plainuser"
    finally:
        restore()
