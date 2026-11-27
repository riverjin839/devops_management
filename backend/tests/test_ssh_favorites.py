"""SSH 터미널 즐겨찾기 — 시드·CRUD·소유권·숨김·순서·기본값 복원 (실제 Postgres)."""
import os
import uuid

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.ssh_favorite import SshFavoriteCommand  # noqa: E402
from app.routers.ssh_favorites import (  # noqa: E402
    create_ssh_favorite, delete_ssh_favorite, list_ssh_favorites, reorder_ssh_favorites,
    reset_ssh_favorites, update_ssh_favorite,
)
from app.schemas.ssh_favorite import SshFavoriteCreate, SshFavoriteReorder, SshFavoriteUpdate  # noqa: E402
from app.services.ssh_favorites import PRESETS  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


class _User:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.username = f"sshfav-{uuid.uuid4().hex[:10]}"
        self.role = "operator"


@pytest.fixture
def user(db):
    u = _User()
    yield u
    db.query(SshFavoriteCommand).filter(SshFavoriteCommand.username == u.username).delete()
    db.commit()


def test_first_list_seeds_presets_in_order(db, user):
    rows = list_ssh_favorites(db=db, user=user)
    assert [r["preset_key"] for r in rows] == [p.key for p in PRESETS]
    assert all(r["run_mode"] == "run" and not r["modified"] for r in rows)
    # 두 번째 조회는 다시 시드하지 않는다
    assert len(list_ssh_favorites(db=db, user=user)) == len(PRESETS)


def test_create_update_marks_modified_and_scopes_owner(db, user):
    rows = list_ssh_favorites(db=db, user=user)
    created = create_ssh_favorite(SshFavoriteCreate(name="kubelet 로그", command="journalctl -u kubelet -f"), db=db, user=user)
    assert created["run_mode"] == "insert" and created["preset_key"] is None
    assert created["sort_order"] == len(rows)

    upd = update_ssh_favorite(str(rows[0]["id"]), SshFavoriteUpdate(command="uname -a"), db=db, user=user)
    assert upd["modified"] is True and upd["name"] == rows[0]["name"]

    other = _User()
    with pytest.raises(HTTPException) as e:
        update_ssh_favorite(str(created["id"]), SshFavoriteUpdate(name="x"), db=db, user=other)
    assert e.value.status_code == 403
    with pytest.raises(ValidationError):
        SshFavoriteUpdate(command=None)


def test_delete_hides_preset_and_removes_custom_then_reset(db, user):
    rows = list_ssh_favorites(db=db, user=user)
    custom = create_ssh_favorite(SshFavoriteCreate(name="mine", command="df -h"), db=db, user=user)
    delete_ssh_favorite(str(rows[0]["id"]), db=db, user=user)
    delete_ssh_favorite(str(custom["id"]), db=db, user=user)
    after = list_ssh_favorites(db=db, user=user)
    assert len(after) == len(PRESETS) - 1  # 숨긴 기본 명령은 다시 시드되지 않는다
    assert db.query(SshFavoriteCommand).filter(SshFavoriteCommand.id == custom["id"]).first() is None

    keep = create_ssh_favorite(SshFavoriteCreate(name="keep", command="uptime"), db=db, user=user)
    update_ssh_favorite(str(after[0]["id"]), SshFavoriteUpdate(name="바뀐 이름"), db=db, user=user)
    restored = reset_ssh_favorites(db=db, user=user)
    assert [r["preset_key"] for r in restored[: len(PRESETS)]] == [p.key for p in PRESETS]
    assert not any(r["modified"] for r in restored)
    assert restored[-1]["id"] == keep["id"]


def test_reorder_requires_full_current_list(db, user):
    rows = list_ssh_favorites(db=db, user=user)
    ids = [r["id"] for r in rows]
    out = reorder_ssh_favorites(SshFavoriteReorder(ids=list(reversed(ids))), db=db, user=user)
    assert [r["id"] for r in out] == list(reversed(ids))
    with pytest.raises(HTTPException) as e:
        reorder_ssh_favorites(SshFavoriteReorder(ids=ids[:-1]), db=db, user=user)
    assert e.value.status_code == 409
