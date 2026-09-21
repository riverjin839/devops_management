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
    # 사이드바/상단바 "SaaS 앱" 개편 — 사용자가 설치(opt-in)한 leaf 페이지 경로(navConfig.ts
    # 의 GROUPS.paths) + "back"/"favorites"/"island". 사이드바(platform/system 도메인)는
    # 완전히 빈 리스트가 기본값이라 신규 계정은 빈 레일로 시작한다. 상단바(work 도메인)만
    # 예외로 `/tasks-mgmt`("업무 관리") 하나를 기본 설치 상태로 시작한다 — 사용자 요청
    # ("업무 관리만 기본으로 나오게, 나머지는 개인별 add-on") — 나머지 업무 관리 leaf·문서
    # 관리 leaf·즐겨찾기·Your Island 는 전부 `+` 로 개인이 추가해야 보인다. 이 필드가 생기기
    # 전 기존 계정은 `_backfill_installed_sidebar_apps()`(1단계, 그룹 단위) →
    # `_migrate_installed_apps_to_leaf_paths()`(2단계, leaf 치환) →
    # `_prune_topbar_apps_to_default()`(3단계, 상단바를 `/tasks-mgmt` 하나로 정리)를 거친다.
    installed_apps: list[str] = Field(default_factory=lambda: ["/tasks-mgmt"])


class HomePrefsUpdate(BaseModel):
    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: Optional[list[str]] = Field(None, max_length=MAX_PINNED_PATHS)
    locale: Optional[Literal["ko", "en"]] = None
    installed_apps: Optional[list[str]] = None
