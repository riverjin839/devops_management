from typing import Literal, Optional

from pydantic import BaseModel, Field

MAX_PINNED_PATHS = 30
# installed_apps 레이아웃 스키마 버전 — `main.py::_migrate_home_prefs_layout()` 가 이 값보다 낮은
# (또는 표식이 없는) 행만 이관한다. 표식이 행 자체에 있어 백업·복원과 함께 움직인다.
HOME_PREFS_LAYOUT_VERSION = 3


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
    # 관리 leaf·즐겨찾기·Your Island 는 전부 `+` 로 개인이 추가해야 보인다. 옛 레이아웃으로
    # 저장된 행은 부팅 시 `_migrate_home_prefs_layout()` 가 행 단위로 한 번만 변환한다.
    installed_apps: list[str] = Field(default_factory=lambda: ["/tasks-mgmt"])
    # 서버 관리 필드 — 클라이언트가 바꿀 수 없다(HomePrefsUpdate 에 없음). PUT 으로 저장되는
    # 순간 최신 버전이 찍혀 이후 부팅 이관 대상에서 영구히 빠진다.
    layout_version: int = HOME_PREFS_LAYOUT_VERSION


class HomePrefsUpdate(BaseModel):
    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: Optional[list[str]] = Field(None, max_length=MAX_PINNED_PATHS)
    locale: Optional[Literal["ko", "en"]] = None
    installed_apps: Optional[list[str]] = None
