import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.database import Base


class UserSetting(Base):
    """Per-user personal preferences stored as opaque JSON keyed by a short
    setting name (e.g. ``mc_presets``, ``terminal_appearance``).

    Distinct from :class:`AppSetting` (org-wide settings): rows here are scoped
    to a single ``user_id`` so each operator keeps their own customizations.
    Admin-deployed/shared defaults live in ``app_settings`` and are merged on
    top of the built-in defaults at read time.
    """

    __tablename__ = "user_settings"
    __table_args__ = (
        UniqueConstraint("user_id", "key", name="uq_user_settings_user_key"),
    )

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), nullable=False, index=True)
    key = Column(String(64), nullable=False)
    value = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
