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


class UiSettingsResponse(BaseModel):
    app_title: str = "DEVOPS MANAGEMENT"
    nav_labels: dict[str, str] = Field(default_factory=dict)
    service_catalog: list[ServiceCatalogItem] | None = None


class UiSettingsUpdate(BaseModel):
    app_title: str | None = None
    nav_labels: dict[str, str] | None = None
    service_catalog: list[ServiceCatalogItem] | None = None


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
    - icon: 클러스터 카드/행에 표시될 이모지 1자. 비어있으면 운영레벨별 기본값 사용.
    """
    value: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=64)
    color: str = Field(default="slate", max_length=32)
    icon: str | None = Field(default=None, max_length=8)


class OperationLevelsResponse(BaseModel):
    levels: list[OperationLevelItem] = Field(default_factory=list)


class OperationLevelsUpdate(BaseModel):
    levels: list[OperationLevelItem]
