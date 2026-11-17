"""DC 인벤토리 Excel 양식 정의 + 내보내기.

시트·열 정의(``SHEETS``)는 일괄 등록(``importer``)과 공유한다. 내보낸 파일을 그대로 다시 올리면
모든 행이 "변경 없음" 이 되도록, 비교는 여기 ``row_repr`` 가 만든 값과 ``normalize`` 로만 한다.
"""
from __future__ import annotations

import io
import ipaddress
import json
from dataclasses import dataclass
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Font
from sqlalchemy.orm import Session

from app.models.cluster import Cluster
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
    DcAsn,
    DcCable,
    DcDevice,
    DcDeviceType,
    DcHall,
    DcInterface,
    DcIpAddress,
    DcPrefix,
    DcRack,
    DcRackRow,
    DcSite,
    DcVrf,
)
from app.services.dc_inventory import validation
from app.services.dc_inventory.crud import Names
from app.services.dc_inventory.errors import DcInvalid


@dataclass(frozen=True)
class Sheet:
    name: str
    resource: str                       # crud 리소스 키
    key: tuple[str, ...]                # upsert 키 열
    columns: tuple[tuple[str, str], ...]  # (열 이름, 타입: str|int|float|bool|speed|cidr|ip|json)

    @property
    def column_names(self) -> tuple[str, ...]:
        return tuple(c for c, _ in self.columns)

    def type_of(self, column: str) -> str:
        return dict(self.columns).get(column, "str")


# 처리 순서 = 참조 순서 (앞 시트에서 만든 행을 뒤 시트가 참조한다).
SHEETS: tuple[Sheet, ...] = (
    Sheet("racks", "racks", ("name",), (
        ("name", "str"), ("site", "str"), ("hall", "str"), ("row", "str"), ("rack_no", "int"),
        ("position_in_row", "int"), ("u_height", "int"), ("power_note", "str"), ("status", "str"),
        ("description", "str"))),
    Sheet("device_types", "device-types", ("model",), (
        ("model", "str"), ("vendor", "str"), ("u_height", "int"), ("is_full_depth", "bool"),
        ("default_role", "str"), ("interface_templates", "json"))),
    Sheet("devices", "devices", ("hostname",), (
        ("hostname", "str"), ("role", "str"), ("device_type", "str"), ("rack", "str"), ("position_u", "int"),
        ("face", "str"), ("status", "str"), ("serial", "str"), ("asset_tag", "str"), ("cluster", "str"),
        ("k8s_node_name", "str"), ("description", "str"), ("u_height", "int"), ("server_config", "str"),
        ("environment", "str"), ("purpose", "str"), ("os_version", "str"), ("network_config", "str"),
        ("redundancy", "str"))),
    Sheet("interfaces", "interfaces", ("device", "name"), (
        ("device", "str"), ("name", "str"), ("speed", "speed"), ("purpose", "str"), ("mac", "str"),
        ("paired_with", "str"), ("parent", "str"), ("enabled", "bool"), ("description", "str"))),
    Sheet("cables", "cables", ("label",), (
        ("label", "str"), ("a_device", "str"), ("a_interface", "str"), ("b_device", "str"),
        ("b_interface", "str"), ("status", "str"), ("cable_type", "str"), ("length_m", "float"),
        ("description", "str"))),
    Sheet("prefixes", "prefixes", ("vrf", "cidr"), (
        ("vrf", "str"), ("cidr", "cidr"), ("rack", "str"), ("purpose", "str"), ("gateway", "ip"),
        ("description", "str"))),
    Sheet("ip_addresses", "ip-addresses", ("vrf", "address"), (
        ("vrf", "str"), ("address", "ip"), ("device", "str"), ("interface", "str"), ("role", "str"),
        ("dns_name", "str"), ("description", "str"))),
    Sheet("asns", "asns", ("number",), (
        ("number", "int"), ("target_type", "str"), ("rack", "str"), ("cluster", "str"),
        ("fabric_tier", "str"), ("description", "str"))),
)
SHEET_BY_NAME = {s.name: s for s in SHEETS}

_TRUE = {"true", "1", "y", "yes", "o", "예", "t"}
_FALSE = {"false", "0", "n", "no", "x", "아니오", "f"}


