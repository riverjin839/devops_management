import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, Integer, Boolean
from sqlalchemy.dialects.postgresql import UUID, JSONB

from app.database import Base


class KnowledgePage(Base):
    """서비스별 지식베이스 노드 — 서비스 → 분류(고도화/운영업무/기술학습/구축) → 하위 → 문서 트리.

    하나의 모델로 폴더/문서/보드/로드맵을 표현(kind). parent_id 로 계층, sort_order 로 동일
    레벨 정렬. 본문(content)은 TipTap HTML. 공유는 visibility(part/private)+created_by 로 제어.
    """

    __tablename__ = "knowledge_pages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    service = Column(String(64), nullable=True, index=True)   # SERVICE_CATALOG slug. null=공통
    parent_id = Column(UUID(as_uuid=True), nullable=True, index=True)  # 상위 노드
    kind = Column(String(16), default="doc")                 # folder | doc | board | roadmap
    category = Column(String(32), nullable=True)             # enhancement|operation|learning|build|...
    title = Column(String(200), nullable=False)
    icon = Column(String(64), nullable=True)                 # emoji / lucide 이름 / data-url
    content = Column(Text, nullable=True)                    # TipTap HTML
    summary = Column(String(500), nullable=True)
    tags = Column(JSONB, nullable=True)                      # list[str]
    status = Column(String(16), default="active")           # draft | active | archived
    visibility = Column(String(16), default="part")         # part | private
    pinned = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    confluence_url = Column(Text, nullable=True)
    jira_url = Column(Text, nullable=True)
    # 비파괴 가져오기 출처 — 예: "ops_note:{id}" / "work_guide:{id}" / "service_entry:{id}". 중복 방지용.
    source_ref = Column(String(128), nullable=True, index=True)
    # 로드맵/일정(고도화) — P4 에서 활용. 미리 컬럼만 둔다.
    start_at = Column(DateTime, nullable=True)
    due_at = Column(DateTime, nullable=True)
    sprint_id = Column(UUID(as_uuid=True), nullable=True)
    created_by = Column(String(64), nullable=True)          # 소유자 username
    updated_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<KnowledgePage(service={self.service}, title={self.title})>"


class KnowledgePageVersion(Base):
    """문서 버전 스냅샷 — 자동(저장 시) + 수동 마일스톤. 복원/이력 추적용."""

    __tablename__ = "knowledge_page_versions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    page_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    version_no = Column(Integer, nullable=False)            # 페이지별 증가 번호
    kind = Column(String(8), default="auto")               # auto | milestone
    label = Column(String(200), nullable=True)             # 마일스톤 이름
    title = Column(String(200), nullable=True)             # 스냅샷 당시 제목
    content = Column(Text, nullable=True)                  # 스냅샷 당시 본문(HTML)
    author = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<KnowledgePageVersion(page={self.page_id}, v={self.version_no})>"


class KnowledgePresence(Base):
    """경량 '편집 중' 표시 — 페이지를 열고 있는 사용자의 하트비트(last_seen).

    실시간 CRDT 협업 대신, 폴링 기반으로 누가 같은 문서를 보고 있는지만 표시한다.
    """

    __tablename__ = "knowledge_presence"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    page_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    username = Column(String(64), nullable=False)
    display_name = Column(String(128), nullable=True)
    last_seen = Column(DateTime, default=datetime.utcnow, index=True)
