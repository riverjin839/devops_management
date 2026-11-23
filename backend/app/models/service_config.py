"""서비스 구성 — 클러스터 서비스(etcd·containerd·cilium·OS)의 관리 대상 설정 목록과 설정 버전.

- ``ServiceConfigItem``    : 서비스별 관리 대상 설정(키·섹션·설명·형식·기본값·반영 방식·현재 값을 읽을 출처 키).
  시드로 채우지만 DB 행이라 화면에서 다룬다(UI-First). (service, key) 고유.
- ``ServiceConfigRule`` · ``ServiceConfigGroup`` : 의존 규칙 · 노드 그룹(아래 클래스 설명).
- ``ServiceConfigVersion`` : 클러스터·서비스(·노드 그룹)별 설정 값 묶음 1개 = 1버전. 현재 값에서 가져온 V1(``imported``),
  편집 저장(``saved`` — 새로 저장하면 이전 미적용 저장본은 ``superseded``), 적용(``applied`` — 다음 단계).
  ``group_id`` NULL = 기본 그룹(전체 값), 값이 있으면 그 노드 그룹의 **재정의 값만** 담는다.

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
    group_id = Column(UUID(as_uuid=True), nullable=True)           # 노드 그룹. NULL = 기본 그룹(나머지 노드)
    version_no = Column(Integer, nullable=False)
    values = Column(JSONB, nullable=False, default=dict)          # {key: value}
    status = Column(String(16), nullable=False, default="saved")  # imported | saved | applied | superseded
    note = Column(Text, nullable=True)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    applied_at = Column(DateTime, nullable=True)


class ServiceConfigRule(Base):
    """의존 규칙 — 원인 설정(service·key)이 대상 설정(target_service·target_key)에 거는 조건. 시드지만 DB 행(UI-First).

    ``kind``: recommend(제안 — 체크해서 함께 저장) · require(어기면 저장 불가) · impact(안내만).
    ``rule_type``(고정 집합, 코드 eval 없음): min_of_key · multiple_of_key(params.factor) · max_value(params.max) ·
    requires_when(params.when, params.equals?) · fixed_value(params.value) · impact.
    ``key`` 가 ``*`` 이면 원인 서비스가 있다는 것만으로 거는 조건(예: CILIUM 이 OS ip_forward=1 을 요구).
    """
    __tablename__ = "service_config_rules"
    __table_args__ = (UniqueConstraint("rule_key", name="uq_service_config_rules_key"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_key = Column(String(120), nullable=False)          # 시드 식별자(중복 시드 방지)
    service = Column(String(32), nullable=False, index=True)
    key = Column(String(300), nullable=False)
    target_service = Column(String(32), nullable=True)     # impact 는 대상 없음 가능
    target_key = Column(String(300), nullable=True)
    kind = Column(String(16), nullable=False)               # recommend | require | impact
    rule_type = Column(String(32), nullable=False)
    params = Column(JSONB, nullable=True)
    reason = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ServiceConfigGroup(Base):
    """노드 그룹 — 일부 노드에만 다른 값을 줄 때. 그룹 버전(``ServiceConfigVersion.group_id``)은 재정의 값만 담는다.
    기본 그룹 = 어느 그룹에도 들지 않은 나머지 노드. 노드는 ``sort_order`` 순으로 처음 일치한 그룹 하나에만 속한다."""
    __tablename__ = "service_config_groups"
    __table_args__ = (UniqueConstraint("cluster_id", "service", "name", name="uq_service_config_groups_name"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    service = Column(String(32), nullable=False)
    name = Column(String(100), nullable=False)
    node_pattern = Column(String(500), nullable=False)      # 노드 이름(또는 수집 호스트) glob, 쉼표로 여러 개
    description = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ServiceConfigApplyRun(Base):
    """적용 1회 = 1행(로그성, 365일). SSH 자격증명은 저장하지 않는다 — 요청 안에서만 쓴다.

    ``status``: running · succeeded(대상 전부 성공) · partial(일부 성공·건너뜀) · failed(성공 없음) · stopped(중지 요청).
    ``node_results``: 노드별 {node, host, status(ok|failed|skipped), before, after, error, duration_ms}.
    ``log_lines``: [[ts, level, message], ...] — 배치마다 커밋돼 화면을 다시 열어도 진행이 보인다.
    """
    __tablename__ = "service_config_apply_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    service = Column(String(32), nullable=False)
    group_id = Column(UUID(as_uuid=True), nullable=True)
    version_no = Column(Integer, nullable=False)
    status = Column(String(16), nullable=False, default="running")
    target_mode = Column(String(16), nullable=False, default="scope")   # scope(범위 전체) | nodes(고른 노드)
    targets = Column(JSONB, nullable=True)
    options = Column(JSONB, nullable=True)
    changes = Column(JSONB, nullable=True)
    node_results = Column(JSONB, nullable=True)
    log_lines = Column(JSONB, nullable=True)
    stop_requested = Column(Boolean, nullable=False, default=False)
    started_by = Column(String(128), nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)


class ServiceConfigChange(Base):
    """노드 설정 값 변경 1건 = 1행(로그성, 400일) — 같은 컴포넌트의 직전 스냅샷과 비교해 관리 대상 키가 바뀌었을 때 남는다.

    ``source``: agent(노드 파라미터 에이전트 파일 보고) · k8s_api(주기·수동 K8S API 수집) · ssh(수동 SSH 수집) · apply(PEP 적용).
    LINUX 커널 파라미터는 기존 ``os_param_changes`` 가 맡고, 나머지 서비스(etcd·containerd·cilium·정적 파드·kubelet)는 여기에 남는다.
    """
    __tablename__ = "service_config_changes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False, index=True)
    service = Column(String(32), nullable=False)
    node = Column(String(253), nullable=False)
    key = Column(String(300), nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    source = Column(String(16), nullable=False, default="k8s_api")
    component = Column(String(300), nullable=True)
    # 비교한 스냅샷(새 쪽) — 같은 스냅샷을 두 번 기록하지 않게 하는 키.
    to_snapshot_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    detected_at = Column(DateTime, default=datetime.utcnow, nullable=False)