def normalize(type_: str, value: Any, *, column: str = "") -> Any:
    """셀 값을 비교·저장용 표준형으로 바꾼다. 빈 값은 None."""
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return None
    try:
        if type_ == "int":
            if isinstance(value, bool):
                raise ValueError
            f = float(value)
            if not f.is_integer():
                raise ValueError
            return int(f)
        if type_ == "float":
            return float(value)
        if type_ == "bool":
            if isinstance(value, bool):
                return value
            s = str(value).strip().lower()
            if s in _TRUE:
                return True
            if s in _FALSE:
                return False
            raise ValueError
        if type_ == "speed":
            return validation.format_speed(validation.parse_speed(value))
        if type_ == "cidr":
            return str(ipaddress.ip_network(str(value), strict=True))
        if type_ == "ip":
            return str(ipaddress.ip_interface(str(value)).ip)
        if type_ == "json":
            parsed = json.loads(value) if isinstance(value, str) else value
            return json.dumps(parsed, ensure_ascii=False, sort_keys=True)
    except DcInvalid:
        raise
    except (ValueError, TypeError) as e:
        hint = {"int": "정수", "float": "숫자", "bool": "true/false", "cidr": "CIDR(예: 10.10.7.0/26)",
                "ip": "IP 주소", "json": "JSON"}.get(type_, type_)
        raise DcInvalid(f"'{value}' 은(는) {hint} 형식이 아닙니다", code="bad_value", column=column) from e
    # str — Excel 이 숫자로 바꿔 버린 값(시리얼 12345.0 등)을 문자열로 되돌린다.
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def load_names(db: Session) -> Names:
    """내보내기·일괄 등록 비교용 — 참조 테이블을 통째로 캐시에 올린다(규모가 작다)."""
    names = Names(db)
    for model in (DcSite, DcHall, DcRackRow, DcRack, DcDeviceType, DcDevice, DcInterface, DcVrf, DcPrefix, Cluster):
        for obj in db.query(model).all():
            names._cache[(model, obj.id)] = obj
    return names


def row_repr(names: Names, sheet: str, obj: Any) -> dict[str, Any]:
    """DB 행 → 시트 한 줄(열 이름 → 표준형 값)."""
    n = names
    if sheet == "racks":
        row = n.get(DcRackRow, obj.row_id)
        hall = n.get(DcHall, row.hall_id) if row else None
        return {
            "name": obj.name, "site": n.attr(DcSite, hall.site_id, "name") if hall else None,
            "hall": hall.name if hall else None, "row": row.name if row else None,
            "rack_no": obj.rack_no, "position_in_row": obj.position_in_row, "u_height": obj.u_height,
            "power_note": obj.power_note, "status": obj.status, "description": obj.description,
        }
    if sheet == "device_types":
        tpl = obj.interface_templates
        return {
            "model": obj.model, "vendor": obj.vendor, "u_height": obj.u_height,
            "is_full_depth": obj.is_full_depth, "default_role": obj.default_role,
            "interface_templates": json.dumps(tpl, ensure_ascii=False, sort_keys=True) if tpl else None,
        }
    if sheet == "devices":
        return {
            "hostname": obj.hostname, "role": obj.role,
            "device_type": n.attr(DcDeviceType, obj.device_type_id, "model"),
            "rack": n.attr(DcRack, obj.rack_id, "name"), "position_u": obj.position_u, "face": obj.face,
            "status": obj.status, "serial": obj.serial, "asset_tag": obj.asset_tag,
            "cluster": n.attr(Cluster, obj.cluster_id, "name"), "k8s_node_name": obj.k8s_node_name,
            "description": obj.description, "u_height": obj.u_height, "server_config": obj.server_config,
            "environment": obj.environment, "purpose": obj.purpose, "os_version": obj.os_version,
            "network_config": obj.network_config, "redundancy": obj.redundancy,
        }
    if sheet == "interfaces":
        return {
            "device": n.attr(DcDevice, obj.device_id, "hostname"), "name": obj.name,
            "speed": validation.format_speed(obj.speed_mbps), "purpose": obj.purpose, "mac": obj.mac,
            "paired_with": n.attr(DcInterface, obj.paired_interface_id, "name"),
            "parent": n.attr(DcInterface, obj.parent_interface_id, "name"),
            "enabled": obj.enabled, "description": obj.description,
        }
    if sheet == "cables":
        a = n.get(DcInterface, obj.a_interface_id)
        b = n.get(DcInterface, obj.b_interface_id)
        return {
            "label": obj.label,
            "a_device": n.attr(DcDevice, a.device_id, "hostname") if a else None,
            "a_interface": a.name if a else None,
            "b_device": n.attr(DcDevice, b.device_id, "hostname") if b else None,
            "b_interface": b.name if b else None,
            "status": obj.status, "cable_type": obj.cable_type, "length_m": obj.length_m,
            "description": obj.description,
        }
    if sheet == "prefixes":
        return {
            "vrf": n.attr(DcVrf, obj.vrf_id, "name"), "cidr": str(ipaddress.ip_network(str(obj.cidr), strict=False)),
            "rack": n.attr(DcRack, obj.rack_id, "name"), "purpose": obj.purpose,
            "gateway": str(ipaddress.ip_interface(str(obj.gateway)).ip) if obj.gateway is not None else None,
            "description": obj.description,
        }
    if sheet == "ip_addresses":
        iface = n.get(DcInterface, obj.interface_id)
        return {
            "vrf": n.attr(DcVrf, obj.vrf_id, "name"), "address": str(ipaddress.ip_interface(str(obj.address)).ip),
            "device": n.attr(DcDevice, iface.device_id, "hostname") if iface else None,
            "interface": iface.name if iface else None, "role": obj.role, "dns_name": obj.dns_name,
            "description": obj.description,
        }
    if sheet == "asns":
        return {
            "number": obj.number, "target_type": obj.target_type, "rack": n.attr(DcRack, obj.rack_id, "name"),
            "cluster": n.attr(Cluster, obj.cluster_id, "name"), "fabric_tier": obj.fabric_tier,
            "description": obj.description,
        }
    raise KeyError(sheet)


