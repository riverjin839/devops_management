"""DC 토폴로지 그래프 — 구간 · 클러스터 · 패브릭 계층(FA 코어 → super-spine → spine → leaf) · 랙 · 서버.

화면(/dc-inventory ▸ 토폴로지)이 워크플로 보드처럼 끌어서 배치하고 우클릭으로 고치는 캔버스의 데이터다.
별도 사본을 만들지 않고 인벤토리 테이블에서 매번 파생한다 — 그래야 Excel 일괄 등록·다른 화면의 수정이
곧바로 그림에 반영된다. 사용자가 정하는 것은 ① 논리 연결(``dc_links``) ② 노드 위치(``dc_canvas_positions``)뿐이다.

``ontology`` 블록은 같은 내용을 "개체 + 관계(주어 → 술어 → 목적어)" 로 편 것이다:
    site —contains→ zone —contains→ rack —contains→ device
    zone —hosts→ cluster,  device —member_of→ cluster,  device(상위) —uplink_to→ device(하위)
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.dc_inventory import (
    FABRIC_TIER_RANK,
    DcCable,
    DcCanvasPosition,
    DcDevice,
    DcHall,
    DcInterface,
    DcLink,
    DcRack,
    DcRackRow,
    DcSite,
    DcZoneCluster,
)
from app.services.dc_inventory import validation


def build(db: Session) -> dict[str, Any]:
    sites = db.query(DcSite).order_by(DcSite.name).all()
    halls = db.query(DcHall).order_by(DcHall.zone_no, DcHall.name).all()
    rows = {r.id: r for r in db.query(DcRackRow).all()}
    racks = db.query(DcRack).order_by(DcRack.name).all()
    devices = db.query(DcDevice).order_by(DcDevice.hostname).all()
    clusters = {c.id: c for c in db.query(Cluster).all()}
    positions = {(p.object_type, p.object_id): p for p in db.query(DcCanvasPosition).all()}

    def pos(kind: str, id_: UUID) -> dict[str, Any]:
        p = positions.get((kind, id_))
        return {"x": p.x, "y": p.y, "pinned": True} if p else {"x": None, "y": None, "pinned": False}

    zone_of_rack = {r.id: (rows[r.row_id].hall_id if r.row_id in rows else None) for r in racks}
    rack_by_id = {r.id: r for r in racks}

    # 구간 ↔ 클러스터
    zone_clusters: dict[UUID, list[dict[str, Any]]] = {}
    for zc in db.query(DcZoneCluster).all():
        c = clusters.get(zc.cluster_id)
        if c is None:
            continue
        zone_clusters.setdefault(zc.hall_id, []).append({
            "link_id": str(zc.id), "cluster_id": str(c.id), "name": c.name,
            "status": getattr(c.status, "value", c.status), "note": zc.note,
        })

    by_rack: dict[UUID, list[DcDevice]] = {}
    for d in devices:
        if d.rack_id is not None:
            by_rack.setdefault(d.rack_id, []).append(d)

    zones_out = []
    for h in halls:
        zone_racks = [r for r in racks if zone_of_rack.get(r.id) == h.id]
        zones_out.append({
            "id": str(h.id), "site_id": str(h.site_id), "name": h.name, "zone_no": h.zone_no,
            "description": h.description, "version": h.version,
            "clusters": sorted(zone_clusters.get(h.id, []), key=lambda c: c["name"]),
            "rack_count": len(zone_racks),
            "device_count": sum(len(by_rack.get(r.id, [])) for r in zone_racks),
        })

    fabric_out = []
    for d in devices:
        if d.role not in FABRIC_TIER_RANK:
            continue
        rack = rack_by_id.get(d.rack_id)
        zone_id = zone_of_rack.get(d.rack_id) if d.rack_id else None
        fabric_out.append({
            "id": str(d.id), "hostname": d.hostname, "role": d.role, "tier": FABRIC_TIER_RANK[d.role],
            "status": d.status, "rack_id": str(d.rack_id) if d.rack_id else None,
            "rack_name": rack.name if rack else None, "zone_id": str(zone_id) if zone_id else None,
            "cluster_id": str(d.cluster_id) if d.cluster_id else None, "version": d.version,
            **pos("device", d.id),
        })

    racks_out = []
    for r in racks:
        members = sorted(by_rack.get(r.id, []),
                         key=lambda d: (-(d.position_u or 0), d.hostname))
        zone_id = zone_of_rack.get(r.id)
        row = rows.get(r.row_id)
        racks_out.append({
            "id": str(r.id), "name": r.name, "rack_no": r.rack_no, "row_id": str(r.row_id),
            "row_name": row.name if row else None, "zone_id": str(zone_id) if zone_id else None,
            "u_height": r.u_height, "version": r.version,
            "used_u": sum(d.u_height for d in members if d.position_u is not None),
            "devices": [{
                "id": str(d.id), "hostname": d.hostname, "role": d.role, "status": d.status,
                "position_u": d.position_u, "u_height": d.u_height, "face": d.face,
                "u_range": validation.u_range_label(d.position_u, d.u_height),
                "cluster_id": str(d.cluster_id) if d.cluster_id else None,
            } for d in members],
            **pos("rack", r.id),
        })

    # 패브릭 연결 — 논리 연결 + 케이블에서 파생한 장비 쌍
    fabric_ids = {d.id for d in devices if d.role in FABRIC_TIER_RANK}
    role_of = {d.id: d.role for d in devices}
    edges: dict[tuple[UUID, UUID], dict[str, Any]] = {}

    def edge(a: UUID, b: UUID) -> dict[str, Any] | None:
        ra, rb = FABRIC_TIER_RANK.get(role_of.get(a)), FABRIC_TIER_RANK.get(role_of.get(b))
        if ra is None or rb is None or ra == rb:
            return None
        upper, lower = (a, b) if ra < rb else (b, a)
        return edges.setdefault((upper, lower), {
            "upper_id": str(upper), "lower_id": str(lower), "link_id": None, "note": None, "cable_count": 0,
        })

    for link in db.query(DcLink).all():
        e = edge(link.upper_device_id, link.lower_device_id)
        if e is not None:
            e["link_id"] = str(link.id)
            e["note"] = link.note
    if fabric_ids:
        iface_dev = dict(db.query(DcInterface.id, DcInterface.device_id)
                         .filter(DcInterface.device_id.in_(fabric_ids)).all())
        if iface_dev:
            for cable in db.query(DcCable).filter(
                DcCable.a_interface_id.in_(iface_dev), DcCable.b_interface_id.in_(iface_dev)
            ).all():
                e = edge(iface_dev[cable.a_interface_id], iface_dev[cable.b_interface_id])
                if e is not None:
                    e["cable_count"] += 1
    edges_out = [{**e, "kind": "both" if e["link_id"] and e["cable_count"] else
                  ("logical" if e["link_id"] else "cable")} for e in edges.values()]

    unracked = [{"id": str(d.id), "hostname": d.hostname, "role": d.role, "status": d.status}
                for d in devices if d.rack_id is None and d.role not in FABRIC_TIER_RANK]

    # 온톨로지 뷰 — 개체와 관계
    entities = (
        [{"id": str(s.id), "type": "site", "name": s.name} for s in sites]
        + [{"id": z["id"], "type": "zone", "name": z["name"]} for z in zones_out]
        + [{"id": str(r.id), "type": "rack", "name": r.name} for r in racks]
        + [{"id": str(d.id), "type": d.role, "name": d.hostname} for d in devices]
    )
    used_clusters = {c["cluster_id"] for z in zones_out for c in z["clusters"]} | {
        str(d.cluster_id) for d in devices if d.cluster_id}
    entities += [{"id": cid, "type": "cluster", "name": clusters[UUID(cid)].name}
                 for cid in sorted(used_clusters) if UUID(cid) in clusters]
    rels: list[dict[str, str]] = []
    rels += [{"source": str(h.site_id), "type": "contains", "target": str(h.id)} for h in halls]
    rels += [{"source": str(zone_of_rack[r.id]), "type": "contains", "target": str(r.id)}
             for r in racks if zone_of_rack.get(r.id)]
    rels += [{"source": str(d.rack_id), "type": "contains", "target": str(d.id)} for d in devices if d.rack_id]
    rels += [{"source": z["id"], "type": "hosts", "target": c["cluster_id"]} for z in zones_out for c in z["clusters"]]
    rels += [{"source": str(d.id), "type": "member_of", "target": str(d.cluster_id)} for d in devices if d.cluster_id]
    rels += [{"source": e["upper_id"], "type": "uplink_to", "target": e["lower_id"]} for e in edges_out]

    return {
        "sites": [{"id": str(s.id), "name": s.name, "description": s.description, "version": s.version}
                  for s in sites],
        "zones": zones_out,
        "fabric": fabric_out,
        "racks": racks_out,
        "edges": edges_out,
        "unracked": unracked,
        "ontology": {"entities": entities, "relationships": rels},
    }


def save_positions(db: Session, items: list[dict[str, Any]]) -> int:
    """끌어 놓은 노드 위치 저장(upsert). 커밋은 호출자."""
    existing = {(p.object_type, p.object_id): p for p in db.query(DcCanvasPosition).all()}
    for item in items:
        key = (item["object_type"], item["object_id"])
        row = existing.get(key)
        if row is None:
            row = DcCanvasPosition(object_type=item["object_type"], object_id=item["object_id"],
                                   x=item["x"], y=item["y"])
            db.add(row)
            existing[key] = row
        else:
            row.x, row.y = item["x"], item["y"]
    db.flush()
    return len(items)


def reset_positions(db: Session) -> int:
    """저장된 위치를 모두 지워 자동 배치로 되돌린다. 커밋은 호출자."""
    n = db.query(DcCanvasPosition).delete(synchronize_session=False)
    db.flush()
    return n
