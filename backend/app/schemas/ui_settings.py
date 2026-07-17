from pydantic import BaseModel, Field


class ServiceCatalogItem(BaseModel):
    """통합지식 메뉴와 task/issue 의 service tag 가 사용하는 서비스 카탈로그 한 항목.

    - slug: URL 경로(``/services/<slug>``) 와 service_entries.service 매칭 키 (영문 권장).
    - label: 사이드바·태그 드롭다운에 표시될 라벨 (한글 가능).
    - icon: lucide-react 아이콘 이름 (Server / Lock / Box …) / 이모지 1자 /
            업로드된 이미지의 base64 data URL ("data:image/...;base64,..."). 비어있으면 BookOpen.
    - color: 카드/뱃지 색상 토큰 (sky/amber/blue/...) — 비어있으면 slate.
    """
    slug: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=64)
    # max_length 제한 제거 — base64 data URL (수 KB) 저장 가능하도록.
    icon: str | None = Field(default=None)
    color: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=255)
    sort_order: int = 0


class HomeIcons(BaseModel):
    """홈(좌상단) 버튼 아이콘 커스터마이즈. 모드별로 지정.

    값 형식은 ServiceCatalogItem.icon 과 동일: lucide-react 아이콘 이름 /
    이모지 1자 / 업로드 이미지의 base64 data URL. None 이면 프론트엔드 기본값
    (업무=ListTodo, 플랫폼=☸) 을 사용한다.
    """
    work: str | None = None
    platform: str | None = None


class PageStyle(BaseModel):
    """페이지(라우트)별 화면 스타일 오버라이드. 모든 필드 optional —
    설정된 것만 적용되고 나머지는 전체 기본(__default__) → 테마 순으로 폴백.

    - font_family: CSS font-family 값 (예: 'Georgia, serif'). 빈/None = 미지정.
    - font_scale: 본문 영역 확대 배율 (0.8 ~ 1.5). 1 또는 None = 미지정.
    - text_color / bg_color: hex (#RRGGBB). None = 미지정.
    키 '__default__' 는 전 페이지 공통 기본값, 그 외는 라우트 경로('/path').
    """
    font_family: str | None = Field(default=None, max_length=255)
    font_scale: float | None = Field(default=None, ge=0.5, le=2.0)
    text_color: str | None = Field(default=None, max_length=32)
    bg_color: str | None = Field(default=None, max_length=32)


class UiSettingsResponse(BaseModel):
    app_title: str = "DEVOPS MANAGEMENT"
    nav_labels: dict[str, str] = Field(default_factory=dict)
    service_catalog: list[ServiceCatalogItem] | None = None
    home_icons: HomeIcons | None = None
    page_styles: dict[str, PageStyle] | None = None


class UiSettingsUpdate(BaseModel):
    app_title: str | None = None
    nav_labels: dict[str, str] | None = None
    service_catalog: list[ServiceCatalogItem] | None = None
    home_icons: HomeIcons | None = None
    page_styles: dict[str, PageStyle] | None = None


class ClusterLinkItem(BaseModel):
    id: str
    label: str
    url: str
    description: str | None = None


class ClusterLinkGroup(BaseModel):
    cluster_id: str
    cluster_name: str
    links: list[ClusterLinkItem] = Field(default_factory=list)


class ClusterLinksPayload(BaseModel):
    common_links: list[ClusterLinkItem] = Field(default_factory=list)
    cluster_groups: list[ClusterLinkGroup] = Field(default_factory=list)


class ClusterLinksResponse(BaseModel):
    data: ClusterLinksPayload


class ClusterLinksUpdate(BaseModel):
    common_links: list[ClusterLinkItem] = Field(default_factory=list)
    cluster_groups: list[ClusterLinkGroup] = Field(default_factory=list)


# ── 운영레벨 (사용자 정의) ──────────────────────────────────────────────
class OperationLevelItem(BaseModel):
    """운영레벨 한 항목.
    - value: 클러스터.operation_level 에 저장되는 식별자 (영문 슬러그 권장).
    - label: 화면 표시 이름 (한글 가능).
    - color: 컬러 키 (red/amber/emerald/sky/slate/purple/blue/yellow/pink/cyan/violet/orange/muted).
      custom_hex 가 지정되면 프리셋 대신 fallback 으로만 쓰인다.
    - icon: 클러스터 카드/행에 표시될 이모지 1자. 비어있으면 운영레벨별 기본값 사용.
    - custom_hex: 프리셋 13색 대신 임의의 hex(#RRGGBB) 를 시드로 bg/ring/band/text 톤을
      자동 산출할 때 지정. 비어있으면 color 프리셋을 그대로 사용.
    """
    value: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=64)
    color: str = Field(default="slate", max_length=32)
    icon: str | None = Field(default=None, max_length=8)
    custom_hex: str | None = Field(default=None, max_length=9, pattern=r"^#[0-9a-fA-F]{3,8}$")


class OperationLevelsResponse(BaseModel):
    levels: list[OperationLevelItem] = Field(default_factory=list)


class OperationLevelsUpdate(BaseModel):
    levels: list[OperationLevelItem]
