"""서버 단일 원본 — ``dc_devices`` 와 노드 서버스펙(``node_server_specs``)·인프라 토폴로지(``infra_nodes``) 연결.

원칙(설계 §2): 장비의 신원과 물리 위치는 ``dc_devices`` 한 곳에 쓴다. 다른 두 테이블은 ``device_id`` 로
그 행을 가리키고, 겹치는 항목은 어느 화면에서 고쳐도 이 모듈을 거쳐 같은 값이 된다.

흐름
- 기존 화면에서 저장  → ``sync_spec`` / ``sync_infra_node`` : 이번에 바뀐 항목을 장비에 쓰고 다시 미러.
- DC 인벤토리에서 저장 → ``mirror_to_linked`` : 장비 값을 연결된 행의 구 컬럼에 복사.

미러 규칙
- 장비에 값이 있는 항목은 장비 값이 이긴다. 장비에 값이 없으면(예: 랙 미배정) 기존 자유 입력을 건드리지 않는다
  — DC 인벤토리에 랙을 등록하지 않은 설치에서 기존 화면이 그대로 동작해야 한다.
- 단, DC 인벤토리에서 **이번에 비운** 항목은 연결된 행에서도 비운다(``_dc_changed``).
- ``infra_nodes`` 는 K8s 관점 뷰라 ``hostname``·``cluster_id`` 는 건드리지 않고 랙 이름과 스위치 이름(케이블에서 파생)만 맞춘다.
"""
from __future__ import annotations

import logging
import re
from typing import Any
from uuid import UUID

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.dc_inventory import (
    DEVICE_STATUSES,
    DcCable,
    DcDevice,
    DcHall,
    DcInterface,
    DcRack,
    DcRackRow,
    DcSite,
)
from app.models.infra_node import InfraNode
from app.models.node_server_spec import NodeServerSpec
from app.services.dc_inventory import crud, validation
from app.services.dc_inventory.changelog import Ctx
from app.services.dc_inventory.errors import DcConflict, DcError

logger = logging.getLogger(__name__)

# 노드 서버스펙에서 장비로 넘어가는 항목(스펙 컬럼 이름 기준).
SPEC_IDENTITY_FIELDS = frozenset({
    "hostname", "serial_number", "status", "cluster_id", "node_name", "rack", "rack_unit",
})
INFRA_IDENTITY_FIELDS = frozenset({"hostname", "rack_name"})
_SPEC_STATUSES = {"active", "spare", "maintenance", "decommission"}
_U_RE = re.compile(r"(\d+)")


def parse_rack_unit(value: Any) -> int | None:
    """``"U21-U22"`` · ``"21"`` · ``"U21"`` → 가장 아래 U(21). 해석 못 하면 None."""
    if value in (None, ""):
        return None
    nums = [int(n) for n in _U_RE.findall(str(value))]
    return min(nums) if nums else None


def _location(db: Session, rack: DcRack | None) -> tuple[str | None, str | None]:
    """랙 → (사이트 이름, 홀 이름)."""
    if rack is None:
        return None, None
    row = db.get(DcRackRow, rack.row_id)
    hall = db.get(DcHall, row.hall_id) if row else None
    site = db.get(DcSite, hall.site_id) if hall else None
    return (site.name if site else None), (hall.name if hall else None)


def _tor_names(db: Session, device: DcDevice) -> list[str]:
    """케이블로 직접 또는 패치패널을 한 번 거쳐 연결된 leaf 호스트명."""
    names: set[str] = set()
    iface_ids = [i for (i,) in db.query(DcInterface.id).filter(DcInterface.device_id == device.id).all()]
    if not iface_ids:
        return []
    cables = db.query(DcCable).filter(
        or_(DcCable.a_interface_id.in_(iface_ids), DcCable.b_interface_id.in_(iface_ids))
    ).all()
    own = set(iface_ids)
    for cable in cables:
        far_id = cable.b_interface_id if cable.a_interface_id in own else cable.a_interface_id
        far = db.get(DcInterface, far_id)
        hops = 0
        while far is not None and hops < 4:
            far_dev = db.get(DcDevice, far.device_id)
            if far_dev is None:
                break
            if far_dev.role == "leaf":
                names.add(far_dev.hostname)
                break
            if far_dev.role != "patch" or far.paired_interface_id is None:
                break
            nxt = validation.cable_for_interface(db, far.paired_interface_id)
            if nxt is None:
                break
            far = db.get(DcInterface, nxt.b_interface_id if nxt.a_interface_id == far.paired_interface_id
                         else nxt.a_interface_id)
            hops += 1
    return sorted(names)


