"""DC 인벤토리 요청 스키마.

- ``*Create`` 는 직접 정의하고 ``*Update`` 는 ``_partial`` 로 만든다(모든 필드 선택 + ``version``).
  수정은 보낸 필드만 바꾼다(``exclude_unset``) — ``null`` 을 보내면 그 값을 비운다.
- 응답은 ``services/dc_inventory/crud.serialize`` 가 만드는 dict 다(참조 이름이 붙는다).
- Excel 일괄 등록도 같은 스키마로 행을 검증한다 → 화면과 파일의 검증 결과가 같다.
"""
from typing import Annotated, Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, create_model, model_validator

from app.models.dc_inventory import (
    ASN_TARGET_TYPES,
    CABLE_STATUSES,
    CABLE_TYPES,
    DEVICE_FACES,
    DEVICE_ROLES,
    DEVICE_STATUSES,
    FABRIC_TIERS,
    INTERFACE_PURPOSES,
    IP_ROLES,
    PREFIX_PURPOSES,
    RACK_STATUSES,
)
from app.services.dc_inventory.validation import parse_speed

DeviceRole = Literal[DEVICE_ROLES]            # type: ignore[valid-type]
DeviceStatus = Literal[DEVICE_STATUSES]       # type: ignore[valid-type]
DeviceFace = Literal[DEVICE_FACES]            # type: ignore[valid-type]
RackStatus = Literal[RACK_STATUSES]           # type: ignore[valid-type]
InterfacePurpose = Literal[INTERFACE_PURPOSES]  # type: ignore[valid-type]
CableStatus = Literal[CABLE_STATUSES]         # type: ignore[valid-type]
CableType = Literal[CABLE_TYPES]              # type: ignore[valid-type]
PrefixPurpose = Literal[PREFIX_PURPOSES]      # type: ignore[valid-type]
IpRole = Literal[IP_ROLES]                    # type: ignore[valid-type]
AsnTargetType = Literal[ASN_TARGET_TYPES]     # type: ignore[valid-type]
FabricTier = Literal[FABRIC_TIERS]            # type: ignore[valid-type]

Name = Annotated[str, Field(min_length=1, max_length=100)]


