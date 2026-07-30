"""AI 챗봇 대화 지속성 테스트 — 실제 Postgres.

대화 CRUD·소유권(타인 대화 403)·히스토리 예산을 검증한다.
"""
import os
import uuid
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.agent_conversation import AgentConversation, AgentMessage  # noqa: E402
from app.routers.agent import (  # noqa: E402
    _get_owned_conversation,
    _history_block,
    delete_conversation,
    list_conversations,
    list_messages,
)


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    # work_guides.embedding 은 pgvector 확장 필요 — 이 파일이 알파벳순으로 가장 먼저
    # 수집돼 최초로 create_all() 을 부르므로, 확장을 먼저 보장해야 한다
    # (test_architecture_docs.py 등 형제 테스트와 동일 순서 보장).
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _make_conv(db, username="alice", title="테스트 대화"):
    conv = AgentConversation(username=username, title=title)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def test_ownership_enforced(db):
    conv = _make_conv(db, username="alice")
    assert _get_owned_conversation(db, str(conv.id), NS(username="alice")).id == conv.id
    with pytest.raises(HTTPException) as exc:
        _get_owned_conversation(db, str(conv.id), NS(username="bob"))
    assert exc.value.status_code == 403


def test_missing_and_bad_ids(db):
    with pytest.raises(HTTPException) as exc:
        _get_owned_conversation(db, str(uuid.uuid4()), NS(username="alice"))
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        _get_owned_conversation(db, "not-a-uuid", NS(username="alice"))
    assert exc.value.status_code == 400


def test_list_and_messages_roundtrip(db):
    user = NS(username=f"user-{uuid.uuid4().hex[:6]}")
    conv = _make_conv(db, username=user.username)
    db.add(AgentMessage(conversation_id=conv.id, role="user", content="질문입니다"))
    db.add(AgentMessage(
        conversation_id=conv.id, role="assistant", content="답변입니다",
        citations=[{"title": "가이드", "source_type": "work_guide"}],
        requests=[{"kind": "logs", "detail": "로그 필요"}],
        model="test-model",
    ))
    db.commit()

    convs = list_conversations(db=db, user=user)["data"]
    assert [c.title for c in convs] == ["테스트 대화"]

    msgs = list_messages(str(conv.id), db=db, user=user)["data"]
    assert [m.role for m in msgs] == ["user", "assistant"]
    assert msgs[1].citations[0]["title"] == "가이드"
    assert msgs[1].requests[0]["kind"] == "logs"


def test_history_block_respects_budget(db):
    user = NS(username=f"user-{uuid.uuid4().hex[:6]}")
    conv = _make_conv(db, username=user.username)
    # 각 3000자 메시지 4개 — 예산 6000자면 최신 2개 언저리만 남아야 한다
    for i in range(4):
        db.add(AgentMessage(conversation_id=conv.id, role="user", content=f"m{i}-" + "x" * 3000))
    db.commit()

    block = _history_block(db, conv)
    assert block.startswith("### 이전 대화")
    assert len(block) < 7000
    assert "m3-" in block           # 최신 메시지는 포함
    assert "m0-" not in block       # 가장 오래된 것은 잘림


def test_delete_conversation_removes_messages(db):
    user = NS(username=f"user-{uuid.uuid4().hex[:6]}")
    conv = _make_conv(db, username=user.username)
    db.add(AgentMessage(conversation_id=conv.id, role="user", content="hi"))
    db.commit()

    assert delete_conversation(str(conv.id), db=db, user=user) == {"ok": True}
    assert db.query(AgentConversation).filter(AgentConversation.id == conv.id).first() is None
    assert db.query(AgentMessage).filter(AgentMessage.conversation_id == conv.id).count() == 0
