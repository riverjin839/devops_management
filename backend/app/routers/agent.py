"""
AI Agent router — 챗봇 (멀티턴 대화 + RAG 근거 인용 + 정보요청 루프).

All endpoints are fail-safe: if the LLM is down the frontend receives
a structured response (never a 500) so the main dashboard keeps working.
분석/조언 전용 — 응답에는 실행 가능한 필드가 없다.
"""

import logging
import uuid as _uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.agent_conversation import AgentConversation, AgentMessage
from app.models.user import User
from app.services.agent_service import agent_service
from app.services.llm.response_parser import extract_info_requests

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

# 멀티턴 히스토리 프롬프트 예산 (문자) — 초과분은 오래된 메시지부터 버린다.
_HISTORY_CHAR_BUDGET = 6000
_MAX_HISTORY_MESSAGES = 12


# ── Request / Response schemas ────────────────────────────────────────

class AgentChatRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000, description="User question")
    context: Optional[dict] = Field(default=None, description="Optional K8s context (cluster_name, pod_logs, …)")
    conversation_id: Optional[str] = Field(default=None, description="이어갈 대화 id (없으면 새 대화)")


class AgentChatResponse(BaseModel):
    status: str = Field(..., description="'ok' when LLM responded, 'offline' otherwise")
    answer: str = Field(..., description="LLM answer or fallback message")
    model: str = Field(default="", description="Model name (empty when offline)")
    conversation_id: Optional[str] = None
    citations: list[dict] = Field(default_factory=list, description="RAG 근거 인용")
    requests: list[dict] = Field(default_factory=list, description="AI 의 추가 정보 요청 (운영자가 제공)")


class AgentHealthResponse(BaseModel):
    status: str = Field(..., description="'online' or 'offline'")
    model: Optional[str] = Field(default=None, description="Configured model name")
    detail: Optional[str] = None


class AgentPullRequest(BaseModel):
    model: Optional[str] = Field(default=None, description="Model name to pull (defaults to configured model)")


class AgentPullResponse(BaseModel):
    status: str
    message: str


class AgentModelsResponse(BaseModel):
    status: str
    models: list[str] = []


class ConversationOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class MessageOut(BaseModel):
    id: str
    role: str
    content: str
    citations: list[dict] = []
    requests: list[dict] = []
    model: Optional[str] = None
    created_at: str


# ── Helpers ───────────────────────────────────────────────────────────

def _get_owned_conversation(db: Session, conversation_id: str, user: User) -> AgentConversation:
    try:
        cid = _uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="잘못된 대화 id 입니다.")
    conv = db.query(AgentConversation).filter(AgentConversation.id == cid).first()
    if conv is None:
        raise HTTPException(status_code=404, detail="대화를 찾을 수 없습니다.")
    if conv.username != user.username:
        raise HTTPException(status_code=403, detail="본인 대화만 접근할 수 있습니다.")
    return conv


def _history_block(db: Session, conv: AgentConversation) -> str:
    """최근 메시지로 멀티턴 히스토리 블록 구성 (문자 예산 내)."""
    rows = (
        db.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv.id)
        .order_by(AgentMessage.created_at.desc())
        .limit(_MAX_HISTORY_MESSAGES)
        .all()
    )
    lines: list[str] = []
    used = 0
    for m in rows:  # 최신부터 — 예산 초과 시 오래된 것 버림
        text = f"{'사용자' if m.role == 'user' else '어시스턴트'}: {m.content}"
        if used + len(text) > _HISTORY_CHAR_BUDGET:
            break
        lines.append(text)
        used += len(text)
    if not lines:
        return ""
    lines.reverse()
    return "### 이전 대화\n" + "\n".join(lines)


async def _retrieve_citations(db: Session, query: str) -> list[dict]:
    try:
        from app.services import rag_service
        return await rag_service.retrieve(db, query, k=3)
    except Exception:  # noqa: BLE001  (RAG 실패가 챗을 막지 않게)
        return []


# ── Endpoints ─────────────────────────────────────────────────────────

