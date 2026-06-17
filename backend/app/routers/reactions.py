"""범용 이모지 공감(리액션) API — ops_note / work_item_comment / work_guide 공통.

(target_type, target_id, emoji, username) 조합당 1건. 같은 이모지를 다시 누르면 토글로 해제.
응답은 snake_case(프런트 인터셉터가 camelCase 로 자동 변환)."""
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.auth.deps import get_current_user
from app.models.user import User
from app.models.reaction import Reaction, REACTION_TARGET_TYPES, REACTION_EMOJIS

router = APIRouter(prefix="/reactions", tags=["reactions"])


# ── schemas ──────────────────────────────────────────────────────────────────
class ReactionToggleRequest(BaseModel):
    target_type: str
    target_id: str
    emoji: str

    @field_validator("target_type")
    @classmethod
    def _valid_type(cls, v: str) -> str:
        if v not in REACTION_TARGET_TYPES:
            raise ValueError(f"target_type must be one of {REACTION_TARGET_TYPES}")
        return v

    @field_validator("emoji")
    @classmethod
    def _valid_emoji(cls, v: str) -> str:
        if v not in REACTION_EMOJIS:
            raise ValueError("지원하지 않는 이모지입니다.")
        return v


class ReactionGroup(BaseModel):
    emoji: str
    count: int
    reacted: bool          # 현재 사용자가 눌렀는지
    users: list[str]       # 누른 사람 표시이름(툴팁용)


class ReactionSummary(BaseModel):
    target_type: str
    target_id: str
    total: int
    groups: list[ReactionGroup]


# ── helpers ──────────────────────────────────────────────────────────────────
def _summarize(rows: list[Reaction], me: str, target_type: str, target_id: str) -> ReactionSummary:
    """이모지별 그룹핑 — REACTION_EMOJIS 정의 순서를 보존."""
    by_emoji: "OrderedDict[str, list[Reaction]]" = OrderedDict((e, []) for e in REACTION_EMOJIS)
    for r in rows:
        by_emoji.setdefault(r.emoji, []).append(r)
    groups: list[ReactionGroup] = []
    for emoji, rs in by_emoji.items():
        if not rs:
            continue
        groups.append(ReactionGroup(
            emoji=emoji,
            count=len(rs),
            reacted=any(r.username == me for r in rs),
            users=[(r.user_display or r.username) for r in rs],
        ))
    return ReactionSummary(
        target_type=target_type,
        target_id=target_id,
        total=len(rows),
        groups=groups,
    )


# ── endpoints ────────────────────────────────────────────────────────────────
@router.get("", response_model=ReactionSummary)
def get_reactions(
    target_type: str = Query(...),
    target_id: str = Query(...),
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    if target_type not in REACTION_TARGET_TYPES:
        raise HTTPException(status_code=400, detail="invalid target_type")
    rows = (
        db.query(Reaction)
        .filter(Reaction.target_type == target_type, Reaction.target_id == target_id)
        .all()
    )
    return _summarize(rows, me.username, target_type, target_id)


@router.get("/batch")
def get_reactions_batch(
    target_type: str = Query(...),
    target_ids: str = Query("", description="쉼표로 구분한 대상 id 목록"),
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    """목록 화면용 — 여러 대상의 요약을 한 번에. {target_id: ReactionSummary} 형태."""
    if target_type not in REACTION_TARGET_TYPES:
        raise HTTPException(status_code=400, detail="invalid target_type")
    ids = [s.strip() for s in target_ids.split(",") if s.strip()]
    if not ids:
        return {}
    rows = (
        db.query(Reaction)
        .filter(Reaction.target_type == target_type, Reaction.target_id.in_(ids))
        .all()
    )
    grouped: dict[str, list[Reaction]] = {tid: [] for tid in ids}
    for r in rows:
        grouped.setdefault(r.target_id, []).append(r)
    return {
        tid: _summarize(rs, me.username, target_type, tid).model_dump()
        for tid, rs in grouped.items()
    }


@router.post("/toggle", response_model=ReactionSummary)
def toggle_reaction(
    payload: ReactionToggleRequest,
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    existing = (
        db.query(Reaction)
        .filter(
            Reaction.target_type == payload.target_type,
            Reaction.target_id == payload.target_id,
            Reaction.emoji == payload.emoji,
            Reaction.username == me.username,
        )
        .first()
    )
    if existing:
        db.delete(existing)
    else:
        db.add(Reaction(
            target_type=payload.target_type,
            target_id=payload.target_id,
            emoji=payload.emoji,
            username=me.username,
            user_display=me.display_name,
        ))
    db.commit()

    rows = (
        db.query(Reaction)
        .filter(
            Reaction.target_type == payload.target_type,
            Reaction.target_id == payload.target_id,
        )
        .all()
    )
    return _summarize(rows, me.username, payload.target_type, payload.target_id)
