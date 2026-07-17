import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, UniqueConstraint, Index, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base

# 공감(리액션) 대상 타입 — 작성자(담당자)가 남긴 "글" 성격의 surface 들.
REACTION_TARGET_TYPES = ("ops_note", "work_item_comment", "work_guide", "work_item", "voc_post")

# 허용 이모지 (Slack/GitHub 스타일 고정 팔레트). 프런트(ReactionBar)와 동일하게 유지.
REACTION_EMOJIS = ("👍", "❤️", "🎉", "✅", "👀", "🙏", "🔥", "😄")


class Reaction(Base):
    """범용 이모지 공감(리액션) — 여러 surface(ops_note / work_item_comment / work_guide)에서
    재사용한다. (target_type, target_id, emoji, username) 조합당 1건(중복 방지 → 토글).

    target_id 는 대상 PK 를 문자열로 보관(uuid/str 혼재 대응)."""

    __tablename__ = "reactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    target_type = Column(String(40), nullable=False, index=True)
    target_id = Column(String(64), nullable=False, index=True)
    emoji = Column(String(16), nullable=False)
    username = Column(String(100), nullable=False)        # 누른 사람(계정)
    user_display = Column(String(100), nullable=True)     # 표시 이름(툴팁용)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("target_type", "target_id", "emoji", "username", name="uq_reaction_once"),
        Index("ix_reactions_target", "target_type", "target_id"),
    )

    def __repr__(self):
        return f"<Reaction({self.target_type}:{self.target_id} {self.emoji} by {self.username})>"