@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(
    body: AgentChatRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Send a question to the AI Agent (멀티턴 + RAG 인용 + 정보요청).

    Returns HTTP 200 in all cases:
    - ``status: "ok"``      → LLM answered successfully
    - ``status: "offline"`` → LLM unreachable; ``answer`` contains a friendly message
    """
    # 대화 확보 (지속성) — DB 장애 시에도 챗 자체는 동작해야 하므로 방어적으로.
    conv: Optional[AgentConversation] = None
    try:
        if body.conversation_id:
            conv = _get_owned_conversation(db, body.conversation_id, user)
        else:
            conv = AgentConversation(
                username=user.username,
                title=body.query.strip()[:40] or "새 대화",
            )
            db.add(conv)
            db.flush()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("대화 저장 불가 — 무기록 모드로 진행: %s", exc)
        conv = None

    # 프롬프트 조립: 히스토리 + 사내 참고자료(RAG) + 컨텍스트 + 질문
    parts: list[str] = []
    if conv is not None:
        try:
            history = _history_block(db, conv)
            if history:
                parts.append(history)
        except Exception:  # noqa: BLE001
            pass
    citations = await _retrieve_citations(db, body.query)
    if citations:
        from app.services.rag_service import build_reference_block
        parts.append(build_reference_block(citations))
        parts.append(
            "참고자료에 근거한 내용에는 [번호] 로 출처를 표기하고, "
            "참고자료에 없는 내용은 일반 지식임을 밝혀라."
        )
    parts.append(agent_service._build_prompt(body.query, body.context))
    prompt = "\n\n".join(parts)

    result = await agent_service._call_llm(prompt, purpose="chat")
    answer, requests = extract_info_requests(result.get("answer", ""))
    if not answer:
        answer = result.get("answer", "")

    # 메시지 저장 (best-effort)
    conversation_id: Optional[str] = None
    if conv is not None:
        try:
            db.add(AgentMessage(conversation_id=conv.id, role="user", content=body.query))
            db.add(AgentMessage(
                conversation_id=conv.id,
                role="assistant",
                content=answer,
                citations=citations or None,
                requests=requests or None,
                model=result.get("model") or None,
            ))
            from datetime import datetime as _dt
            conv.updated_at = _dt.utcnow()
            db.commit()
            conversation_id = str(conv.id)
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.warning("대화 메시지 저장 실패 — 응답은 정상 반환: %s", exc)

    return AgentChatResponse(
        status=result.get("status", "offline"),
        answer=answer,
        model=result.get("model", ""),
        conversation_id=conversation_id,
        citations=citations if result.get("status") == "ok" else [],
        requests=requests,
    )


@router.get("/health", response_model=AgentHealthResponse)
async def agent_health():
    """Quick LLM availability probe — chat 용도의 primary 프로필."""
    result = await agent_service.health_check()
    return AgentHealthResponse(**result)


@router.post("/pull-model", response_model=AgentPullResponse)
async def pull_model(body: AgentPullRequest = AgentPullRequest()):
    """Trigger model download on Ollama (runs server-side)."""
    result = await agent_service.pull_model(model=body.model)
    return AgentPullResponse(**result)


@router.get("/models", response_model=AgentModelsResponse)
async def list_models():
    """List models currently available on Ollama."""
    result = await agent_service.list_models()
    return AgentModelsResponse(**result)


# ── Conversations (대화 지속성) ────────────────────────────────────────

@router.get("/conversations")
def list_conversations(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (
        db.query(AgentConversation)
        .filter(AgentConversation.username == user.username)
        .order_by(AgentConversation.updated_at.desc())
        .limit(30)
        .all()
    )
    return {"data": [ConversationOut(
        id=str(r.id), title=r.title,
        created_at=r.created_at.isoformat(), updated_at=r.updated_at.isoformat(),
    ) for r in rows]}


@router.get("/conversations/{conversation_id}/messages")
def list_messages(
    conversation_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conv = _get_owned_conversation(db, conversation_id, user)
    rows = (
        db.query(AgentMessage)
        .filter(AgentMessage.conversation_id == conv.id)
        .order_by(AgentMessage.created_at.asc())
        .limit(200)
        .all()
    )
    return {"data": [MessageOut(
        id=str(m.id), role=m.role, content=m.content,
        citations=list(m.citations or []), requests=list(m.requests or []),
        model=m.model, created_at=m.created_at.isoformat(),
    ) for m in rows]}


@router.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conv = _get_owned_conversation(db, conversation_id, user)
    db.query(AgentMessage).filter(AgentMessage.conversation_id == conv.id).delete()
    db.delete(conv)
    db.commit()
    return {"ok": True}