# ── 장비 → 연결된 행 ─────────────────────────────────────────────────────────

def mirror_to_linked(db: Session, device: DcDevice) -> None:
    """장비 값을 연결된 서버스펙·인프라 노드의 구 컬럼에 복사한다(같은 트랜잭션, 커밋 없음)."""
    changed: set[str] = getattr(device, "_dc_changed", set()) or set()
    rack = db.get(DcRack, device.rack_id) if device.rack_id is not None else None
    site_name, hall_name = _location(db, rack)
    rack_cleared = "rack_id" in changed and rack is None

    specs = db.query(NodeServerSpec).filter(NodeServerSpec.device_id == device.id).all()
    for spec in specs:
        if spec.hostname != device.hostname:
            clash = db.query(NodeServerSpec.id).filter(
                NodeServerSpec.cluster_id == spec.cluster_id, NodeServerSpec.hostname == device.hostname,
                NodeServerSpec.id != spec.id,
            ).first()
            if clash is None:
                spec.hostname = device.hostname
            else:
                logger.warning("dc mirror: 서버스펙 호스트명 %s → %s 변경 보류(같은 클러스터에 이미 있음)",
                               spec.hostname, device.hostname)
        if device.serial is not None or "serial" in changed:
            spec.serial_number = device.serial
        if device.status in _SPEC_STATUSES:
            spec.status = device.status
        if (device.cluster_id is not None or "cluster_id" in changed) and spec.cluster_id != device.cluster_id:
            clash = db.query(NodeServerSpec.id).filter(
                NodeServerSpec.cluster_id == device.cluster_id, NodeServerSpec.hostname == spec.hostname,
                NodeServerSpec.id != spec.id,
            ).first()
            if clash is None:
                spec.cluster_id = device.cluster_id
            else:
                logger.warning("dc mirror: 서버스펙 %s 클러스터 변경 보류(대상 클러스터에 같은 호스트명이 있음)",
                               spec.hostname)
        if device.k8s_node_name is not None or "k8s_node_name" in changed:
            spec.node_name = device.k8s_node_name
        if rack is not None:
            spec.rack = rack.name
            spec.rack_unit = validation.u_range_label(device.position_u, device.u_height)
            spec.datacenter = site_name
            spec.room = hall_name
        elif rack_cleared:
            spec.rack = None
            spec.rack_unit = None

    nodes = db.query(InfraNode).filter(InfraNode.device_id == device.id).all()
    if nodes:
        tors = _tor_names(db, device)
        for node in nodes:
            if rack is not None:
                node.rack_name = rack.name
            elif rack_cleared:
                node.rack_name = None
            if tors:
                node.switch_name = ", ".join(tors)[:100]
    if specs or nodes:
        db.flush()


def mirror_rack(db: Session, rack_id: UUID) -> None:
    """랙(또는 그 상위 위치) 이름이 바뀌었을 때 랙 안 장비 전체를 다시 미러한다."""
    for device in db.query(DcDevice).filter(DcDevice.rack_id == rack_id).all():
        mirror_to_linked(db, device)


def unlink_device(db: Session, device: DcDevice) -> None:
    """장비 삭제 전에 연결을 끊는다(구 컬럼 값은 그대로 남는다)."""
    db.query(NodeServerSpec).filter(NodeServerSpec.device_id == device.id).update(
        {NodeServerSpec.device_id: None}, synchronize_session=False)
    db.query(InfraNode).filter(InfraNode.device_id == device.id).update(
        {InfraNode.device_id: None}, synchronize_session=False)


# ── 기존 화면 → 장비 ─────────────────────────────────────────────────────────

def _find_device(db: Session, *, device_id: Any, hostname: str, cluster_id: Any) -> DcDevice | None:
    if device_id is not None:
        dev = db.get(DcDevice, device_id)
        if dev is not None:
            return dev
    dev = db.query(DcDevice).filter(DcDevice.hostname == hostname).first()
    if dev is None:
        return None
    # 같은 호스트명이 다른 클러스터에 있으면 다른 서버일 수 있다 — 자동으로 묶지 않는다.
    if dev.cluster_id is not None and cluster_id is not None and dev.cluster_id != cluster_id:
        return None
    return dev


def _hostname_taken_elsewhere(db: Session, hostname: str, cluster_id: Any) -> bool:
    dev = db.query(DcDevice).filter(DcDevice.hostname == hostname).first()
    return dev is not None and dev.cluster_id is not None and cluster_id is not None \
        and dev.cluster_id != cluster_id


