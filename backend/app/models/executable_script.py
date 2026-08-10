"""DB 저장·버전관리되는 실행 스크립트 자산 (Python/Ansible Playbook/Shell).

Batch Jobs·점검 매트릭스의 실행 로직이 파이썬 파일에 하드코딩돼 있어 UI 편집·
재사용·버전관리가 불가능하던 것을 해소하기 위한 신규 모델 — 설계 배경은
``docs/02-design/features/batch-jobs-execution-redesign.design.md`` §3 참고.

버전은 불변(append-only)이다 — 스크립트를 고치면 새 ``ExecutableScriptVersion``
행이 생기고 이전 버전은 그대로 남는다(``BatchJobRun.params_snapshot`` 과 동일
철학). ``current_version_id`` 는 "기본으로 실행될 버전"만 가리키며 롤백은 이
포인터만 바꾼다.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base

# DB 레벨 Enum 대신 문자열 컬럼 — job_type/source_type 등 기존 코드베이스 관례와
# 동일(새 kind 추가 시 마이그레이션 없이 확장 가능). 허용값 검증은 Pydantic 스키마가 한다.
SCRIPT_KINDS = ("python", "ansible_playbook", "shell")


class ExecutableScript(Base):
    __tablename__ = "executable_scripts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    kind = Column(String(20), nullable=False)  # python | ansible_playbook | shell
    tags = Column(JSONB, nullable=True)  # ["etcd", "cleanup"] — 검색/재사용 필터
    # 시드 스크립트(기존 executor 이관분) — 삭제 방지, 포크(복제 후 수정)는 허용.
    is_system = Column(Boolean, nullable=False, default=False)
    # use_alter=True — executable_script_versions.script_id 가 이 테이블을 다시 참조하는
    # 순환 FK. use_alter 없이는 Base.metadata.sorted_tables 가 순환을 못 풀어 경고를 내고
    # (schema_health/backup_service 등 여러 곳에서 이 순서에 의존) 향후 SQLAlchemy 버전에서
    # 에러로 격상될 예정 — ALTER TABLE 로 지연 생성해 순환을 명시적으로 해소한다.
    current_version_id = Column(
        UUID(as_uuid=True),
        ForeignKey("executable_script_versions.id", use_alter=True, name="fk_executable_scripts_current_version_id"),
        nullable=True,
    )
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    versions = relationship(
        "ExecutableScriptVersion",
        back_populates="script",
        foreign_keys="ExecutableScriptVersion.script_id",
        cascade="all, delete-orphan",
        order_by="ExecutableScriptVersion.version",
    )
    current_version = relationship(
        "ExecutableScriptVersion",
        foreign_keys=[current_version_id],
        post_update=True,
    )


class ExecutableScriptVersion(Base):
    __tablename__ = "executable_script_versions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    script_id = Column(UUID(as_uuid=True), ForeignKey("executable_scripts.id"), nullable=False)
    version = Column(Integer, nullable=False)  # 스크립트별 1부터 증가
    content = Column(Text, nullable=False)  # python 코드 / shell 스크립트 / ansible playbook yaml
    inventory_content = Column(Text, nullable=True)  # ansible_playbook 전용 — 인벤토리 템플릿
    # [{name, label, type, default, help}, ...] — DeepCheckFieldSpec 과 동일 shape.
    param_schema = Column(JSONB, nullable=True)
    changelog = Column(Text, nullable=True)  # "etcd env 경로 기본값 수정" 같은 사용자 메모
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    script = relationship("ExecutableScript", back_populates="versions", foreign_keys=[script_id])

    __table_args__ = (UniqueConstraint("script_id", "version", name="uq_executable_script_version"),)
