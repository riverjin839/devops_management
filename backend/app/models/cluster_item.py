import uuid
from datetime import datetime

from sqlalchemy import (
    Column,
    String,
    DateTime,
    Integer,
    Boolean,
    Text,
    Float,
    ForeignKey,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.database import Base


class ClusterItem(Base):
    """클러스터에 붙는 '아이템' 카드 — 현황 관리 대시보드의 단위 위젯.

    기존 기능들을 단위(item)로 묶어 해당 클러스터에 붙여서 보여준다.
    결과는 세 가지 방식으로 수집한다:
      · manual — 수동(수작업) 즉시 실행
      · auto   — 자동(배치). Celery Beat 가 스케줄(시각)에 맞춰 수집. 다수 가능.
      · ai     — AI 분석 (추후 도입)

    기본(builtin) 아이템(예: K8s 노드 수)은 클러스터마다 자동 생성되며,
    type 은 고정이지만 제목/아이콘/스케줄/카드 크기 등은 편집 가능하다.
    """

    __tablename__ = "cluster_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(
        UUID(as_uuid=True),
        ForeignKey("clusters.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # ── 아이템 정의 ────────────────────────────────────────
    item_type = Column(String(50), nullable=False, default="node_count")  # node_count | (확장)
    title = Column(String(100), nullable=False, default="K8s 노드 수")
    icon = Column(String(40), default="🖥️")
    description = Column(Text, nullable=True)
    tier = Column(String(20), nullable=False, default="basic")      # basic | advanced
    is_builtin = Column(Boolean, nullable=False, default=False)     # 기본 아이템 (삭제 불가, type 고정)

    # ── 결과 수집 방식 + 스케줄 ────────────────────────────
    source_mode = Column(String(20), nullable=False, default="auto")  # manual | auto | ai
    auto_enabled = Column(Boolean, nullable=False, default=True)      # 배치 자동 수집 on/off
    schedule_hour = Column(Integer, nullable=False, default=1)        # 매일 N 시 (KST)
    schedule_minute = Column(Integer, nullable=False, default=0)

    # ── 표시 ───────────────────────────────────────────────
    card_size = Column(String(10), nullable=False, default="md")     # sm | md | lg
    unit = Column(String(20), default="")                            # 예: "대"
    sort_order = Column(Integer, nullable=False, default=0)
    enabled = Column(Boolean, nullable=False, default=True)

    # ── 수집 결과 + 변경 추적 ──────────────────────────────
    current_value = Column(Float, nullable=True)        # 현재 값 (수치형: 노드 수, 만료일수 등)
    current_text = Column(Text, nullable=True)          # 현재 값 (문자형: 버전, AI 요약 등)
    result_detail = Column(JSONB, nullable=True)        # 부가 정보 (ready, namespaces, nodeVersions 등)
    result_status = Column(String(20), nullable=True)   # 도메인 상태: healthy | warning | critical | info
    last_status = Column(String(20), nullable=True)     # 수집 성공여부: ok | error | pending
    last_error = Column(Text, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)   # 마지막 수집 시각
    last_source = Column(String(20), nullable=True)     # manual | auto | ai (마지막 수집 방식)
    previous_value = Column(Float, nullable=True)       # 직전(변경 전) 수치값
    previous_text = Column(Text, nullable=True)         # 직전(변경 전) 문자값
    last_changed_at = Column(DateTime, nullable=True)   # 마지막으로 값이 바뀐 시각

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    cluster = relationship("Cluster", back_populates="items")

    def __repr__(self):
        return f"<ClusterItem(type={self.item_type}, cluster={self.cluster_id}, value={self.current_value})>"
