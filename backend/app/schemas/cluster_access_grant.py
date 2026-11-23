"""사용자별 클러스터 권한(직접 지정) — Settings ▸ 클러스터 권한 탭 스키마."""
from __future__ import annotations

from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

GrantLevel = Literal["none", "read", "operate"]


class ClusterAccessRow(BaseModel):
    cluster_id: UUID
    cluster_name: str
    # 직접 지정 값 — None 이면 지정 없음(테넌트·기본 규칙에 따름)
    grant: Optional[GrantLevel] = None
    # 실제 적용 — 'operate' | 'read' | None(숨김). 전역 역할 제한 전 값.
    effective: Optional[Literal["read", "operate"]] = None
    # 'admin' | 'grant' | 'tenant:<이름>' | 'restricted' | 'open'
    source: str
    # 전역 역할이 viewer 라 operate 범위여도 실행할 수 없음
    role_limited: bool = False


class UserClusterAccessOut(BaseModel):
    user_id: str
    username: Optional[str] = None
    display_name: Optional[str] = None
    role: str
    clusters: list[ClusterAccessRow]


class GrantSummaryItem(BaseModel):
    user_id: str
    grants: int


class GrantChange(BaseModel):
    user_id: str = Field(min_length=1, max_length=36)
    cluster_id: UUID
    # None = 지정 해제
    access: Optional[GrantLevel] = None


class GrantBulkIn(BaseModel):
    changes: list[GrantChange] = Field(default_factory=list, max_length=2000)


class GrantBulkOut(BaseModel):
    created: int
    updated: int
    removed: int