def _placement_from_spec(db: Session, spec: NodeServerSpec, fields: set[str],
                         device: DcDevice | None = None) -> dict[str, Any]:
    """서버스펙의 랙 문자열을 장비 배치로 옮긴다. DC 인벤토리에 없는 랙 이름은 자유 입력으로 남긴다.

    서버스펙에 U 가 비어 있다고 장비의 U 를 지우지 않는다 — 같은 랙이면 장비가 아는 U 를 그대로 둔다.
    U 를 비우는 것은 사용자가 이번에 ``rack_unit`` 을 직접 비웠거나(``fields``) 랙이 바뀌었을 때뿐이다.
    """
    data: dict[str, Any] = {}
    if not ({"rack", "rack_unit"} & fields):
        return data
    if spec.rack in (None, ""):
        if "rack" in fields:
            data["rack_id"] = None
            data["position_u"] = None
        return data
    rack = db.query(DcRack).filter(DcRack.name == str(spec.rack).strip()).first()
    if rack is None:
        return data
    data["rack_id"] = rack.id
    position = parse_rack_unit(spec.rack_unit)
    if position is not None:
        data["position_u"] = position
    elif "rack_unit" in fields or device is None or device.rack_id != rack.id:
        data["position_u"] = None
    return data


def sync_spec(db: Session, spec: NodeServerSpec, *, fields: set[str] | None = None,
              actor: Any = None, strict: bool = True) -> DcDevice | None:
    """노드 서버스펙 저장 뒤 호출 — 연결된 장비를 만들거나 찾아 겹치는 항목을 맞춘다.

    ``fields`` 는 이번에 사용자가 건드린 스펙 컬럼(없으면 값이 있는 컬럼 전부).
    ``strict`` 면 제약 위반(U 겹침 등)을 ``DcError`` 로 올리고, 아니면 로그만 남기고 연결만 유지한다.
    커밋하지 않는다.
    """
    touched = set(fields) if fields is not None else {
        f for f in SPEC_IDENTITY_FIELDS if getattr(spec, f, None) not in (None, "")
    }
    ctx = Ctx(actor=actor, source="sync", mirror=False)
    # 호출자가 방금 넣은 행부터 내보낸다 — 그 행 자체의 제약 위반(중복 등)은 예전처럼 호출자가 받는다.
    db.flush()
    try:
        with db.begin_nested():
            device = _find_device(db, device_id=spec.device_id, hostname=spec.hostname, cluster_id=spec.cluster_id)
            if device is None:
                if _hostname_taken_elsewhere(db, spec.hostname, spec.cluster_id):
                    return None  # 호스트명 중복 — 연결 화면에서 사람이 정한다
                serial = spec.serial_number or None
                if serial and db.query(DcDevice.id).filter(DcDevice.serial == serial).first():
                    serial = None
                device = crud.create(db, "devices", {
                    "hostname": spec.hostname, "role": "server",
                    "status": spec.status if spec.status in DEVICE_STATUSES else "active",
                    "serial": serial, "cluster_id": spec.cluster_id, "k8s_node_name": spec.node_name,
                    **_placement_from_spec(db, spec, touched | {"rack", "rack_unit"}),
                }, ctx)
            else:
                data: dict[str, Any] = {}
                if "hostname" in touched:
                    data["hostname"] = spec.hostname
                if "serial_number" in touched:
                    data["serial"] = spec.serial_number or None
                if "status" in touched and spec.status in DEVICE_STATUSES:
                    data["status"] = spec.status
                if "cluster_id" in touched:
                    data["cluster_id"] = spec.cluster_id
                if "node_name" in touched:
                    data["k8s_node_name"] = spec.node_name or None
                data.update(_placement_from_spec(db, spec, touched, device))
                if data:
                    device = crud.update(db, "devices", device.id, data, ctx)
                    device._dc_changed = set(data)
            spec.device_id = device.id
            db.flush()
            mirror_to_linked(db, device)
            return device
    except DcError:
        if strict:
            raise
        logger.warning("dc registry: 서버스펙 %s 동기화 건너뜀", spec.hostname, exc_info=True)
    except Exception:  # noqa: BLE001 — 통합 미러 실패가 기존 화면 저장을 막으면 안 된다
        logger.exception("dc registry: 서버스펙 %s 동기화 실패", spec.hostname)
    return None


