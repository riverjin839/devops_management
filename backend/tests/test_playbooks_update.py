"""플레이북 수정(PUT /playbooks/{id}) — 지운 값 저장(D-144).

수정 폼이 설명·태그를 지우면 null 을 보내고, 서버는 그 컬럼을 비워야 한다. 안 보낸 필드는 유지.
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
from app.models import Cluster, Playbook  # noqa: E402
from app.routers import playbooks as playbooks_router  # noqa: E402
from app.schemas.playbook import PlaybookUpdate  # noqa: E402


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


@pytest.fixture
def playbook(db):
    cluster = Cluster(name=f"pb-{uuid.uuid4().hex[:8]}", api_endpoint="https://10.0.0.1:6443")
    db.add(cluster)
    db.commit()
    pb = Playbook(
        cluster_id=cluster.id, name="점검", description="옛 설명", tags="etcd,node",
        playbook_path="/tmp/site.yml",
    )
    db.add(pb)
    db.commit()
    yield pb
    db.delete(pb)
    db.delete(cluster)
    db.commit()


def test_update_with_null_clears_description_and_tags(db, playbook):
    res = playbooks_router.update_playbook(
        playbook.id, PlaybookUpdate(description=None, tags=None), db=db, _=None,
    )
    assert res["description"] is None
    assert res["tags"] is None
    assert res["name"] == "점검"  # 안 보낸 필드는 그대로
    assert res["playbook_path"] == "/tmp/site.yml"


def test_update_with_blank_string_also_clears(db, playbook):
    res = playbooks_router.update_playbook(
        playbook.id, PlaybookUpdate(description="  ", tags=""), db=db, _=None,
    )
    assert res["description"] is None
    assert res["tags"] is None


def test_update_rejects_null_name(db, playbook):
    with pytest.raises(HTTPException) as exc_info:
        playbooks_router.update_playbook(playbook.id, PlaybookUpdate(name=None), db=db, _=None)
    assert exc_info.value.status_code == 422
