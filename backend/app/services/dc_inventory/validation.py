"""DC 인벤토리 제약 검증 — 위반은 ``DcConflict``(409) / ``DcInvalid``(422) 로 올린다.

DB 제약(UNIQUE·CHECK·EXCLUDE)이 2차 방어선이고, 여기가 사람이 읽을 사유를 만드는 1차 방어선이다.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Any
from uuid import UUID

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.dc_inventory import (
    DcCable,
    DcDevice,
    DcInterface,
    DcIpAddress,
    DcPrefix,
    DcRack,
)
from app.services.dc_inventory.errors import DcConflict, DcInvalid

# 화면·Excel 에서 고르는 속도 표기. 목록 밖 값은 "40000M" 처럼 Mbps 로 직접 적을 수 있다.
SPEED_LABELS: dict[str, int] = {
    "1G": 1_000, "10G": 10_000, "25G": 25_000, "40G": 40_000, "50G": 50_000,
    "100G": 100_000, "200G": 200_000, "400G": 400_000,
}
_SPEED_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([GM])?(?:bps|b)?\s*$", re.I)


def parse_speed(value: Any) -> int | None:
    """``"25G"`` · ``"100g"`` · ``"1000M"`` · ``25000`` → Mbps. 빈 값은 None."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise DcInvalid("속도 값이 올바르지 않습니다", code="bad_speed", column="speed")
    if isinstance(value, (int, float)):
        mbps = int(value)
    else:
        m = _SPEED_RE.match(str(value))
        if not m:
            raise DcInvalid(f"속도 '{value}' 를 해석할 수 없습니다 (예: 25G, 100G, 1000M)",
                            code="bad_speed", column="speed")
        num = float(m.group(1))
        unit = (m.group(2) or "M").upper()
        mbps = int(num * 1000) if unit == "G" else int(num)
    if mbps <= 0:
        raise DcInvalid("속도는 0 보다 커야 합니다", code="bad_speed", column="speed")
    return mbps


def format_speed(mbps: int | None) -> str | None:
    if mbps is None:
        return None
    if mbps % 1000 == 0:
        return f"{mbps // 1000}G"
    return f"{mbps}M"


def u_range_label(position_u: int | None, u_height: int | None) -> str | None:
    if position_u is None:
        return None
    h = max(int(u_height or 1), 1)
    return f"U{position_u}" if h == 1 else f"U{position_u}-U{position_u + h - 1}"


# ── 랙 배치 ──────────────────────────────────────────────────────────────────

def check_placement(db: Session, *, device_id: UUID | None, hostname: str, rack_id: UUID | None,
                    position_u: int | None, u_height: int, is_full_depth: bool, face: str) -> None:
    """같은 랙에서 U 범위가 겹치지 않는지 확인한다.

    전체 깊이 장비는 앞·뒤 무관하게 충돌하고, 반깊이 장비끼리는 같은 면일 때만 충돌한다.
    검사 전에 랙 행을 잠가(동시 등록 경합 방지) 같은 랙의 배치가 직렬화되게 한다.
    """
    if position_u is None:
        return
    if rack_id is None:
        raise DcInvalid("시작 U 를 지정하려면 랙을 먼저 골라야 합니다", code="position_needs_rack",
                        column="position_u")
    rack = db.query(DcRack).filter(DcRack.id == rack_id).with_for_update().first()
    if rack is None:
        raise DcInvalid("랙을 찾을 수 없습니다", code="rack_not_found", column="rack")
    if position_u < 1:
        raise DcInvalid("시작 U 는 1 이상이어야 합니다", code="bad_position", column="position_u")
    if u_height <= 0:
        return  # 랙 공간을 차지하지 않는 장비
    top = position_u + u_height - 1
    if top > rack.u_height:
        raise DcInvalid(
            f"{rack.name} 은 {rack.u_height}U 인데 {u_range_label(position_u, u_height)} 는 범위를 넘습니다",
            code="out_of_rack", column="position_u",
        )
    q = db.query(DcDevice).filter(
        DcDevice.rack_id == rack_id,
        DcDevice.position_u.isnot(None),
        DcDevice.u_height > 0,
        DcDevice.position_u <= top,
        (DcDevice.position_u + DcDevice.u_height - 1) >= position_u,
    )
    if device_id is not None:
        q = q.filter(DcDevice.id != device_id)
    for other in q.order_by(DcDevice.position_u).all():
        if is_full_depth or other.is_full_depth or other.face == face:
            other_range = u_range_label(other.position_u, other.u_height)
            raise DcConflict(
                f"{rack.name} 의 {other_range} 는 {other.hostname} 이(가) 사용 중입니다",
                code="u_overlap", column="position_u",
                conflict={"device_id": str(other.id), "hostname": other.hostname, "u_range": other_range,
                          "requested": u_range_label(position_u, u_height), "for": hostname},
            )