def sync_infra_node(db: Session, node: InfraNode, *, fields: set[str] | None = None,
                    actor: Any = None, strict: bool = True) -> DcDevice | None:
    """인프라 토폴로지 노드 저장 뒤 호출 — 장비를 만들거나 찾아 랙 이름을 맞춘다. 커밋하지 않는다."""
    touched = set(fields) if fields is not None else {
        f for f in INFRA_IDENTITY_FIELDS if getattr(node, f, None) not in (None, "")
    }
    ctx = Ctx(actor=actor, source="sync", mirror=False)
    db.flush()  # sync_spec 과 같은 이유
    try:
        with db.begin_nested():
            device = _find_device(db, device_id=node.device_id, hostname=node.hostname, cluster_id=node.cluster_id)
            rack = None
            if node.rack_name not in (None, ""):
                rack = db.query(DcRack).filter(DcRack.name == str(node.rack_name).strip()).first()
            if device is None:
                if _hostname_taken_elsewhere(db, node.hostname, node.cluster_id):
                    return None
                device = crud.create(db, "devices", {
                    "hostname": node.hostname, "role": "server", "status": "active",
                    "cluster_id": node.cluster_id, "k8s_node_name": node.hostname,
                    "rack_id": rack.id if rack is not None else None,
                }, ctx)
            else:
                data: dict[str, Any] = {}
                if device.cluster_id is None:
                    data["cluster_id"] = node.cluster_id
                if "rack_name" in touched:
                    if rack is not None and device.rack_id != rack.id:
                        data["rack_id"] = rack.id
                        data["position_u"] = None
                    elif node.rack_name in (None, "") and device.rack_id is not None:
                        data["rack_id"] = None
                        data["position_u"] = None
                if data:
                    device = crud.update(db, "devices", device.id, data, ctx)
                    device._dc_changed = set(data)
            node.device_id = device.id
            db.flush()
            mirror_to_linked(db, device)
            return device
    except DcError:
        if strict:
            raise
        logger.warning("dc registry: 인프라 노드 %s 동기화 건너뜀", node.hostname, exc_info=True)
    except Exception:  # noqa: BLE001
        logger.exception("dc registry: 인프라 노드 %s 동기화 실패", node.hostname)
    return None


# ── 기존 데이터 연결 (미리보기 → 선택 적용) ──────────────────────────────────

def _cluster_names(db: Session) -> dict[Any, str]:
    return {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}


def link_preview(db: Session) -> dict[str, Any]:
    """아직 연결되지 않은 서버스펙·인프라 노드를 호스트명으로 묶어 4종으로 분류한다. DB 를 바꾸지 않는다."""
    clusters = _cluster_names(db)
    devices = {d.hostname: d for d in db.query(DcDevice).all()}
    racks = {r.id: r.name for r in db.query(DcRack.id, DcRack.name).all()}
    groups: dict[str, dict[str, list[Any]]] = {}
    linked = 0
    for spec in db.query(NodeServerSpec).all():
        if spec.device_id is not None:
            linked += 1
            continue
        groups.setdefault(spec.hostname, {"specs": [], "nodes": []})["specs"].append(spec)
    for node in db.query(InfraNode).all():
        if node.device_id is not None:
            linked += 1
            continue
        groups.setdefault(node.hostname, {"specs": [], "nodes": []})["nodes"].append(node)

    items: list[dict[str, Any]] = []
    counts = {"linkable": 0, "create": 0, "mismatch": 0, "duplicate_hostname": 0}
    for hostname in sorted(groups):
        g = groups[hostname]
        device = devices.get(hostname)
        cluster_ids = {r.cluster_id for r in g["specs"] + g["nodes"] if r.cluster_id is not None}
        if device is not None and device.cluster_id is not None:
            cluster_ids.add(device.cluster_id)
        spec = g["specs"][0] if g["specs"] else None
        node = g["nodes"][0] if g["nodes"] else None
        diffs: list[dict[str, Any]] = []
        if device is not None:
            dev_rack = racks.get(device.rack_id)
            pairs = [
                ("시리얼", spec.serial_number if spec else None, device.serial),
                ("랙", (spec.rack if spec else None) or (node.rack_name if node else None), dev_rack),
                ("U", spec.rack_unit if spec else None, validation.u_range_label(device.position_u, device.u_height)),
            ]
            for label, theirs, ours in pairs:
                if theirs not in (None, "") and ours not in (None, "") and str(theirs).strip() != str(ours):
                    diffs.append({"field": label, "existing": str(theirs), "device": str(ours)})
        if len(cluster_ids) > 1:
            category = "duplicate_hostname"
        elif device is None:
            category = "create"
        elif diffs:
            category = "mismatch"
        else:
            category = "linkable"
        counts[category] += 1
        items.append({
            "hostname": hostname,
            "category": category,
            "spec_count": len(g["specs"]),
            "infra_node_count": len(g["nodes"]),
            "clusters": sorted(clusters.get(c, str(c)) for c in cluster_ids),
            "device_id": str(device.id) if device is not None else None,
            "existing": {
                "serial": spec.serial_number if spec else None,
                "rack": (spec.rack if spec else None) or (node.rack_name if node else None),
                "rack_unit": spec.rack_unit if spec else None,
            },
            "diffs": diffs,
            # 값이 다를 때 기본 선택은 기존 서버스펙 값(설계 결정 4) — 행마다 바꿀 수 있다.
            "default_prefer": "existing",
        })
    return {"linked": linked, "counts": counts, "items": items}


