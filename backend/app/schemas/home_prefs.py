from typing import Literal, Optional

from pydantic import BaseModel, Field

MAX_PINNED_PATHS = 30


class HomePrefs(BaseModel):
    """홈/네비게이션 개인화 설정 — `user_settings` 의 ``home_prefs`` 키에 저장된다."""

    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: list[str] = Field(default_factory=list, max_length=MAX_PINNED_PATHS)
    # R-6 i18n 2단계 — 표시 언어. 기기/브라우저를 넘어 따라오는 서버 저장 선호로 여기 얹는다
    # (localStorage 는 이 값을 즉시 적용용 캐시로만 사용, 원천은 서버).
    locale: Optional[Literal["ko", "en"]] = None
    # 사이드바 "SaaS 앱" 개편 — 사용자가 설치(opt-in)한 플랫폼 그룹 id(navConfig.ts 의
    # GroupId) + "back". 빈 리스트가 기본값이라 신규 계정은 빈 사이드바로 시작하고,
    # 이 필드가 생기기 전 기존 계정은 `_backfill_installed_sidebar_apps()` 가 1회 이관한다.
    installed_apps: list[str] = Field(default_factory=list)


class HomePrefsUpdate(BaseModel):
    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: Optional[list[str]] = Field(None, max_length=MAX_PINNED_PATHS)
    locale: Optional[Literal["ko", "en"]] = None
    installed_apps: Optional[list[str]] = None
