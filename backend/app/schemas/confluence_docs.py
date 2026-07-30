"""Confluence 문서 가져오기/내보내기 (routers/confluence.py) Pydantic 스키마."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ── 검색 ────────────────────────────────────────────────────────────────────
class ConfluenceDocSearchRequest(BaseModel):
    """CQL 직접 입력 또는 간편 검색(space_key + text) — cql 이 있으면 우선."""
    cql: Optional[str] = None
    space_key: Optional[str] = Field(None, max_length=50)
    text: Optional[str] = Field(None, max_length=200)
    limit: int = Field(25, ge=1, le=100)


class ConfluenceDocSearchItem(BaseModel):
    id: str
    title: str
    space_key: str = ""
    url: str = ""
    updated: str = ""
    linked: bool = False          # 이미 work_guides 에 연결된 페이지인지
    linked_guide_id: Optional[UUID] = None


class ConfluenceDocSearchResult(BaseModel):
    status: str
    detail: str = ""
    total: int = 0
    items: List[ConfluenceDocSearchItem] = []


# ── 가져오기 (dry-run 프리뷰 → only_page_ids 커밋 — Jira import 패턴) ───────
class ConfluenceDocImportRequest(BaseModel):
    page_ids: List[str] = Field(default_factory=list, max_length=50)
    dry_run: bool = True
    only_page_ids: Optional[List[str]] = None   # 커밋 시 선택된 페이지만
    parent_guide_id: Optional[UUID] = None      # 가져올 위치 (상위 문서)
    category: Optional[str] = None              # 미지정 시 설정의 default_category
    guide_status: str = "active"
    inline_images: bool = False                 # 첨부 이미지를 base64 로 인라인 (기본: 원본 링크)


class ConfluenceDocFieldChange(BaseModel):
    field: str
    old: Optional[str] = None
    new: Optional[str] = None


class ConfluenceDocImportPreview(BaseModel):
    page_id: str
    title: str
    space_key: str = ""
    version: Optional[int] = None
    action: str                                  # create / update / unchanged / error
    detail: str = ""
    warnings: List[str] = []
    changes: List[ConfluenceDocFieldChange] = []


class ConfluenceDocImportResult(BaseModel):
    status: str
    detail: str = ""
    dry_run: bool = True
    imported: int = 0
    updated: int = 0
    skipped: int = 0
    errors: List[str] = []
    warnings: List[str] = []
    items: List[ConfluenceDocImportPreview] = []


# ── 내보내기 ────────────────────────────────────────────────────────────────
class ConfluenceDocExportRequest(BaseModel):
    space_key: Optional[str] = Field(None, max_length=50)   # 미지정 시 설정값
    parent_page_id: Optional[str] = Field(None, max_length=50)
    title: Optional[str] = Field(None, max_length=255)      # 미지정 시 문서 제목


class ConfluenceDocExportResult(BaseModel):
    status: str
    detail: str = ""
    action: str = ""                 # created / updated
    page_id: Optional[str] = None
    page_url: Optional[str] = None
    version: Optional[int] = None
    warnings: List[str] = []


class ConfluenceDocPullResult(BaseModel):
    status: str
    detail: str = ""
    guide_id: Optional[UUID] = None
    version: Optional[int] = None
    warnings: List[str] = []


# ── 설정 (AppSetting key=confluence_documents) ──────────────────────────────
class ConfluenceDocsSettings(BaseModel):
    space_key: str = ""
    parent_page_id: str = ""
    default_category: str = "기타"
    title_prefix: str = ""


# ── 시맨틱 검색 (GET /work-guides/search) ───────────────────────────────────
class GuideSearchItem(BaseModel):
    id: UUID
    title: str
    category: Optional[str] = None
    status: str
    author: Optional[str] = None
    source: str = "pep"
    confluence_url: Optional[str] = None
    updated_at: datetime
    similarity: Optional[float] = None     # 시맨틱 검색일 때만
    snippet: str = ""


class GuideSearchResult(BaseModel):
    items: List[GuideSearchItem] = []
    embedding_available: bool = False
