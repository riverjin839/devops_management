"""Isilon(OneFS) NAS 서버 인벤토리 + NFS 수집용 커스텀 명령 등록.

K8s 가 마운트해서 쓰는 NFS 를 **Isilon 서버 쪽**에서 모니터링하기 위한 접속 대상과,
수집에 사용할 ``isi`` 명령 집합을 저장한다.

- ``IsilonServer`` : SSH 접속 대상 (host/port/username) + 암호화된 자격증명.
  자격증명은 평문으로 저장하지 않고 ``app.services.secret_box`` 로 암호화한 ciphertext 만 보관한다
  (BatchJob 의 ``encrypted_password``/``encrypted_private_key`` 패턴과 동일).
- ``IsilonCommand`` : 수집에 쓰는 ``isi`` 명령 정의. 기본(builtin) 명령도 이 테이블로 시드해
  운영자가 OneFS 버전/환경에 맞게 편집·비활성·추가할 수 있게 한다. ``server_id`` 가 NULL 이면
  모든 서버에 적용되는 글로벌 기본, 값이 있으면 해당 서버 전용 오버라이드.

**부하 보호 원칙**: 등록되는 모든 명령은 읽기 전용이어야 하며, 실제 검증은
``app.services.isilon_service.validate_isi_command`` 가 담당한다(변경/무거운 명령 거부).
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class IsilonServer(Base):
    __tablename__ = "isilon_servers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False, unique=True)
    host = Column(String(255), nullable=False)             # IP 또는 호스트명
    port = Column(Integer, default=22)                      # SSH 포트
    username = Column(String(100), default="root")          # SSH 사용자명

    # SSH 자격증명 — 암호문만 저장(secret_box). 둘 중 하나만 사용.
    encrypted_password = Column(String, nullable=True)
    encrypted_private_key = Column(String, nullable=True)

    description = Column(String(500), nullable=True)
    status = Column(String(20), default="unknown")          # online / offline / unknown
    last_checked = Column(DateTime, nullable=True)

    # 여러 서버 등록 시 server_id 없이 조회할 때 사용할 기본 서버.
    is_default = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<IsilonServer(name={self.name}, host={self.host})>"


class IsilonCommand(Base):
    __tablename__ = "isilon_commands"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = 글로벌 기본, 값 있으면 해당 서버 전용 오버라이드.
    server_id = Column(
        UUID(as_uuid=True), ForeignKey("isilon_servers.id", ondelete="CASCADE"), nullable=True
    )

    key = Column(String(60), nullable=False)               # slug (exports, quotas, custom-foo ...)
    label = Column(String(150), nullable=False)
    # exports | nfs_settings | quotas | clients | node_health | custom
    section = Column(String(30), default="custom")
    command = Column(String(1000), nullable=False)         # 실행할 isi 명령 (읽기 전용만)
    parse_mode = Column(String(10), default="text")        # json | text
    timeout_seconds = Column(Integer, default=15)          # per-command exec timeout (부하 보호)

    enabled = Column(Boolean, default=True)
    show_on_overview = Column(Boolean, default=True)
    sort_order = Column(Integer, default=100)
    is_builtin = Column(Boolean, default=False)            # 기본 시드 여부(삭제 방지용)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        return f"<IsilonCommand(key={self.key}, section={self.section})>"
