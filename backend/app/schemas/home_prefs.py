from typing import Literal, Optional

from pydantic import BaseModel, Field

MAX_PINNED_PATHS = 30
MAX_INSTALLED_APPS = 200
# 테마 id 는 프론트 `stores/themeStore.ts` 의 THEMES 가 원천이다 — 목록이 자주 늘어서 여기서는 모양만
# 검사하고, 모르는 값은 화면이 무시하고 자기 값으로 덮어쓴다(서버가 테마 추가를 따라 배포될 필요 없음).
THEME_PATTERN = r"^[a-z0-9-]{1,40}$"
Accent = Literal["blue", "teal", "green", "amber", "coral", "violet"]
# installed_apps 레이아웃 스키마 버전 — `main.py::_migrate_home_prefs_layout()` 가 이 값보다 낮은
# (또는 표식이 없는) 행만 이관한다. 표식이 행 자체에 있어 백업·복원과 함께 움직인다.
HOME_PREFS_LAYOUT_VERSION = 3
# 조직 기본 설치 목록(`app_settings` 의 ``home_prefs_defaults``)이 아직 없을 때 쓰는 내장 기본값 —
# 사이드바는 빈 레일, 상단바는 "업무 관리" 하나(사용자 요청: "업무 관리만 기본, 나머지는 add-on").
BUILTIN_DEFAULT_INSTALLED_APPS = ["/tasks-mgmt"]


class HomePrefs(BaseModel):
    """홈/네비게이션 개인화 설정 — `user_settings` 의 ``home_prefs`` 키에 저장되는 **원본** 모양."""

    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: list[str] = Field(default_factory=list, max_length=MAX_PINNED_PATHS)
    # R-6 i18n 2단계 — 표시 언어. 기기/브라우저를 넘어 따라오는 서버 저장 선호로 여기 얹는다
    # (localStorage 는 이 값을 즉시 적용용 캐시로만 사용, 원천은 서버).
    locale: Optional[Literal["ko", "en"]] = None
    # 바탕 테마·강조색 — 기기·브라우저를 넘어 따라온다. localStorage(`k8s:theme`/`k8s:accent`)는 첫 화면을
    # 깜빡임 없이 그리기 위한 캐시이고 원천은 여기다. None = 아직 서버에 저장한 적 없음(화면이 로컬 값을 올린다).
    theme: Optional[str] = Field(None, pattern=THEME_PATTERN)
    accent: Optional[Accent] = None
    # 사이드바/상단바 "SaaS 앱" — 사용자가 설치(opt-in)한 leaf 페이지 경로(navConfig.ts 의
    # GROUPS.paths) + "back"/"favorites"/"island", 설치 순서 = 표시 순서.
    # ``None`` = **조직 기본값을 따름**(admin 이 Settings 에서 바꾸면 즉시 반영), 리스트 = 사용자 지정.
    # 사용자가 한 번이라도 앱을 추가/제거하면 그때의 목록으로 고정되고, "기본값으로 초기화" 로
    # 다시 None 이 된다. 옛 레이아웃으로 저장된 행은 부팅 시 `_migrate_home_prefs_layout()` 가
    # 행 단위로 한 번만 변환한다.
    # ⚠ 메뉴 표시 개인화일 뿐 접근 제어가 아니다 — 설치 안 한 화면도 URL 로 열리고, 서버·프론트
    # 어느 권한 판정도 이 값을 보지 않는다. 화면 차단은 feature_access(Settings → 접근 제어)·역할·
    # 테넌트 바인딩으로 한다(DESIGN_SYSTEM.md "접근 제어가 아니다").
    installed_apps: Optional[list[str]] = Field(None, max_length=MAX_INSTALLED_APPS)
    # 서버 관리 필드 — 클라이언트가 바꿀 수 없다(HomePrefsUpdate 에 없음). 새로 저장되는 행에는
    # 최신 버전이 찍혀 이후 부팅 이관 대상에서 영구히 빠진다.
    layout_version: int = HOME_PREFS_LAYOUT_VERSION


class HomePrefsOut(HomePrefs):
    """API 응답 — ``installed_apps`` 는 조직 기본값까지 반영한 **실효** 목록이다."""

    installed_apps: list[str] = Field(default_factory=list)
    installed_apps_customized: bool = False


class HomePrefsUpdate(BaseModel):
    default_home_tab: Optional[Literal["work", "platform"]] = None
    pinned_paths: Optional[list[str]] = Field(None, max_length=MAX_PINNED_PATHS)
    locale: Optional[Literal["ko", "en"]] = None
    theme: Optional[str] = Field(None, pattern=THEME_PATTERN)
    accent: Optional[Accent] = None
    # 전체 교체(하위 호환). 여러 기기·탭이 동시에 바꾸면 나중 요청이 앞 요청을 덮으므로
    # 화면은 아래 델타 연산을 쓴다.
    installed_apps: Optional[list[str]] = Field(None, max_length=MAX_INSTALLED_APPS)
    # 원자적 델타 연산 — 서버가 행 잠금 아래에서 현재 실효 목록에 적용한다(add 는 끝에 추가,
    # 이미 있으면 무시 / remove 는 없으면 무시).
    installed_apps_add: Optional[list[str]] = Field(None, max_length=MAX_INSTALLED_APPS)
    installed_apps_remove: Optional[list[str]] = Field(None, max_length=MAX_INSTALLED_APPS)
    # True 면 사용자 지정 목록을 버리고 조직 기본값을 따르는 상태로 돌아간다.
    installed_apps_reset: Optional[bool] = None
    # 순서 변경(드래그) — 한 항목만 옮기는 원자적 연산이라 다른 기기의 추가/제거와 충돌하지 않는다.
    installed_apps_move: Optional["InstalledAppMove"] = None


class InstalledAppMove(BaseModel):
    """``id`` 를 ``before`` 앞으로 옮긴다. ``before`` 가 None(또는 목록에 없음)이면 맨 끝으로."""

    id: str
    before: Optional[str] = None


class HomePrefsDefaults(BaseModel):
    """조직 기본 설치 목록 — ``installed_apps_customized`` 가 False 인 모든 계정의 실효 목록."""

    installed_apps: list[str] = Field(default_factory=list, max_length=MAX_INSTALLED_APPS)


HomePrefsUpdate.model_rebuild()
