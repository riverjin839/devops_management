"""DC 인벤토리 — 데이터센터 물리 구간(랙·장비·인터페이스·케이블·IPAM) 모델.

설계: ``docs/dc-inventory/DESIGN.md``. NetBox 의 개념(Site → Rack → Device → Interface → Cable, IPAM)만
참고했고 스키마는 1개 DC · 랙 20~40 · 장비 400대 규모에 맞게 단순화했다.

- ``dc_devices`` 가 서버·스위치 **신원의 단일 원본**이다. ``node_server_specs.device_id`` ·
  ``infra_nodes.device_id`` 가 이 행을 가리킨다(``services/dc_inventory/device_registry.py``).
- 모든 쓰기는 ``services/dc_inventory/crud.py`` 를 거친다 — 제약 검증과 ``dc_change_logs`` 기록이
  같은 트랜잭션에서 일어나야 하므로 라우터가 ORM 을 직접 수정하지 않는다.
- ``version`` 은 낙관적 잠금용(수정 시 클라이언트가 보낸 값과 다르면 409).
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import CIDR, INET, JSONB, UUID

from app.database import Base

DEVICE_ROLES = ("server", "leaf", "spine", "super-spine", "fa-core", "mgmt", "patch")
# 패브릭 계층 — 숫자가 작을수록 위. FA 코어 → super-spine → spine → leaf(ToR) 순으로 아래로 연결한다.
FABRIC_TIER_RANK = {"fa-core": 0, "super-spine": 1, "spine": 2, "leaf": 3}
DEVICE_STATUSES = ("planned", "active", "spare", "maintenance", "decommission")
DEVICE_FACES = ("front", "rear")
RACK_STATUSES = ("active", "planned", "retired")
INTERFACE_PURPOSES = (
    "private-a", "private-b", "public-a", "public-b", "bmc", "uplink", "patch", "other",
)
CABLE_STATUSES = ("planned", "connected", "faulty")
CABLE_TYPES = ("dac", "aoc", "fiber", "utp")
PREFIX_PURPOSES = (
    "private-a", "private-b", "public-a", "public-b", "bmc", "loopback", "p2p", "other",
)
IP_ROLES = ("primary", "vip", "gateway", "reserved")
ASN_TARGET_TYPES = ("rack", "cluster", "fabric_tier")
FABRIC_TIERS = ("leaf", "spine", "super-spine")


def _uuid_pk():
    return Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class _Tracked:
    """편집 대상 공통 컬럼 — 낙관적 잠금 버전과 생성·수정 시각."""

    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ── 위치 계층 ────────────────────────────────────────────────────────────────

class DcSite(_Tracked, Base):
    __tablename__ = "dc_sites"

    id = _uuid_pk()
    name = Column(String(100), nullable=False, unique=True)
    description = Column(Text, nullable=True)


class DcHall(_Tracked, Base):
    __tablename__ = "dc_halls"
    __table_args__ = (UniqueConstraint("site_id", "name", name="uq_dc_halls_site_name"),)

    id = _uuid_pk()
    site_id = Column(UUID(as_uuid=True), ForeignKey("dc_sites.id", ondelete="RESTRICT"), nullable=False)
    name = Column(String(100), nullable=False)
    # 화면에서는 "구간(구획)" 으로 부른다 — DC 안의 물리 구획. zone_no 는 구간 번호(DC #n 구간).
    zone_no = Column(Integer, nullable=True)
    description = Column(Text, nullable=True)


class DcRackRow(_Tracked, Base):
    __tablename__ = "dc_rack_rows"
    __table_args__ = (UniqueConstraint("hall_id", "name", name="uq_dc_rack_rows_hall_name"),)

    id = _uuid_pk()
    hall_id = Column(UUID(as_uuid=True), ForeignKey("dc_halls.id", ondelete="RESTRICT"), nullable=False)
    name = Column(String(100), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)


class DcRack(_Tracked, Base):
    __tablename__ = "dc_racks"
    __table_args__ = (
        CheckConstraint("u_height BETWEEN 1 AND 60", name="ck_dc_racks_u_height"),
        Index("ix_dc_racks_row", "row_id"),
    )

    id = _uuid_pk()
    row_id = Column(UUID(as_uuid=True), ForeignKey("dc_rack_rows.id", ondelete="RESTRICT"), nullable=False)
    name = Column(String(100), nullable=False, unique=True)          # 전역 유일 (예: R07)
    rack_no = Column(Integer, nullable=True, unique=True)            # IPAM 규칙 입력값
    position_in_row = Column(Integer, nullable=True)
    u_height = Column(Integer, nullable=False, default=42)
    power_note = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="active")
    description = Column(Text, nullable=True)


# ── 장비 ─────────────────────────────────────────────────────────────────────

class DcDeviceType(_Tracked, Base):
    __tablename__ = "dc_device_types"
    __table_args__ = (CheckConstraint("u_height >= 0", name="ck_dc_device_types_u_height"),)

    id = _uuid_pk()
    vendor = Column(String(64), nullable=True)
    model = Column(String(128), nullable=False, unique=True)
    u_height = Column(Integer, nullable=False, default=1)            # 0 = 랙 공간 미점유
    is_full_depth = Column(Boolean, nullable=False, default=True)
    default_role = Column(String(20), nullable=True)
    # [{name, speed_mbps, purpose}] 또는 범위형 [{pattern: "Ethernet1/{n}", start, count, speed_mbps, purpose}]
    interface_templates = Column(JSONB, nullable=True)


class DcDevice(_Tracked, Base):
    __tablename__ = "dc_devices"
    __table_args__ = (
        # 시작 U 는 랙이 있어야 의미가 있다. 랙만 알고 U 를 모르는 장비(위치 미정)는 허용한다.
        CheckConstraint("position_u IS NULL OR rack_id IS NOT NULL", name="ck_dc_devices_position_needs_rack"),
        CheckConstraint("position_u IS NULL OR position_u >= 1", name="ck_dc_devices_position_min"),
        CheckConstraint("u_height >= 0", name="ck_dc_devices_u_height"),
        Index("ix_dc_devices_rack", "rack_id"),
        Index("ix_dc_devices_cluster", "cluster_id"),
        Index("ix_dc_devices_role", "role"),
    )

    id = _uuid_pk()
    hostname = Column(String(255), nullable=False, unique=True)
    role = Column(String(20), nullable=False, default="server")
    device_type_id = Column(UUID(as_uuid=True), ForeignKey("dc_device_types.id", ondelete="RESTRICT"), nullable=True)
    rack_id = Column(UUID(as_uuid=True), ForeignKey("dc_racks.id", ondelete="RESTRICT"), nullable=True)
    position_u = Column(Integer, nullable=True)                      # 가장 아래 U (1 = 최하단)
    # 장비 종류에서 복제해 두는 값 — U 겹침 검사·DB EXCLUDE 제약이 한 테이블 안에서 끝나도록.
    u_height = Column(Integer, nullable=False, default=1)
    is_full_depth = Column(Boolean, nullable=False, default=True)
    face = Column(String(10), nullable=False, default="front")
    status = Column(String(20), nullable=False, default="active")
    serial = Column(String(64), nullable=True, unique=True)
    asset_tag = Column(String(64), nullable=True)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="SET NULL"), nullable=True)
    k8s_node_name = Column(String(255), nullable=True)
    description = Column(Text, nullable=True)


class DcInterface(_Tracked, Base):
    __tablename__ = "dc_interfaces"
    __table_args__ = (
        UniqueConstraint("device_id", "name", name="uq_dc_interfaces_device_name"),
        Index("ix_dc_interfaces_device", "device_id"),
    )

    id = _uuid_pk()
    device_id = Column(UUID(as_uuid=True), ForeignKey("dc_devices.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    speed_mbps = Column(Integer, nullable=True)
    purpose = Column(String(20), nullable=False, default="other")
    mac = Column(String(40), nullable=True)
    # 패치패널 앞·뒤 포트 쌍(경로 추적이 케이블 → 짝 포트 → 케이블 로 넘어간다).
    paired_interface_id = Column(UUID(as_uuid=True), ForeignKey("dc_interfaces.id", ondelete="SET NULL"), nullable=True)
    # 브레이크아웃 하위 인터페이스(예: Ethernet1/49/1 의 부모 Ethernet1/49).
    parent_interface_id = Column(UUID(as_uuid=True), ForeignKey("dc_interfaces.id", ondelete="SET NULL"), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    description = Column(Text, nullable=True)


class DcCable(_Tracked, Base):
    __tablename__ = "dc_cables"
    __table_args__ = (
        CheckConstraint("a_interface_id <> b_interface_id", name="ck_dc_cables_distinct_ends"),
    )

    id = _uuid_pk()
    # 컬럼별 UNIQUE — 한 인터페이스가 A·B 양쪽에 걸치는 경우는 서비스 검증이 막는다.
    a_interface_id = Column(UUID(as_uuid=True), ForeignKey("dc_interfaces.id", ondelete="RESTRICT"), nullable=False, unique=True)
    b_interface_id = Column(UUID(as_uuid=True), ForeignKey("dc_interfaces.id", ondelete="RESTRICT"), nullable=False, unique=True)
    label = Column(String(100), nullable=True, unique=True)
    status = Column(String(20), nullable=False, default="connected")
    cable_type = Column(String(20), nullable=True)
    length_m = Column(Float, nullable=True)
    description = Column(Text, nullable=True)


# ── IPAM ─────────────────────────────────────────────────────────────────────

class DcVrf(_Tracked, Base):
    __tablename__ = "dc_vrfs"

    id = _uuid_pk()
    name = Column(String(64), nullable=False, unique=True)
    rd = Column(String(64), nullable=True)
    description = Column(Text, nullable=True)


class DcPrefix(_Tracked, Base):
    __tablename__ = "dc_prefixes"
    __table_args__ = (
        UniqueConstraint("vrf_id", "cidr", name="uq_dc_prefixes_vrf_cidr"),
        Index("ix_dc_prefixes_rack", "rack_id"),
    )

    id = _uuid_pk()
    vrf_id = Column(UUID(as_uuid=True), ForeignKey("dc_vrfs.id", ondelete="RESTRICT"), nullable=False)
    cidr = Column(CIDR, nullable=False)
    rack_id = Column(UUID(as_uuid=True), ForeignKey("dc_racks.id", ondelete="SET NULL"), nullable=True)
    purpose = Column(String(20), nullable=False, default="other")
    gateway = Column(INET, nullable=True)
    description = Column(Text, nullable=True)


class DcIpAddress(_Tracked, Base):
    __tablename__ = "dc_ip_addresses"
    __table_args__ = (
        UniqueConstraint("vrf_id", "address", name="uq_dc_ip_addresses_vrf_address"),
        Index("ix_dc_ip_addresses_prefix", "prefix_id"),
        Index("ix_dc_ip_addresses_interface", "interface_id"),
    )

    id = _uuid_pk()
    prefix_id = Column(UUID(as_uuid=True), ForeignKey("dc_prefixes.id", ondelete="RESTRICT"), nullable=False)
    vrf_id = Column(UUID(as_uuid=True), ForeignKey("dc_vrfs.id", ondelete="RESTRICT"), nullable=False)  # prefix 에서 복제
    address = Column(INET, nullable=False)                           # 호스트 주소
    interface_id = Column(UUID(as_uuid=True), ForeignKey("dc_interfaces.id", ondelete="SET NULL"), nullable=True)
    role = Column(String(20), nullable=False, default="primary")
    dns_name = Column(String(255), nullable=True)
    description = Column(Text, nullable=True)


class DcAsn(_Tracked, Base):
    __tablename__ = "dc_asns"
    __table_args__ = (
        CheckConstraint("number BETWEEN 1 AND 4294967295", name="ck_dc_asns_number_range"),
    )

    id = _uuid_pk()
    number = Column(BigInteger, nullable=False, unique=True)
    target_type = Column(String(20), nullable=False)
    rack_id = Column(UUID(as_uuid=True), ForeignKey("dc_racks.id", ondelete="SET NULL"), nullable=True)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="SET NULL"), nullable=True)
    fabric_tier = Column(String(20), nullable=True)
    description = Column(Text, nullable=True)


# ── 토폴로지 (구간 ↔ 클러스터, 패브릭 계층 연결, 캔버스 좌표) ────────────────

class DcZoneCluster(_Tracked, Base):
    """구간(홀)에 걸쳐 있는 주요 K8s 클러스터 — 구간 하나에 여러 클러스터, 클러스터 하나가 여러 구간에 걸칠 수 있다."""

    __tablename__ = "dc_zone_clusters"
    __table_args__ = (UniqueConstraint("hall_id", "cluster_id", name="uq_dc_zone_clusters_hall_cluster"),)

    id = _uuid_pk()
    hall_id = Column(UUID(as_uuid=True), ForeignKey("dc_halls.id", ondelete="CASCADE"), nullable=False)
    cluster_id = Column(UUID(as_uuid=True), ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    note = Column(Text, nullable=True)


class DcLink(_Tracked, Base):
    """패브릭 계층의 논리 연결(상위 장비 → 하위 장비). 포트·케이블을 아직 모르는 단계에서 구조부터 그릴 때 쓴다.

    실제 케이블(``dc_cables``)이 등록되면 토폴로지는 그 케이블에서 파생한 연결도 함께 보여준다.
    """

    __tablename__ = "dc_links"
    __table_args__ = (
        UniqueConstraint("upper_device_id", "lower_device_id", name="uq_dc_links_pair"),
        CheckConstraint("upper_device_id <> lower_device_id", name="ck_dc_links_distinct"),
    )

    id = _uuid_pk()
    upper_device_id = Column(UUID(as_uuid=True), ForeignKey("dc_devices.id", ondelete="CASCADE"), nullable=False)
    lower_device_id = Column(UUID(as_uuid=True), ForeignKey("dc_devices.id", ondelete="CASCADE"), nullable=False)
    note = Column(Text, nullable=True)


class DcCanvasPosition(Base):
    """토폴로지 캔버스에서 사용자가 끌어 놓은 노드 위치. 없으면 계층별 자동 배치를 쓴다."""

    __tablename__ = "dc_canvas_positions"
    __table_args__ = (UniqueConstraint("object_type", "object_id", name="uq_dc_canvas_positions_object"),)

    id = _uuid_pk()
    object_type = Column(String(16), nullable=False)   # device | rack
    object_id = Column(UUID(as_uuid=True), nullable=False)
    x = Column(Float, nullable=False)
    y = Column(Float, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ── 변경 이력 ────────────────────────────────────────────────────────────────

class DcChangeLog(Base):
    """생성·수정·삭제 1건 = 1행. 데이터 변경과 같은 트랜잭션에서 쓴다(append-only)."""

    __tablename__ = "dc_change_logs"
    __table_args__ = (
        Index("ix_dc_change_logs_object", "object_type", "object_id", "created_at"),
        Index("ix_dc_change_logs_batch", "batch_id"),
        Index("ix_dc_change_logs_created", "created_at"),
    )

    id = _uuid_pk()
    object_type = Column(String(32), nullable=False)
    object_id = Column(UUID(as_uuid=True), nullable=False)
    object_repr = Column(String(255), nullable=False, default="")    # 삭제 뒤에도 읽을 수 있는 이름 스냅샷
    action = Column(String(16), nullable=False)                      # create | update | delete
    before = Column(JSONB, nullable=True)
    after = Column(JSONB, nullable=True)
    changed_fields = Column(JSONB, nullable=True)
    actor_user_id = Column(String(36), nullable=True)
    actor_username = Column(String(64), nullable=False, default="-")
    request_id = Column(String(64), nullable=True)
    batch_id = Column(String(36), nullable=True)                     # 일괄 작업 1회 = 같은 값
    source = Column(String(16), nullable=False, default="ui")        # ui | import | bulk | link | sync
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
