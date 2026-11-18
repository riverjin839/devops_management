"""서비스 구성 — 클러스터 서비스(etcd·containerd·cilium·OS)의 관리 대상 설정 목록과 설정 버전.

- ``ServiceConfigItem``    : 서비스별 관리 대상 설정(키·섹션·설명·형식·기본값·반영 방식·현재 값을 읽을 출처 키).
  시드로 채우지만 DB 행이라 화면에서 다룬다(UI-First). (service, key) 고유.
- ``ServiceConfigVersion`` : 클러스터·서비스(·노드 그룹)별 설정 값 묶음 1개 = 1버전. 1단계는 현재 값에서 가져온 V1(``imported``)만
  만든다. 편집 저장(``saved``)·적용(``applied``)·대체(``superseded``)는 다음 단계에서 쓴다.
  ``group_id`` 는 노드 그룹 재정의(다음 단계)용 — NULL = 기본(전체 노드).

현재 노드 값은 별도 테이블이 아니라 기존 수집 스냅샷(``cluster_config_snapshots``)에서 읽는다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


class ServiceConfigItem(Base):
    __tablename__ = "service_config_items"
    __table_args__ = (UniqueConstraint("service", "key", name="uq_service_config_items_service_key"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    service = Column(String(32), nullable=False, index=True)       # etcd | containerd | cilium | linux
    section = Column(String(64), nullable=False)                   # 화면 섹션 이름
    key = Column(String(300), nullable=False)                      # 화면에 보이는 설정 키
    label = Column(String(200), nullable=True)                     # 짧은 설명(한 줄)
    help = Column(Text, nullable=True)                             # 자세한 설명
    value_type = Column(String(16), nullable=False, default="string")  # string | int | bool | enum | size | duration
    unit = Column(String(16), nullable=True)
    options = Column(JSONB, nullable=True)                         # enum 선택지
    default_value = Column(String(500), nullable=True)
    # 바뀌면 무엇이 일어나는가 — immediate(즉시) | restart_member | restart_service | rolling_restart_ds | reboot
    restart_scope = Column(String(32), nullable=False, default="immediate")
    # 현재 값을 읽을 출처 키 — 서비스마다 의미가 다르다(etcd: {"flag","env"}, containerd: {"paths":[...]}, cilium/linux: {"key"}).
    source_keys = Column(JSONB, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class ServiceConfigVersion(Base):
    __tablename__ = "service_config_versions"
    __table_args__ = (
        UniqueConstraint("cluster_id", "service", "group_id", "version_no", name="uq_service_config_versions_no"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    service = Column(String(32), nullable=False)
    group_id = Column(UUID(as_uuid=True), nullable=True)           # 노드 그룹(다음 단계). NULL = 기본(전체)
    version_no = Column(Integer, nullable=False)
    values = Column(JSONB, nullable=False, default=dict)          # {key: value}
    status = Column(String(16), nullable=False, default="saved")  # imported | saved | applied | superseded
    note = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    applied_at = Column(DateTime, nullable=True)
