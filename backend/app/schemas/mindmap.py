from pydantic import BaseModel, Field, StringConstraints, model_validator
from datetime import datetime
from uuid import UUID
from typing import Annotated, Optional, Any


# 맵 제목 — 앞뒤 공백을 걷어낸 뒤 1자 이상(빈 제목 저장 차단). 200 = DB 컬럼 길이.
MindMapTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


def _reject_explicit_null(model: BaseModel, fields: tuple[str, ...]) -> None:
    """수정 요청에서 ``null`` 은 "값 지우기"다. 지울 수 없는(DB NOT NULL) 필드에 ``null`` 이 오면 422."""
    for name in fields:
        if name in model.model_fields_set and getattr(model, name) is None:
            raise ValueError(f"{name} 은(는) 비울 수 없습니다")


class MindMapNodeBase(BaseModel):
    label: str
    note: Optional[str] = None
    color: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    collapsed: bool = False
    sort_order: float = 0.0
    extra: Optional[dict[str, Any]] = None


class MindMapNodeCreate(MindMapNodeBase):
    mindmap_id: UUID
    parent_id: Optional[UUID] = None


# 노드 수정에서 null 로 지울 수 없는 필드(DB NOT NULL 이거나 의미상 필수).
NODE_NON_NULLABLE_FIELDS = ("label", "collapsed", "sort_order")


class MindMapNodeUpdate(BaseModel):
    """부분 수정 — 보낸 필드만 반영한다(``model_fields_set``).

    명시적 ``null`` 은 값 지우기: ``note``(메모)·``color``(기본 색)·``x``/``y``·``extra``·
    ``parent_id``(루트로 승격). ``label``·``collapsed``·``sort_order`` 에 ``null`` 은 422.
    """
    label: Optional[str] = None
    note: Optional[str] = None
    color: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    collapsed: Optional[bool] = None
    sort_order: Optional[float] = None
    parent_id: Optional[UUID] = None
    extra: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def _non_nullable(self):
        _reject_explicit_null(self, NODE_NON_NULLABLE_FIELDS)
        return self


class MindMapNodeResponse(MindMapNodeBase):
    id: UUID
    mindmap_id: UUID
    parent_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class MindMapBase(BaseModel):
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    title: str
    description: Optional[str] = None
    confluence_url: Optional[str] = Field(default=None, max_length=2048)


class MindMapCreate(MindMapBase):
    title: MindMapTitle


class MindMapUpdate(BaseModel):
    """부분 수정 — 보낸 필드만 반영한다(``model_fields_set``).

    명시적 ``null`` 은 값 지우기: ``description``·``confluence_url``(빈 문자열도 지우기)·
    ``tenant_id``(전체 공유로). ``title`` 은 지울 수 없다(``null``·공백만 → 422).
    """
    # 멀티테넌시 3단계 — None = 전체 공유, 값이 있으면 그 테넌트 멤버·admin 만 본다.
    tenant_id: Optional[UUID] = None
    title: Optional[MindMapTitle] = None
    description: Optional[str] = None
    confluence_url: Optional[str] = Field(default=None, max_length=2048)

    @model_validator(mode="after")
    def _non_nullable(self):
        _reject_explicit_null(self, ("title",))
        return self


class MindMapResponse(MindMapBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    nodes: list[MindMapNodeResponse] = []

    class Config:
        from_attributes = True


class MindMapListItem(MindMapBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    node_count: int = 0

    class Config:
        from_attributes = True


# Bulk node update for saving canvas state
class BulkNodeUpdate(BaseModel):
    nodes: list[MindMapNodeUpdate]
    ids: list[UUID]