def check_rack_resize(db: Session, rack: DcRack, new_height: int) -> None:
    """랙 높이를 줄일 때 이미 장착된 장비가 밖으로 밀려나지 않는지 확인한다."""
    worst = (
        db.query(DcDevice)
        .filter(DcDevice.rack_id == rack.id, DcDevice.position_u.isnot(None), DcDevice.u_height > 0,
                (DcDevice.position_u + DcDevice.u_height - 1) > new_height)
        .order_by((DcDevice.position_u + DcDevice.u_height).desc())
        .first()
    )
    if worst is not None:
        raise DcConflict(
            f"{worst.hostname} 이(가) {u_range_label(worst.position_u, worst.u_height)} 에 있어 "
            f"{rack.name} 을 {new_height}U 로 줄일 수 없습니다",
            code="rack_too_small", column="u_height",
            conflict={"device_id": str(worst.id), "hostname": worst.hostname},
        )


# ── 케이블 ───────────────────────────────────────────────────────────────────

def _interface_label(db: Session, iface: DcInterface) -> str:
    dev = db.get(DcDevice, iface.device_id)
    return f"{dev.hostname if dev else '?'} 의 {iface.name}"


def check_cable_ends(db: Session, *, cable_id: UUID | None, a_id: UUID, b_id: UUID) -> list[str]:
    """양 끝 인터페이스가 존재하고, 서로 다르고, 다른 케이블에 쓰이지 않는지 확인한다.

    반환값은 경고 목록(속도 불일치 — 저장은 허용).
    """
    if a_id == b_id:
        raise DcInvalid("케이블 양 끝이 같은 인터페이스입니다", code="same_interface", column="b_interface")
    a = db.get(DcInterface, a_id)
    b = db.get(DcInterface, b_id)
    if a is None:
        raise DcInvalid("A 쪽 인터페이스를 찾을 수 없습니다", code="interface_not_found", column="a_interface")
    if b is None:
        raise DcInvalid("B 쪽 인터페이스를 찾을 수 없습니다", code="interface_not_found", column="b_interface")
    for column, iface in (("a_interface", a), ("b_interface", b)):
        q = db.query(DcCable).filter(or_(DcCable.a_interface_id == iface.id, DcCable.b_interface_id == iface.id))
        if cable_id is not None:
            q = q.filter(DcCable.id != cable_id)
        used = q.first()
        if used is not None:
            raise DcConflict(
                f"{_interface_label(db, iface)} 에는 이미 케이블 {used.label or str(used.id)[:8]} 이(가) 연결돼 있습니다",
                code="interface_in_use", column=column,
                conflict={"cable_id": str(used.id), "label": used.label, "interface_id": str(iface.id)},
            )
    warnings: list[str] = []
    if a.speed_mbps and b.speed_mbps and a.speed_mbps != b.speed_mbps:
        warnings.append(
            f"속도 불일치: {_interface_label(db, a)} {format_speed(a.speed_mbps)} ↔ "
            f"{_interface_label(db, b)} {format_speed(b.speed_mbps)}"
        )
    return warnings


def cable_for_interface(db: Session, interface_id: UUID) -> DcCable | None:
    return (
        db.query(DcCable)
        .filter(or_(DcCable.a_interface_id == interface_id, DcCable.b_interface_id == interface_id))
        .first()
    )


# ── IPAM ─────────────────────────────────────────────────────────────────────

def parse_network(value: Any, *, column: str = "cidr") -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    try:
        return ipaddress.ip_network(str(value).strip(), strict=True)
    except ValueError as e:
        raise DcInvalid(f"CIDR '{value}' 가 올바르지 않습니다 ({e})", code="bad_cidr", column=column) from e


def parse_address(value: Any, *, column: str = "address") -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    raw = str(value).strip()
    try:
        # "10.0.0.5/26" 처럼 마스크가 붙어 와도 호스트 주소만 취한다.
        return ipaddress.ip_interface(raw).ip
    except ValueError as e:
        raise DcInvalid(f"IP 주소 '{value}' 가 올바르지 않습니다", code="bad_address", column=column) from e


