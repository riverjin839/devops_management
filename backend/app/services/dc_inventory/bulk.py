"""화면 안 일괄 작업 — Excel 없이 여러 행을 한 번에 만든다(설계 §5.1.1).

모든 작업은 단일 트랜잭션이다: 하나라도 제약을 어기면 전부 거부한다. ``dry_run`` 이면 같은 경로로
검증만 하고 되돌린다. 커밋·롤백은 여기서 하지 않고 호출자(라우터)가 결과의 ``ok``·``dry_run`` 을 보고 정한다.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Any, Callable
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.dc_inventory import DcDevice, DcDeviceType, DcInterface, DcIpAddress, DcPrefix
from app.services.dc_inventory import crud, validation
from app.services.dc_inventory.changelog import Ctx
from app.services.dc_inventory.errors import DcError, DcInvalid

MAX_BULK = 500
_BRACE_RE = re.compile(r"\{(\d+)\.\.(\d+)\}")
_PORT_RANGE_RE = re.compile(r"^(.*?)(\d+)\s*-\s*(\d+)$")


def expand_hostname_pattern(pattern: str, count: int | None = None) -> list[str]:
    """``node-a-07{01..18}`` → 18개. 자릿수(앞자리 0)는 패턴대로 유지한다.

    중괄호가 없으면 ``count`` 만큼 뒤에 2자리 번호를 붙인다(``node-a-`` + 01, 02, …).
    """
    pattern = (pattern or "").strip()
    if not pattern:
        raise DcInvalid("호스트명 패턴이 비어 있습니다", code="bad_pattern", column="pattern")
    m = _BRACE_RE.search(pattern)
    if m:
        start, end = int(m.group(1)), int(m.group(2))
        if end < start:
            raise DcInvalid("패턴 범위의 끝이 시작보다 작습니다", code="bad_pattern", column="pattern")
        width = len(m.group(1))
        names = [pattern[:m.start()] + str(n).zfill(width) + pattern[m.end():] for n in range(start, end + 1)]
        if count is not None:
            names = names[:count]
    else:
        if not count:
            raise DcInvalid("패턴에 {01..18} 범위가 없으면 개수를 지정해야 합니다", code="bad_pattern",
                            column="count")
        names = [f"{pattern}{str(n).zfill(2)}" for n in range(1, count + 1)]
    if len(names) > MAX_BULK:
        raise DcInvalid(f"한 번에 {MAX_BULK}대까지 만들 수 있습니다", code="too_many", column="pattern")
    return names


def expand_port_range(spec: str) -> list[str]:
    """``Ethernet1/1-18`` → ``Ethernet1/1`` … ``Ethernet1/18``. 범위가 아니면 쉼표로 나눈 이름 목록."""
    out: list[str] = []
    for part in (p.strip() for p in (spec or "").split(",")):
        if not part:
            continue
        m = _PORT_RANGE_RE.match(part)
        if m and int(m.group(3)) >= int(m.group(2)):
            out.extend(f"{m.group(1)}{n}" for n in range(int(m.group(2)), int(m.group(3)) + 1))
        else:
            out.append(part)
    if len(out) > MAX_BULK:
        raise DcInvalid(f"한 번에 {MAX_BULK}개까지 처리할 수 있습니다", code="too_many", column="ports")
    return out


def _run(db: Session, steps: list[tuple[str, Callable[[], Any]]], *, dry_run: bool) -> dict[str, Any]:
    """항목별로 SAVEPOINT 안에서 실행해 오류를 전부 모은다(첫 오류에서 멈추지 않는다)."""
    items: list[dict[str, Any]] = []
    errors = 0
    for label, fn in steps:
        try:
            with db.begin_nested():
                extra = fn() or {}
            items.append({"key": label, "status": "ok", **extra})
        except DcError as e:
            errors += 1
            items.append({"key": label, "status": "error", "error": e.detail, "code": e.code})
    return {"ok": errors == 0, "dry_run": dry_run, "total": len(steps), "errors": errors, "items": items}


def create_devices(db: Session, payload: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """호스트명 패턴 + 시작 U + 간격으로 장비 여러 대를 만든다."""
    names = expand_hostname_pattern(payload["pattern"], payload.get("count"))
    dtype = db.get(DcDeviceType, payload["device_type_id"]) if payload.get("device_type_id") else None
    height = dtype.u_height if dtype is not None else 1
    step = payload.get("step_u") or max(height, 1)
    start = payload.get("start_u")
    base = {k: payload.get(k) for k in ("role", "device_type_id", "rack_id", "face", "status", "cluster_id")
            if payload.get(k) is not None}
    steps = []
    for i, name in enumerate(names):
        data = {**base, "hostname": name,
                "create_interfaces_from_template": payload.get("create_interfaces_from_template", True)}
        if start is not None and payload.get("rack_id") is not None:
            data["position_u"] = start + i * step

        def make(d=data):
            dev = crud.create(db, "devices", d, ctx)
            return {"id": str(dev.id), "u_range": validation.u_range_label(dev.position_u, dev.u_height)}
        steps.append((name, make))
    return _run(db, steps, dry_run=bool(payload.get("dry_run")))


def update_interfaces(db: Session, payload: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """선택한 인터페이스들(또는 장비 + 포트 범위)의 속도·용도·사용 여부를 한 번에 바꾼다."""
    ids: list[UUID] = list(payload.get("interface_ids") or [])
    if payload.get("device_id") and payload.get("ports"):
        names = expand_port_range(payload["ports"])
        found = {i.name: i.id for i in db.query(DcInterface).filter(
            DcInterface.device_id == payload["device_id"], DcInterface.name.in_(names)).all()}
        missing = [n for n in names if n not in found]
        if missing:
            raise DcInvalid(f"장비에 없는 포트: {', '.join(missing[:10])}" + (" …" if len(missing) > 10 else ""),
                            code="port_not_found", column="ports")
        ids.extend(found[n] for n in names)
    if not ids:
        raise DcInvalid("바꿀 인터페이스를 고르세요", code="empty_selection")
    if len(ids) > MAX_BULK:
        raise DcInvalid(f"한 번에 {MAX_BULK}개까지 처리할 수 있습니다", code="too_many")
    change: dict[str, Any] = {}
    if payload.get("speed") not in (None, ""):
        change["speed_mbps"] = validation.parse_speed(payload["speed"])
    for k in ("purpose", "enabled"):
        if payload.get(k) is not None:
            change[k] = payload[k]
    if not change:
        raise DcInvalid("바꿀 값(속도·용도·사용 여부)을 하나 이상 지정하세요", code="empty_change")
    steps = []
    for iid in ids:
        def apply(i=iid):
            obj = crud.update(db, "interfaces", i, dict(change), ctx)
            return {"id": str(obj.id), "name": obj.name}
        steps.append((str(iid), apply))
    return _run(db, steps, dry_run=bool(payload.get("dry_run")))


def create_cables(db: Session, payload: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """포트 범위 대 장비 목록 연결 — A 장비의 n번째 포트를 n번째 B 장비의 같은 이름 포트에 잇는다.

    예: ``leaf-r07-a`` ``Ethernet1/1-18`` ↔ R07 서버 18대의 ``eth0``, 라벨 ``R07-{host}-PA``.
    """
    a_dev = db.query(DcDevice).filter(DcDevice.id == payload["a_device_id"]).first()
    if a_dev is None:
        raise DcInvalid("A 쪽 장비를 찾을 수 없습니다", code="reference_not_found", column="a_device")
    ports = expand_port_range(payload["a_ports"])
    b_ids: list[UUID] = list(payload["b_device_ids"])
    if len(ports) != len(b_ids):
        raise DcInvalid(f"A 쪽 포트 {len(ports)}개와 B 쪽 장비 {len(b_ids)}대의 개수가 다릅니다",
                        code="count_mismatch", column="a_ports")
    b_name = payload["b_interface"]
    pattern = payload.get("label_pattern") or ""
    steps = []
    for port, b_id in zip(ports, b_ids):
        def make(port=port, b_id=b_id):
            b_dev = db.get(DcDevice, b_id)
            if b_dev is None:
                raise DcInvalid("B 쪽 장비를 찾을 수 없습니다", code="reference_not_found", column="b_device")
            a_if = db.query(DcInterface).filter(DcInterface.device_id == a_dev.id, DcInterface.name == port).first()
            b_if = db.query(DcInterface).filter(DcInterface.device_id == b_dev.id, DcInterface.name == b_name).first()
            if a_if is None:
                raise DcInvalid(f"{a_dev.hostname} 에 {port} 포트가 없습니다", code="port_not_found")
            if b_if is None:
                raise DcInvalid(f"{b_dev.hostname} 에 {b_name} 포트가 없습니다", code="port_not_found")
            label = (pattern.replace("{host}", b_dev.hostname).replace("{port}", port.replace("/", "-"))
                     .replace("{a}", a_dev.hostname)) or None
            local = Ctx(actor=ctx.actor, source=ctx.source, batch_id=ctx.batch_id)
            cable = crud.create(db, "cables", {
                "a_interface_id": a_if.id, "b_interface_id": b_if.id, "label": label,
                "status": payload.get("status") or "connected", "cable_type": payload.get("cable_type"),
            }, local)
            return {"id": str(cable.id), "label": label, "from": f"{a_dev.hostname} {port}",
                    "to": f"{b_dev.hostname} {b_name}", "warnings": local.warnings}
        steps.append((port, make))
    return _run(db, steps, dry_run=bool(payload.get("dry_run")))


def assign_ips(db: Session, payload: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """Prefix 의 빈 주소를 순서대로 선택한 인터페이스들에 배정한다."""
    prefix = db.get(DcPrefix, payload["prefix_id"])
    if prefix is None:
        raise DcInvalid("Prefix 를 찾을 수 없습니다", code="reference_not_found", column="prefix")
    ids: list[UUID] = list(payload["interface_ids"])
    if len(ids) > MAX_BULK:
        raise DcInvalid(f"한 번에 {MAX_BULK}개까지 처리할 수 있습니다", code="too_many")
    net = ipaddress.ip_network(str(prefix.cidr), strict=False)
    used = {ipaddress.ip_interface(str(a)).ip for (a,) in
            db.query(DcIpAddress.address).filter(DcIpAddress.vrf_id == prefix.vrf_id).all()}
    if prefix.gateway is not None:
        used.add(ipaddress.ip_interface(str(prefix.gateway)).ip)
    start_at = payload.get("start_address")
    floor = validation.parse_address(start_at, column="start_address") if start_at else None
    free = (h for h in net.hosts() if h not in used and (floor is None or h >= floor))
    steps = []
    for iid in ids:
        addr = next(free, None)

        def make(iid=iid, addr=addr):
            if addr is None:
                raise DcInvalid(f"Prefix {net} 에 빈 주소가 부족합니다", code="prefix_full")
            ip = crud.create(db, "ip-addresses", {
                "prefix_id": prefix.id, "address": str(addr), "interface_id": iid,
                "role": payload.get("role") or "primary",
            }, ctx)
            return {"id": str(ip.id), "address": str(addr)}
        steps.append((str(iid), make))
    return _run(db, steps, dry_run=bool(payload.get("dry_run")))
