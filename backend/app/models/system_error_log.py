import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer, String, Text

from app.database import Base


class SystemErrorLog(Base):
    """서버 오류 1건 — 처리 안 된 예외와 5xx 응답. 화면의 "요청 ID" 로 찾는다.

    파드 로그는 재시작하면 사라지고 화면에서 볼 수 없어, 어디서 왜 실패했는지 추적할 근거로 DB 에 남긴다.
    로그성 테이블(백업 기본 제외·보존 30일 — log_retention_service).
    """

    __tablename__ = "system_error_logs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    request_id = Column(String(64), nullable=True, index=True)
    method = Column(String(10), nullable=True)
    path = Column(String(512), nullable=True)
    status_code = Column(Integer, nullable=False, default=500)
    username = Column(String(64), nullable=True)  # JWT sub 스냅샷 — 사용자가 지워져도 남는다
    pod = Column(String(128), nullable=True)  # 응답한 backend 파드(HOSTNAME)
    app_version = Column(String(32), nullable=True)
    error_type = Column(String(128), nullable=True)  # 예외 클래스명 — 5xx 응답만 있으면 NULL
    message = Column(Text, nullable=True)
    traceback = Column(Text, nullable=True)  # 끝부분 위주로 잘라 저장
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (
        Index("ix_system_error_logs_path_created", "path", "created_at"),
    )