class _Base(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def _blank_to_none(cls, data: Any) -> Any:
        """공백뿐인 문자열은 "값 없음" 으로 본다(빈 문자열이 저장되면 유일 제약·그룹핑이 어긋난다)."""
        if isinstance(data, dict):
            out = {}
            for k, v in data.items():
                if isinstance(v, str):
                    v = v.strip()
                    if v == "":
                        v = None
                out[k] = v
            return out
        return data


def _partial(model: type[BaseModel], name: str) -> type[BaseModel]:
    """모든 필드를 선택으로 바꾼 수정용 스키마 + 낙관적 잠금 ``version``."""
    fields: dict[str, Any] = {}
    for fname, info in model.model_fields.items():
        ann: Any = Optional[info.annotation]
        if info.metadata:
            ann = Annotated[(ann, *info.metadata)]  # 길이·범위 제약 유지
        fields[fname] = (ann, None)
    fields["version"] = (Optional[int], None)
    return create_model(name, __base__=model, **fields)


class SiteCreate(_Base):
    name: Name
    description: Optional[str] = None


class HallCreate(_Base):
    site_id: UUID
    name: Name
    description: Optional[str] = None


class RackRowCreate(_Base):
    hall_id: UUID
    name: Name
    sort_order: int = 0


class RackCreate(_Base):
    row_id: UUID
    name: Name
    rack_no: Optional[int] = Field(None, ge=0, le=9999)
    position_in_row: Optional[int] = Field(None, ge=0, le=9999)
    u_height: int = Field(42, ge=1, le=60)
    power_note: Optional[str] = None
    status: RackStatus = "active"
    description: Optional[str] = None


class DeviceTypeCreate(_Base):
    vendor: Optional[str] = Field(None, max_length=64)
    model: str = Field(..., min_length=1, max_length=128)
    u_height: int = Field(1, ge=0, le=60)
    is_full_depth: bool = True
    default_role: Optional[DeviceRole] = None
    interface_templates: Optional[list[dict[str, Any]]] = None


class DeviceCreate(_Base):
    hostname: str = Field(..., min_length=1, max_length=255)
    role: DeviceRole = "server"
    device_type_id: Optional[UUID] = None
    rack_id: Optional[UUID] = None
    position_u: Optional[int] = Field(None, ge=1, le=60)
    face: DeviceFace = "front"
    status: DeviceStatus = "active"
    serial: Optional[str] = Field(None, max_length=64)
    asset_tag: Optional[str] = Field(None, max_length=64)
    cluster_id: Optional[UUID] = None
    k8s_node_name: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None
    # 장비 종류의 인터페이스 템플릿으로 포트를 함께 만든다(생성 시에만 의미가 있다).
    create_interfaces_from_template: bool = False


class InterfaceCreate(_Base):
    device_id: UUID
    name: Name
    speed_mbps: Optional[int] = Field(None, ge=1)
    purpose: InterfacePurpose = "other"
    mac: Optional[str] = Field(None, max_length=40)
    paired_interface_id: Optional[UUID] = None
    parent_interface_id: Optional[UUID] = None
    enabled: bool = True
    description: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _speed_label(cls, data: Any) -> Any:
        """``speed: "25G"`` 로 보내도 받는다(``speed_mbps`` 로 변환)."""
        if isinstance(data, dict) and "speed" in data:
            data = dict(data)
            label = data.pop("speed")
            if data.get("speed_mbps") is None:
                data["speed_mbps"] = parse_speed(label)
        return data


class CableCreate(_Base):
    a_interface_id: UUID
    b_interface_id: UUID
    label: Optional[str] = Field(None, max_length=100)
    status: CableStatus = "connected"
    cable_type: Optional[CableType] = None
    length_m: Optional[float] = Field(None, ge=0, le=10000)
    description: Optional[str] = None


class VrfCreate(_Base):
    name: str = Field(..., min_length=1, max_length=64)
    rd: Optional[str] = Field(None, max_length=64)
    description: Optional[str] = None


class PrefixCreate(_Base):
    vrf_id: UUID
    cidr: str = Field(..., min_length=3, max_length=64)
    rack_id: Optional[UUID] = None
    purpose: PrefixPurpose = "other"
    gateway: Optional[str] = Field(None, max_length=64)
    description: Optional[str] = None


class IpAddressCreate(_Base):
    prefix_id: UUID
    address: str = Field(..., min_length=2, max_length=64)
    interface_id: Optional[UUID] = None
    role: IpRole = "primary"
    dns_name: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class AsnCreate(_Base):
    number: int = Field(..., ge=1, le=4294967295)
    target_type: AsnTargetType
    rack_id: Optional[UUID] = None
    cluster_id: Optional[UUID] = None
    fabric_tier: Optional[FabricTier] = None
    description: Optional[str] = None


CREATE: dict[str, type[BaseModel]] = {
    "sites": SiteCreate,
    "halls": HallCreate,
    "rack-rows": RackRowCreate,
    "racks": RackCreate,
    "device-types": DeviceTypeCreate,
    "devices": DeviceCreate,
    "interfaces": InterfaceCreate,
    "cables": CableCreate,
    "vrfs": VrfCreate,
    "prefixes": PrefixCreate,
    "ip-addresses": IpAddressCreate,
    "asns": AsnCreate,
}
UPDATE: dict[str, type[BaseModel]] = {
    key: _partial(model, model.__name__.replace("Create", "Update")) for key, model in CREATE.items()
}


# ── 일괄 작업 ────────────────────────────────────────────────────────────────

class BulkDevicesRequest(_Base):
    pattern: str = Field(..., min_length=1, max_length=255, description="예: node-a-07{01..18}")
    count: Optional[int] = Field(None, ge=1, le=500)
    role: DeviceRole = "server"
    device_type_id: Optional[UUID] = None
    rack_id: Optional[UUID] = None
    start_u: Optional[int] = Field(None, ge=1, le=60)
    step_u: Optional[int] = Field(None, ge=1, le=60, description="비우면 장비 높이만큼 띄운다")
    face: DeviceFace = "front"
    status: DeviceStatus = "planned"
    cluster_id: Optional[UUID] = None
    create_interfaces_from_template: bool = True
    dry_run: bool = False


class BulkInterfacesRequest(_Base):
    interface_ids: list[UUID] = Field(default_factory=list)
    device_id: Optional[UUID] = None
    ports: Optional[str] = Field(None, description="예: Ethernet1/1-48")
    speed: Optional[str] = Field(None, description="예: 25G, 100G")
    purpose: Optional[InterfacePurpose] = None
    enabled: Optional[bool] = None
    dry_run: bool = False


class BulkCablesRequest(_Base):
    a_device_id: UUID
    a_ports: str = Field(..., description="예: Ethernet1/1-18")
    b_device_ids: list[UUID] = Field(..., min_length=1, max_length=500)
    b_interface: str = Field(..., min_length=1, max_length=100)
    label_pattern: Optional[str] = Field(None, description="{host} · {port} · {a} 치환")
    status: CableStatus = "connected"
    cable_type: Optional[CableType] = None
    dry_run: bool = False


class BulkIpRequest(_Base):
    prefix_id: UUID
    interface_ids: list[UUID] = Field(..., min_length=1, max_length=500)
    start_address: Optional[str] = None
    role: IpRole = "primary"
    dry_run: bool = False


class LinkSelection(_Base):
    hostname: str
    action: Literal["link", "skip"] = "link"
    prefer: Literal["existing", "device"] = "existing"


class LinkApplyRequest(_Base):
    items: list[LinkSelection] = Field(..., min_length=1, max_length=2000)
