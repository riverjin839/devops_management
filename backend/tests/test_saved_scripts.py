"""저장 스크립트(bulk-exec 재사용) CRUD + 소유권 검사 — 실제 Postgres 사용.

핵심 검증: 목록/조회가 본인 스크립트로만 스코프되는지, 다른 사용자 스크립트에
접근하면 403 이 나는지, update 가 부분 업데이트(exclude_unset)로 동작하는지.
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi import HTTPException  # noqa: E402

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.saved_script import SavedScript  # noqa: E402
from app.routers.saved_scripts import (  # noqa: E402
    create_saved_script,
    delete_saved_script,
    get_saved_script,
    list_saved_scripts,
    update_saved_script,
)
from app.schemas.saved_script import SavedScriptCreate, SavedScriptUpdate  # noqa: E402


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


class _User:
    def __init__(self, username: str):
        self.id = str(uuid.uuid4())
        self.username = username
        self.role = "operator"


def _uname() -> str:
    return f"tester-{uuid.uuid4().hex[:10]}"


def test_create_then_list_scopes_to_owner(db):
    alice, bob = _User(_uname()), _User(_uname())
    create_saved_script(
        SavedScriptCreate(name="디스크 점검", language="bash", content="df -h"),
        db, alice,
    )
    create_saved_script(
        SavedScriptCreate(name="밥의 스크립트", language="python", content="print(1)"),
        db, bob,
    )

    alice_scripts = list_saved_scripts(language=None, db=db, user=alice)
    bob_scripts = list_saved_scripts(language=None, db=db, user=bob)

    assert [s.name for s in alice_scripts] == ["디스크 점검"]
    assert [s.name for s in bob_scripts] == ["밥의 스크립트"]


def test_list_filters_by_language(db):
    user = _User(_uname())
    create_saved_script(SavedScriptCreate(name="bash1", language="bash", content="echo 1"), db, user)
    create_saved_script(SavedScriptCreate(name="py1", language="python", content="print(1)"), db, user)

    bash_only = list_saved_scripts(language="bash", db=db, user=user)
    assert [s.name for s in bash_only] == ["bash1"]


def test_get_other_users_script_raises_403(db):
    owner, intruder = _User(_uname()), _User(_uname())
    created = create_saved_script(
        SavedScriptCreate(name="비밀 스크립트", language="bash", content="whoami"),
        db, owner,
    )

    with pytest.raises(HTTPException) as exc_info:
        get_saved_script(str(created.id), db=db, user=intruder)
    assert exc_info.value.status_code == 403


def test_get_nonexistent_script_raises_404(db):
    user = _User(_uname())
    with pytest.raises(HTTPException) as exc_info:
        get_saved_script(str(uuid.uuid4()), db=db, user=user)
    assert exc_info.value.status_code == 404


def test_update_is_partial_and_owner_scoped(db):
    owner, intruder = _User(_uname()), _User(_uname())
    created = create_saved_script(
        SavedScriptCreate(name="원래 이름", language="bash", content="echo before", description="d"),
        db, owner,
    )

    updated = update_saved_script(
        str(created.id), SavedScriptUpdate(content="echo after"), db=db, user=owner,
    )
    assert updated.name == "원래 이름"          # 안 보낸 필드는 그대로
    assert updated.content == "echo after"
    assert updated.description == "d"

    with pytest.raises(HTTPException) as exc_info:
        update_saved_script(str(created.id), SavedScriptUpdate(name="탈취"), db=db, user=intruder)
    assert exc_info.value.status_code == 403


def test_delete_removes_row_and_rejects_non_owner(db):
    owner, intruder = _User(_uname()), _User(_uname())
    created = create_saved_script(
        SavedScriptCreate(name="지울 것", language="bash", content="rm -f /tmp/x"),
        db, owner,
    )
    script_id = created.id

    with pytest.raises(HTTPException) as exc_info:
        delete_saved_script(str(script_id), db=db, user=intruder)
    assert exc_info.value.status_code == 403

    delete_saved_script(str(script_id), db=db, user=owner)
    assert db.query(SavedScript).filter(SavedScript.id == script_id).first() is None
