"""Jira 가져오기 담당자 매핑 — `_build_assignee_resolver` / `_resolve_self_assignee_name` 검증.

Jira displayName 이 "이름 회사명" 형태(회사 계정 표기)라 PEP 담당자 명부와 문자열이
정확히 일치하지 않는 문제, 그리고 scope='me' 가져오기가 이름 매칭에 기대지 않고 로그인
사용자 자신의 신원으로 바로 확정되는지를 다룬다. 담당자 명부는 users 테이블 자체이므로
(모델 docstring 참고) 실제 테스트 DB 가 필요하다.
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
from app.models.user import User
from app.routers.jira import _build_assignee_resolver, _resolve_self_assignee_name


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


def _add_roster_row(db, name, employee_id=None, email=None) -> User:
    user = User(display_name=name, employee_id=employee_id, email=email)
    if employee_id:
        user.username = employee_id
        from app.auth.security import hash_password
        user.hashed_password = hash_password(employee_id)
        user.role = "operator"
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


# ── _build_assignee_resolver ────────────────────────────────────────────────
def test_resolver_strips_company_suffix_via_first_token(db):
    row = _add_roster_row(db, "홍길동", employee_id=f"E-{uuid.uuid4().hex[:8]}")
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "홍길동 ACME회사"}) == "홍길동"
    finally:
        db.delete(row); db.commit()


def test_resolver_exact_displayname_match_still_works(db):
    row = _add_roster_row(db, "홍길동", employee_id=f"E-{uuid.uuid4().hex[:8]}")
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "홍길동"}) == "홍길동"
    finally:
        db.delete(row); db.commit()


def test_resolver_matches_by_unique_email_over_fuzzy_name(db):
    # 명부 이름이 Jira 표시명과 전혀 안 겹쳐도(동명이인 등으로 이름 표기가 다를 때)
    # 이메일이 고유 키라 안전하게 매칭된다.
    row = _add_roster_row(db, "김민수", employee_id=f"E-{uuid.uuid4().hex[:8]}", email="kim@example.com")
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "Minsu Kim 외주사", "emailAddress": "Kim@Example.com"}) == "김민수"
    finally:
        db.delete(row); db.commit()


def test_resolver_falls_back_to_raw_displayname_when_unmatched(db):
    # 명부에 없는 담당자는 (첫 토큰도) 매칭시키지 않고 Jira 원본 표시명 그대로 둔다 —
    # 잘못 잘라낸 이름으로 조용히 덮어쓰지 않기 위한 안전한 폴백.
    row = _add_roster_row(db, "홍길동", employee_id=f"E-{uuid.uuid4().hex[:8]}")
    try:
        resolve = _build_assignee_resolver(db)
        assert resolve({"displayName": "미등록사용자 회사명"}) == "미등록사용자 회사명"
    finally:
        db.delete(row); db.commit()


def test_resolver_self_name_short_circuits_all_matching(db):
    # self_name 이 주어지면(scope=me) Jira 쪽 표시명이 무엇이든 그대로 쓴다 — 매칭 자체를 생략.
    row = _add_roster_row(db, "홍길동", employee_id=f"E-{uuid.uuid4().hex[:8]}")
    try:
        resolve = _build_assignee_resolver(db, self_name="김철수")
        assert resolve({"displayName": "아무개 회사명", "emailAddress": "unrelated@example.com"}) == "김철수"
    finally:
        db.delete(row); db.commit()


# ── _resolve_self_assignee_name ─────────────────────────────────────────────
def test_resolve_self_assignee_name_uses_own_display_name(db):
    """담당자 명부와 로그인 계정이 한 행(users 테이블)이므로 actor.display_name 이 곧
    담당자 이름이다 — 예전처럼 로그인 표시 이름에 회사명이 붙어 명부 이름과 어긋나는
    드리프트 자체가 구조적으로 불가능해졌다."""
    emp = f"E-{uuid.uuid4().hex[:8]}"
    row = _add_roster_row(db, "홍길동", employee_id=emp)
    try:
        assert _resolve_self_assignee_name(row, db) == "홍길동"
    finally:
        db.delete(row); db.commit()


def test_resolve_self_assignee_name_falls_back_to_username_when_no_display_name():
    actor = User(username="plainuser", display_name=None)
    assert _resolve_self_assignee_name(actor, None) == "plainuser"