def check_prefix(db: Session, *, prefix_id: UUID | None, vrf_id: UUID, cidr: Any,
                 gateway: Any | None) -> tuple[str, str | None]:
    """같은 VRF 안에서 겹치지 않는지, 게이트웨이가 범위 안인지 확인하고 정규화한 값을 돌려준다."""
    net = parse_network(cidr)
    q = db.query(DcPrefix).filter(DcPrefix.vrf_id == vrf_id)
    if prefix_id is not None:
        q = q.filter(DcPrefix.id != prefix_id)
    for other in q.all():
        other_net = ipaddress.ip_network(str(other.cidr), strict=False)
        if other_net.version == net.version and other_net.overlaps(net):
            raise DcConflict(
                f"{net} 은(는) 같은 VRF 의 {other_net} 과(와) 겹칩니다",
                code="prefix_overlap", column="cidr",
                conflict={"prefix_id": str(other.id), "cidr": str(other_net)},
            )
    gw: str | None = None
    if gateway not in (None, ""):
        gw_addr = parse_address(gateway, column="gateway")
        if gw_addr not in net:
            raise DcInvalid(f"게이트웨이 {gw_addr} 는 {net} 범위 밖입니다", code="gateway_out_of_prefix",
                            column="gateway")
        gw = str(gw_addr)
    if prefix_id is not None:
        # CIDR 을 바꿀 때 이미 배정된 주소가 밖으로 밀려나면 안 된다.
        for ip in db.query(DcIpAddress).filter(DcIpAddress.prefix_id == prefix_id).all():
            if ipaddress.ip_interface(str(ip.address)).ip not in net:
                raise DcConflict(f"배정된 주소 {ip.address} 가 새 범위 {net} 밖입니다",
                                 code="ip_out_of_prefix", column="cidr",
                                 conflict={"ip_address_id": str(ip.id)})
    return str(net), gw


def check_ip(db: Session, *, ip_id: UUID | None, prefix: DcPrefix, address: Any) -> str:
    """주소가 Prefix 범위 안이고(네트워크·브로드캐스트 제외) 같은 VRF 에서 유일한지 확인한다."""
    addr = parse_address(address)
    net = ipaddress.ip_network(str(prefix.cidr), strict=False)
    if addr not in net:
        raise DcInvalid(f"{addr} 는 Prefix {net} 범위 밖입니다", code="ip_out_of_prefix", column="address")
    if net.version == 4 and net.prefixlen < 31 and addr in (net.network_address, net.broadcast_address):
        raise DcInvalid(f"{addr} 는 {net} 의 네트워크·브로드캐스트 주소라 배정할 수 없습니다",
                        code="ip_reserved", column="address")
    q = db.query(DcIpAddress).filter(DcIpAddress.vrf_id == prefix.vrf_id, DcIpAddress.address == str(addr))
    if ip_id is not None:
        q = q.filter(DcIpAddress.id != ip_id)
    if q.first() is not None:
        raise DcConflict(f"{addr} 는 같은 VRF 에 이미 등록돼 있습니다", code="duplicate", column="address")
    return str(addr)


def find_prefix_for(db: Session, vrf_id: UUID, address: Any) -> DcPrefix | None:
    """주소를 포함하는 가장 좁은 Prefix (같은 VRF)."""
    addr = parse_address(address)
    best: tuple[int, DcPrefix] | None = None
    for p in db.query(DcPrefix).filter(DcPrefix.vrf_id == vrf_id).all():
        net = ipaddress.ip_network(str(p.cidr), strict=False)
        if net.version == addr.version and addr in net and (best is None or net.prefixlen > best[0]):
            best = (net.prefixlen, p)
    return best[1] if best else None


def check_asn_target(data: dict[str, Any]) -> None:
    """``target_type`` 에 맞는 대상 컬럼 하나만 채워졌는지 확인한다."""
    t = data.get("target_type")
    filled = {
        "rack": data.get("rack_id") is not None,
        "cluster": data.get("cluster_id") is not None,
        "fabric_tier": bool(data.get("fabric_tier")),
    }
    if t not in filled:
        raise DcInvalid("ASN 대상 종류가 올바르지 않습니다", code="bad_target", column="target_type")
    if not filled[t]:
        need = {"rack": "랙", "cluster": "클러스터", "fabric_tier": "패브릭 계층"}[t]
        raise DcInvalid(f"대상 종류가 {t} 이면 {need}을(를) 지정해야 합니다", code="target_missing", column=t)
    extra = [k for k, v in filled.items() if v and k != t]
    if extra:
        raise DcInvalid(f"대상 종류가 {t} 인데 다른 대상({', '.join(extra)})도 채워져 있습니다",
                        code="target_mixed", column="target_type")