_ORDER = {
    "racks": (DcRack, (DcRack.name,)),
    "device_types": (DcDeviceType, (DcDeviceType.model,)),
    "devices": (DcDevice, (DcDevice.hostname,)),
    "interfaces": (DcInterface, (DcInterface.device_id, DcInterface.name)),
    "cables": (DcCable, (DcCable.label,)),
    "prefixes": (DcPrefix, (DcPrefix.cidr,)),
    "ip_addresses": (DcIpAddress, (DcIpAddress.address,)),
    "asns": (DcAsn, (DcAsn.number,)),
}

_GUIDE: tuple[tuple[str, str, str], ...] = (
    ("(공통)", "빈 칸", "값 없음. 수정 시 빈 칸은 그 값을 지운다. 시트나 열을 통째로 빼면 그 항목은 건드리지 않는다"),
    ("(공통)", "굵은 열", "키 열 — 이 값으로 기존 행을 찾아 있으면 수정, 없으면 추가한다. 파일에 없는 행은 지우지 않는다"),
    ("racks", "site / hall / row", "없으면 자동으로 만든다. row 는 필수, site·hall 을 비우면 'DC' · 'Hall-1'"),
    ("racks", "status", " · ".join(RACK_STATUSES)),
    ("devices", "role", " · ".join(DEVICE_ROLES)),
    ("devices", "status", " · ".join(DEVICE_STATUSES)),
    ("devices", "face", " · ".join(DEVICE_FACES)),
    ("devices", "position_u", "장비가 차지하는 가장 아래 U (1 = 최하단). 높이는 device_type 의 u_height"),
    ("devices", "(인터페이스)", "interfaces 시트에 그 장비 행이 없으면 device_type 의 기본 포트 구성으로 만든다"),
    ("device_types", "interface_templates",
     'JSON. 예: [{"pattern":"Ethernet1/{n}","start":1,"count":48,"speed_mbps":25000,"purpose":"other"}]'),
    ("interfaces", "speed", "1G · 10G · 25G · 40G · 50G · 100G · 200G · 400G (그 외는 1000M 처럼 Mbps)"),
    ("interfaces", "purpose", " · ".join(INTERFACE_PURPOSES)),
    ("interfaces", "paired_with", "패치패널 앞·뒤 포트 쌍 — 같은 장비의 포트 이름"),
    ("interfaces", "parent", "브레이크아웃 하위 인터페이스의 부모 포트 이름 (예: Ethernet1/49)"),
    ("cables", "label", "필수(키). 케이블마다 유일"),
    ("cables", "status", " · ".join(CABLE_STATUSES)),
    ("cables", "cable_type", " · ".join(CABLE_TYPES)),
    ("prefixes", "vrf", "없으면 자동으로 만든다 (기본 PUBLIC · PRIVATE)"),
    ("prefixes", "purpose", " · ".join(PREFIX_PURPOSES)),
    ("ip_addresses", "address", "호스트 주소. 같은 VRF 의 Prefix 범위 안이어야 한다"),
    ("ip_addresses", "role", " · ".join(IP_ROLES)),
    ("asns", "target_type", " · ".join(ASN_TARGET_TYPES) + " — 종류에 맞는 열(rack / cluster / fabric_tier) 하나만 채운다"),
    ("asns", "fabric_tier", " · ".join(FABRIC_TIERS)),
)


def _workbook(rows_by_sheet: dict[str, list[dict[str, Any]]]) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    bold = Font(bold=True)
    for sheet in SHEETS:
        ws = wb.create_sheet(sheet.name)
        ws.append(list(sheet.column_names))
        for idx, col in enumerate(sheet.column_names, start=1):
            if col in sheet.key:
                ws.cell(row=1, column=idx).font = bold
            ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = max(12, len(col) + 4)
        ws.freeze_panes = "A2"
        for row in rows_by_sheet.get(sheet.name, []):
            ws.append([row.get(c) for c in sheet.column_names])
    guide = wb.create_sheet("설명")
    guide.append(["시트", "열", "설명 / 허용값"])
    for cell in guide[1]:
        cell.font = bold
    for line in _GUIDE:
        guide.append(list(line))
    guide.column_dimensions["A"].width = 16
    guide.column_dimensions["B"].width = 22
    guide.column_dimensions["C"].width = 110
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def template_xlsx() -> bytes:
    """헤더만 있는 빈 양식 + 설명 시트."""
    return _workbook({})


def export_rows(db: Session) -> dict[str, list[dict[str, Any]]]:
    names = load_names(db)
    out: dict[str, list[dict[str, Any]]] = {}
    for sheet in SHEETS:
        model, order = _ORDER[sheet.name]
        rows = [row_repr(names, sheet.name, obj) for obj in db.query(model).order_by(*order).all()]
        if sheet.name == "interfaces":
            rows.sort(key=lambda r: (r["device"] or "", r["name"]))
        out[sheet.name] = rows
    return out


def export_xlsx(db: Session) -> bytes:
    return _workbook(export_rows(db))
