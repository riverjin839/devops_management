from typing import Literal, Optional

from pydantic import BaseModel, Field

MAX_PINNED_PATHS = 30


class HomePrefs(BaseModel):
    """홈/네비게이션 개인화 설정 — `user_settings` 의 ``home_prefs`` 키에 저장된다."""

    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: list[str] = Field(default_factory=list, max_length=MAX_PINNED_PATHS)


class HomePrefsUpdate(BaseModel):
    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: Optional[list[str]] = Field(None, max_length=MAX_PINNED_PATHS)