def link_apply(db: Session, selections: list[dict[str, Any]], *, actor: Any, batch_id: str,
               emit: Any = None) -> dict[str, Any]:
    """선택한 호스트명만 연결한다. 항목마다 SAVEPOINT — 한 건 실패가 나머지를 막지 않는다. 커밋은 호출자."""
    def say(level: str, message: str) -> None:
        if emit is not None:
            emit(level, message)

    results: list[dict[str, Any]] = []
    done = failed = skipped = 0
    for sel in selections:
        hostname = str(sel.get("hostname") or "").strip()
        prefer = sel.get("prefer") or "existing"
        if not hostname or sel.get("action") == "skip":
            skipped += 1
            continue
        specs = db.query(NodeServerSpec).filter(
            NodeServerSpec.hostname == hostname, NodeServerSpec.device_id.is_(None)).all()
        nodes = db.query(InfraNode).filter(
            InfraNode.hostname == hostname, InfraNode.device_id.is_(None)).all()
        cluster_ids = {r.cluster_id for r in specs + nodes if r.cluster_id is not None}
        known = db.query(DcDevice).filter(DcDevice.hostname == hostname).first()
        if known is not None and known.cluster_id is not None:
            cluster_ids.add(known.cluster_id)  # 이미 다른 클러스터의 장비로 등록된 호스트명
        try:
            if not specs and not nodes:
                raise DcConflict("연결할 행이 없습니다(이미 연결됐거나 삭제됨)", code="nothing_to_link")
            if len(cluster_ids) > 1:
                raise DcConflict("같은 호스트명이 여러 클러스터에 있어 자동으로 연결할 수 없습니다",
                                 code="duplicate_hostname")
            with db.begin_nested():
                ctx = Ctx(actor=actor, source="link", batch_id=batch_id, mirror=False)
                device = db.query(DcDevice).filter(DcDevice.hostname == hostname).first()
                spec = specs[0] if specs else None
                node = nodes[0] if nodes else None
                created = device is None
                if device is None:
                    serial = (spec.serial_number if spec else None) or None
                    if serial and db.query(DcDevice.id).filter(DcDevice.serial == serial).first():
                        serial = None
                    device = crud.create(db, "devices", {
                        "hostname": hostname, "role": "server",
                        "status": spec.status if spec and spec.status in DEVICE_STATUSES else "active",
                        "serial": serial,
                        "cluster_id": next(iter(cluster_ids), None),
                        "k8s_node_name": (spec.node_name if spec else None) or (hostname if node else None),
                    }, ctx)
                if created or prefer == "existing":
                    data: dict[str, Any] = {}
                    if spec is not None:
                        if spec.serial_number and spec.serial_number != device.serial:
                            data["serial"] = spec.serial_number
                        # U 가 비어 있는 기존 행은 "모름" 이지 "비움" 이 아니다 — rack_unit 을 건드린 것으로 치지 않는다.
                        data.update(_placement_from_spec(db, spec, {"rack"} if spec.rack else set(), device))
                    elif node is not None and node.rack_name:
                        rack = db.query(DcRack).filter(DcRack.name == node.rack_name.strip()).first()
                        if rack is not None:
                            data["rack_id"] = rack.id
                    if device.cluster_id is None and cluster_ids:
                        data["cluster_id"] = next(iter(cluster_ids))
                    if data:
                        device = crud.update(db, "devices", device.id, data, ctx)
                for row in specs + nodes:
                    row.device_id = device.id
                db.flush()
                mirror_to_linked(db, device)
            done += 1
            results.append({"hostname": hostname, "status": "created" if created else "linked",
                            "device_id": str(device.id)})
            say("info", f"{hostname}: {'장비 생성 후 연결' if created else '연결'}")
        except DcError as e:
            failed += 1
            results.append({"hostname": hostname, "status": "error", "error": e.detail})
            say("error", f"{hostname}: {e.detail}")
    return {"linked": done, "failed": failed, "skipped": skipped, "results": results}
