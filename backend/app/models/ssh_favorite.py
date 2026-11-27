"""SSH 터미널 즐겨찾기 명령 — 사용자별(서버 저장).

SSH 화면(K8S 허브 콘솔 ▸ SSH)의 터미널 창 ★ 메뉴·칩 바에 뜨는 명령이다. 첫 조회 때 기본 명령
(옛 커널 파라미터 콘솔 프리셋, ``services/ssh_favorites.py`` ``PRESETS``)이 그 사용자 몫으로 복사되고,
이후 사용자가 고치고 지우고 더한다. 기본 명령을 지우면 행을 지우지 않고 ``hidden`` 으로 숨긴다
(다시 시드되지 않게 + 「기본값 복원」이 되살린다). 인증 정보는 담지 않는다 — 명령 본문만 저장.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class SshFavoriteCommand(Base):
    __tablename__ = "ssh_favorite_commands"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # username — saved_scripts 와 같이 user FK 를 걸지 않는다(사용자 삭제가 막히지 않게).
    username = Column(String(128), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    description = Column(String(500), nullable=True)
    command = Column(Text, nullable=False)
    # insert = 터미널에 입력만(Enter 는 사용자가) · run = 입력 후 Enter
    run_mode = Column(String(16), nullable=False, default="insert", server_default="insert")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    # 기본 명령에서 온 행이면 프리셋 키(os-info …), 사용자가 만든 행이면 NULL.
    preset_key = Column(String(40), nullable=True)
    hidden = Column(Boolean, nullable=False, default=False, server_default="false")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
