"""SQLAlchemy 커스텀 컬럼 타입 — DB 저장값 투명 암호화.

``app.services.secret_box`` 를 이 모듈 최상단에서 import 하면 순환 임포트가 생긴다:
``app.models.cluster`` → ``app.services.secret_box`` → (패키지 초기화)
``app.services.__init__`` → ``health_checker`` → ``app.models`` (아직 초기화 중인
``app.models.cluster.Cluster`` 를 다시 요구) → ImportError. 그래서 encrypt/decrypt 는
실제로 값을 암복호화하는 메서드 안에서만 지연 import 한다 — 그 시점엔 앱이 이미 전부
로드된 뒤라 순환이 발생하지 않는다.
"""
from __future__ import annotations

from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator


class EncryptedText(TypeDecorator):
    """텍스트 컬럼을 ``secret_box`` 로 투명하게 암호화/복호화하는 컬럼 타입.

    ORM/Core 어느 경로로 읽고 쓰든(라우터, backup_service 의 Core-level 백업
    export/import 포함) 자동으로 암복호화된다 — 컬럼 타입을 이걸로 바꾸는 것 외에
    호출부 코드를 전혀 건드릴 필요가 없다.

    기존에 평문으로 저장된 행과의 호환을 위해 **lazy migration** 방식을 쓴다: 복호화가
    실패하면(버전 마커 없음 = 아직 암호화되지 않은 레거시 값) 원본 문자열을 그대로
    반환하고, 그 값을 다시 저장하는 시점에 자동으로 암호화된다. 별도의 백필
    마이그레이션 스크립트가 필요 없다.
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):  # Python → DB
        if value is None:
            return None
        from app.services.secret_box import encrypt
        return encrypt(value)

    def process_result_value(self, value, dialect):  # DB → Python
        if value is None:
            return None
        from app.services.secret_box import decrypt
        try:
            return decrypt(value)
        except ValueError:
            # 레거시 평문 데이터 — 그대로 반환. 다음 저장 시 자동으로 암호화된다.
            return value
