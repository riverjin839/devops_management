"""공통 서비스 — 여러 K8S 클러스터가 함께 쓰는 서비스(LDAP AD·KEYCLOAK·JENKINS·ARGOCD·NEXUS) 등록·설정값 수집·변경 감지.

- ``CommonServiceInstance``   : 인스턴스 1개 = 1행. 호스팅 위치(k8s 워크로드 · podman 컨테이너 · 외부)와 서비스별 비밀 아닌 설정(``params``).
- ``CommonServiceCredential`` : 인스턴스의 접속 정보(앱 API 토큰·SSH·LDAP 바인드). ``secret`` 은 ``EncryptedText``(투명 암호화) —
  주기 수집(변경 감지)에 필요해 저장한다. API 응답에는 ``has_secret`` 만, 백업 export 는 기본 마스킹.
- ``CommonServiceLink``       : 이 서비스를 쓰는 클러스터(다대다, 수동 지정).
- ``CommonServiceSnapshot``   : 수집 결과 — 컴포넌트(``deploy``·``app:realm:<name>``·``podman:inspect`` …)별, 내용 해시가 바뀔 때만 새 행.
- ``CommonServiceChange``     : 직전 스냅샷 대비 바뀐 키 1개 = 1행(로그성 400일).
- ``CommonServiceRun``        : 수집·접속 테스트 실행 1회 = 1행(단계·실행 로그, 로그성 365일).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base
from app.models._crypto_types import EncryptedText


class CommonServiceInstance(Base):
    __tablename__ = "common_service_instances"
    __table_args__ = (UniqueConstraint("service_type", "name", name="uq_common_service_instances_type_name"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    service_type = Column(String(32), nullable=False, index=True)   # ldap_ad | keycloak | jenkins | argocd | nexus
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    endpoint_url = Column(String(512), nullable=True)               # 앱 API/LDAP 주소(ldaps://… 포함)
    tls_verify = Column(Boolean, nullable=False, default=True)
    # 호스팅 위치 — k8s(등록 클러스터의 워크로드) | podman(일반 노드 컨테이너) | external(클러스터 밖, 예: Windows AD)
    host_kind = Column(String(16), nullable=False, default="external")
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="SET NULL"), nullable=True, index=True)
    namespace = Column(String(253), nullable=True)
    workload_kind = Column(String(32), nullable=True)               # Deployment | StatefulSet | DaemonSet
    workload_name = Column(String(253), nullable=True)
    ssh_host = Column(String(255), nullable=True)
    ssh_port = Column(Integer, nullable=True, default=22)
    container_name = Column(String(253), nullable=True)
    params = Column(JSONB, nullable=True)                           # 서비스별 비밀 아닌 설정(카탈로그 param_fields)
    watch_enabled = Column(Boolean, nullable=False, default=True)
    status = Column(String(16), nullable=False, default="unknown")  # unknown | ok | partial | error
    last_collected_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    fail_count = Column(Integer, nullable=False, default=0)         # 연속 수집 실패 수(도달 불가 알람)
    tenant_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class CommonServiceCredential(Base):
    __tablename__ = "common_service_credentials"
    __table_args__ = (UniqueConstraint("instance_id", "purpose", name="uq_common_service_credentials_purpose"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    instance_id = Column(UUID(as_uuid=True), ForeignKey("common_service_instances.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    purpose = Column(String(16), nullable=False)          # app_api | ssh | ldap_bind
    auth_type = Column(String(16), nullable=False, default="password")  # password | token | private_key
    username = Column(String(255), nullable=True)
    secret = Column(EncryptedText, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class CommonServiceLink(Base):
    __tablename__ = "common_service_links"
    __table_args__ = (UniqueConstraint("instance_id", "cluster_id", name="uq_common_service_links_pair"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    instance_id = Column(UUID(as_uuid=True), ForeignKey("common_service_instances.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    relation = Column(String(200), nullable=True)         # 메모 — "OIDC 인증", "이미지 레지스트리" …
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class CommonServiceSnapshot(Base):
    __tablename__ = "common_service_snapshots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    instance_id = Column(UUID(as_uuid=True), ForeignKey("common_service_instances.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    component = Column(String(200), nullable=False)
    data = Column(JSONB, nullable=False, default=dict)    # {"flat": {key: value}, "meta": {...}}
    content_hash = Column(String(64), nullable=False)
    collected_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class CommonServiceChange(Base):
    __tablename__ = "common_service_changes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    instance_id = Column(UUID(as_uuid=True), ForeignKey("common_service_instances.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    component = Column(String(200), nullable=False)
    key = Column(String(500), nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    source = Column(String(16), nullable=False, default="schedule")   # schedule | manual
    to_snapshot_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    detected_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class CommonServiceRun(Base):
    """``status``: running · succeeded · partial(일부 단계 실패) · failed. ``log_lines``: [[ts, level, message], ...]."""
    __tablename__ = "common_service_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    instance_id = Column(UUID(as_uuid=True), ForeignKey("common_service_instances.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    kind = Column(String(16), nullable=False, default="collect")      # collect | test
    trigger = Column(String(16), nullable=False, default="manual")    # manual | schedule
    status = Column(String(16), nullable=False, default="running")
    steps = Column(JSONB, nullable=True)                              # [{name, label, status, message}]
    log_lines = Column(JSONB, nullable=True)
    summary = Column(JSONB, nullable=True)                            # {components, changed, changes}
    started_by = Column(String(128), nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)
