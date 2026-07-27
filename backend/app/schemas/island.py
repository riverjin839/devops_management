from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

# 아일랜드 하나가 담을 수 있는 패널 수 상한 — 탭바/레일이 감당 가능한 범위.
MAX_PANELS = 20


class IslandPanel(BaseModel):
    """아일랜드 패널 1개 — 기존 라우트 경로를 가리킨다."""

    key: str = Field(..., min_length=1, max_length=64)   # 아일랜드 내 고유 id (같은 화면 중복 허용)
    path: str = Field(..., min_length=1, max_length=200)  # NAV_MAP 키 = 라우트 경로
    label: Optional[str] = Field(None, max_length=100)    # None 이면 navLabels/NAV_MAP 기본 라벨
    icon: Optional[str] = Field(None, max_length=50)      # None 이면 NAV_MAP 아이콘


class IslandCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    icon: Optional[str] = Field(None, max_length=50)
    description: Optional[str] = None
    layout_mode: str = Field(default="tabs", pattern="^(tabs|sidebar)$")
    panels: list[IslandPanel] = Field(default_factory=list, max_length=MAX_PANELS)
    is_shared: bool = False


class IslandUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    icon: Optional[str] = Field(None, max_length=50)
    description: Optional[str] = None
    layout_mode: Optional[str] = Field(None, pattern="^(tabs|sidebar)$")
    panels: Optional[list[IslandPanel]] = Field(None, max_length=MAX_PANELS)
    is_shared: Optional[bool] = None


class IslandReorder(BaseModel):
    order: list[str] = Field(default_factory=list)


class IslandResponse(BaseModel):
    id: str
    owner_id: str
    owner_name: Optional[str] = None
    name: str
    icon: Optional[str] = None
    description: Optional[str] = None
    layout_mode: str
    panels: list[IslandPanel]
    is_shared: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class IslandListResponse(BaseModel):
    data: list[IslandResponse]      # 내 아일랜드 (sort_order 순)
    shared: list[IslandResponse]    # 남이 공유한 아일랜드 (읽기 전용)
    total: int
