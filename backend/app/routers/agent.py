"""
AI Agent router — 챗봇 (멀티턴 대화 + RAG 근거 인용 + 정보요청 루프).

All endpoints are fail-safe: if the LLM is down the frontend receives
a structured response (never a 500) so the main dashboard keeps working.
분석/조언 전용 — 응답에는 실행 가능한 필드가 없다.
"""

import json
import logging
import uuid as _uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.agent_conversation import AgentConversation, AgentMessage
from app.models.user import User
from app.services.agent_service import agent_service
from app.services.llm import llm_service
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


def _resolve_conversation(db: Session, conversation_id: Optional[str], query: str, user: User) -> Optional[AgentConversation]:
    """대화 확보(지속성) — DB 장애 시에도 챗 자체는 동작해야 하므로 방어적으로."""
    try:
        if conversation_id:
            return _get_owned_conversation(db, conversation_id, user)
        conv = AgentConversation(username=user.username, title=query.strip()[:40] or "새 대화")
        db.add(conv)
        db.flush()
        return conv
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("대화 저장 불가 — 무기록 모드로 진행: %s", exc)
        return None


async def _build_chat_prompt(
    db: Session, conv: Optional[AgentConversation], query: str, context: Optional[dict],
) -> tuple[str, list[dict]]:
    """히스토리 + RAG 참고자료 + 컨텍스트 + 질문을 하나의 프롬프트로 조립.

    반환: (prompt, citations) — citations 는 그대로 응답/저장에 재사용한다.
    """
    parts: list[str] = []
    if conv is not None:
        try:
            history = _history_block(db, conv)
            if history:
                parts.append(history)
        except Exception:  # noqa: BLE001
            pass
    citations = await _retrieve_citations(db, query)
    if citations:
        from app.services.rag_service import build_reference_block
        parts.append(build_reference_block(citations))
        parts.append(
            "참고자료에 근거한 내용에는 [번호] 로 출처를 표기하고, "
            "참고자료에 없는 내용은 일반 지식임을 밝혀라."
        )
    parts.append(agent_service._build_prompt(query, context))
    return "\n\n".join(parts), citations


def _persist_turn(
    db: Session, conv: Optional[AgentConversation], query: str, answer: str,
    citations: list[dict], requests: list[dict], model: str,
) -> Optional[str]:
    """사용자 질문 + 어시스턴트 응답을 메시지로 저장 (best-effort)."""
    if conv is None:
        return None
    try:
        db.add(AgentMessage(conversation_id=conv.id, role="user", content=query))
        db.add(AgentMessage(
            conversation_id=conv.id, role="assistant", content=answer,
            citations=citations or None, requests=requests or None, model=model or None,
        ))
        from datetime import datetime as _dt
        conv.updated_at = _dt.utcnow()
        db.commit()
        return str(conv.id)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("대화 메시지 저장 실패 — 응답은 정상 반환: %s", exc)
        return None


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
    conv = _resolve_conversation(db, body.conversation_id, body.query, user)
    prompt, citations = await _build_chat_prompt(db, conv, body.query, body.context)

    result = await agent_service._call_llm(prompt, purpose="chat")
    answer, requests = extract_info_requests(result.get("answer", ""))
    if not answer:
        answer = result.get("answer", "")

    conversation_id = _persist_turn(db, conv, body.query, answer, citations, requests, result.get("model", ""))

    return AgentChatResponse(
        status=result.get("status", "offline"),
        answer=answer,
        model=result.get("model", ""),
        conversation_id=conversation_id,
        citations=citations if result.get("status") == "ok" else [],
        requests=requests,
    )


@router.post("/chat/stream")
async def agent_chat_stream(
    body: AgentChatRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """``/chat`` 의 SSE 스트리밍 버전 — 토큰 단위로 ``data: {"delta": "..."}`` 를 보내고,
    마지막에 ``data: {"done": true, ...}`` (상태/모델/대화id/인용/정보요청 포함)로 끝난다.

    대화 조회·RAG 검색은 스트림 시작 전에 미리 끝낸다 — 스트리밍 도중 DB 세션을
    오래 들고 있지 않기 위함. 메시지 저장은 전체 텍스트가 모인 뒤 스트림 끝에서
    한 번 수행한다(best-effort — 실패해도 이미 보낸 응답에는 영향 없음).
    """
    conv = _resolve_conversation(db, body.conversation_id, body.query, user)
    prompt, citations = await _build_chat_prompt(db, conv, body.query, body.context)
    conversation_id = str(conv.id) if conv is not None else None

    async def _gen():
        collected: list[str] = []
        final_status = "offline"
        final_model = ""
        final_error: Optional[str] = None
        try:
            async for chunk in llm_service.chat_stream_for_purpose("chat", prompt):
                if not chunk.done:
                    if chunk.delta:
                        collected.append(chunk.delta)
                        yield f"data: {json.dumps({'delta': chunk.delta}, ensure_ascii=False)}\n\n"
                    continue
                final_status = chunk.status
                final_model = chunk.model
                final_error = chunk.error
        except Exception as exc:  # noqa: BLE001  (게이트웨이는 원래 raise 안 하지만 방어적으로)
            logger.exception("chat stream 예외: %s", exc)
            final_status = "error"
            final_error = str(exc)[:200]

        raw_answer = "".join(collected)
        answer, requests = extract_info_requests(raw_answer)
        if not answer:
            answer = raw_answer

        if final_status != "ok" and not answer:
            answer = (
                "AI 어시스턴트에 연결할 수 없습니다. Settings → AI/LLM 에서 LLM 연결 상태를 확인하세요."
                if final_status == "offline" else
                "AI 어시스턴트에 일시적인 오류가 발생했습니다."
            )
            yield f"data: {json.dumps({'delta': answer}, ensure_ascii=False)}\n\n"

        saved_id = _persist_turn(db, conv, body.query, answer, citations, requests, final_model)
        # 이 SSE 바디는 axios 인터셉터를 거치지 않는(수동 fetch+reader 소비) 원문 JSON 이라
        # snake_case 그대로 보낸다 — /agent/chat 의 camelCase 응답과는 별개 규약.
        done_payload = {
            "done": True, "status": final_status, "model": final_model,
            "conversation_id": saved_id or conversation_id,
            "citations": citations if final_status == "ok" else [],
            "requests": requests, "error": final_error,
        }
        yield f"data: {json.dumps(done_payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            # GZipMiddleware 는 이 헤더가 있으면 압축을 건너뛴다 — SSE 를 gzip 하면
            # zlib 내부 버퍼링 때문에 X-Accel-Buffering:no 의 실시간성이 깨진다.
            "Content-Encoding": "identity",
        },
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
