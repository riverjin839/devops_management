"""DC 인벤토리 공통 CRUD — 제약 검증 + 변경 이력을 한 경로로 묶는다.

- 여기 함수들은 **커밋하지 않는다**(``flush`` 까지). 라우터·일괄 작업·일괄 등록이 트랜잭션 경계를 정한다.
- 화면(API)·일괄 작업·Excel 일괄 등록이 모두 이 경로를 쓰므로 검증 결과가 어디서나 같다.
- 리소스별 차이는 ``RESOURCES`` 의 ``prepare``(저장 전 검증·정규화) / ``after``(저장 뒤 후처리) /
  ``guard_delete``(삭제 가능 여부) 훅으로 표현한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable
from uuid import UUID

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.dc_inventory import (
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
from app.services.dc_inventory import changelog, validation
from app.services.dc_inventory.changelog import Ctx
from app.services.dc_inventory.errors import DcConflict, DcInvalid, DcNotFound

Prepare = Callable[[Session, dict[str, Any], Any, Ctx], None]
After = Callable[[Session, Any, bool, dict[str, Any], Ctx], None]
Guard = Callable[[Session, Any], None]


@dataclass
class Resource:
    key: str                      # URL 조각 (예: "racks")
    model: type
    object_type: str              # 변경 이력의 object_type
    label: str                    # 사용자에게 보이는 이름
    repr_field: str = "name"
    unique: tuple[tuple[str, ...], ...] = ()
    children: tuple[tuple[type, str, str], ...] = ()   # (모델, FK 컬럼, 이름) — 있으면 삭제 거부
    filters: tuple[str, ...] = ()
    search: tuple[str, ...] = ()
    order: tuple[str, ...] = ("name",)
    prepare: Prepare | None = None
    after: After | None = None
    guard_delete: Guard | None = None
    options: tuple[str, ...] = field(default_factory=tuple)  # 모델 컬럼이 아닌 생성 옵션


def _need(db: Session, model: type, id_: Any, label: str, column: str) -> Any:
    obj = db.get(model, id_) if id_ is not None else None
    if obj is None:
        raise DcInvalid(f"{label}을(를) 찾을 수 없습니다", code="reference_not_found", column=column)
    return obj


def _merged(data: dict[str, Any], existing: Any, name: str) -> Any:
    """수정 시 이번에 안 보낸 값은 기존 값을 본다."""
    if name in data:
        return data[name]
    return getattr(existing, name, None) if existing is not None else None


# ── 리소스별 훅 ──────────────────────────────────────────────────────────────

def _prep_hall(db, data, existing, ctx):
    if "site_id" in data:
        _need(db, DcSite, data["site_id"], "사이트", "site")


def _prep_row(db, data, existing, ctx):
    if "hall_id" in data:
        _need(db, DcHall, data["hall_id"], "홀", "hall")


def _prep_rack(db, data, existing, ctx):
    if "row_id" in data:
        _need(db, DcRackRow, data["row_id"], "랙 열", "row")
    if existing is not None and "u_height" in data and data["u_height"] is not None \
            and data["u_height"] < existing.u_height:
        validation.check_rack_resize(db, existing, data["u_height"])


def _after_rack(db, obj, created, opts, ctx):
    if not created and ctx.mirror:
        from app.services.dc_inventory import device_registry
        device_registry.mirror_rack(db, obj.id)


def _after_location(db, obj, created, opts, ctx):
    """사이트·홀 이름이 바뀌면 그 아래 장비에 연결된 서버스펙의 위치 문자열도 맞춘다."""
    if created or not ctx.mirror:
        return
    from app.services.dc_inventory import device_registry
    q = db.query(DcRack.id).join(DcRackRow, DcRack.row_id == DcRackRow.id)
    if isinstance(obj, DcHall):
        q = q.filter(DcRackRow.hall_id == obj.id)
    else:
        q = q.join(DcHall, DcRackRow.hall_id == DcHall.id).filter(DcHall.site_id == obj.id)
    for (rack_id,) in q.all():
        device_registry.mirror_rack(db, rack_id)


def _prep_device(db, data, existing, ctx):
    if data.get("device_type_id") is not None and (
        existing is None or data["device_type_id"] != existing.device_type_id
    ):
        dtype = _need(db, DcDeviceType, data["device_type_id"], "장비 종류", "device_type")
        data["u_height"] = dtype.u_height
        data["is_full_depth"] = dtype.is_full_depth
    if data.get("cluster_id") is not None:
        _need(db, Cluster, data["cluster_id"], "클러스터", "cluster")
    if existing is not None and "rack_id" in data and data["rack_id"] is None and "position_u" not in data:
        data["position_u"] = None  # 랙에서 빼면 U 도 비운다
    placement = ("rack_id", "position_u", "u_height", "is_full_depth", "face")
    if existing is None or any(k in data for k in placement):
        validation.check_placement(
            db,
            device_id=existing.id if existing is not None else None,
            hostname=_merged(data, existing, "hostname") or "",
            rack_id=_merged(data, existing, "rack_id"),
            position_u=_merged(data, existing, "position_u"),
            u_height=_merged(data, existing, "u_height") if _merged(data, existing, "u_height") is not None else 1,
            is_full_depth=_merged(data, existing, "is_full_depth") is not False,
            face=_merged(data, existing, "face") or "front",
        )


def expand_interface_templates(templates: Any) -> list[dict[str, Any]]:
    """장비 종류의 인터페이스 템플릿을 개별 포트 목록으로 편다.

    항목은 ``{name, speed_mbps, purpose}`` 또는 범위형
    ``{pattern: "Ethernet1/{n}", start: 1, count: 48, speed_mbps, purpose}``.
    """
    out: list[dict[str, Any]] = []
    for item in templates or []:
        if not isinstance(item, dict):
            continue
        base = {"speed_mbps": item.get("speed_mbps"), "purpose": item.get("purpose") or "other"}
        if item.get("pattern"):
            start = int(item.get("start", 1))
            for n in range(start, start + int(item.get("count", 1))):
                out.append({"name": str(item["pattern"]).replace("{n}", str(n)), **base})
        elif item.get("name"):
            out.append({"name": str(item["name"]), **base})
    return out


def _after_device(db, obj, created, opts, ctx):
    if created and opts.get("create_interfaces_from_template") and obj.device_type_id is not None:
        dtype = db.get(DcDeviceType, obj.device_type_id)
        for spec in expand_interface_templates(dtype.interface_templates if dtype else None):
            create(db, "interfaces", {"device_id": obj.id, **spec}, ctx)
    if ctx.mirror:
        from app.services.dc_inventory import device_registry
        device_registry.mirror_to_linked(db, obj)


def _guard_device(db, obj):
    cabled = (
        db.query(func.count(DcCable.id))
        .join(DcInterface, or_(DcCable.a_interface_id == DcInterface.id, DcCable.b_interface_id == DcInterface.id))
        .filter(DcInterface.device_id == obj.id)
        .scalar()
    )
    if cabled:
        raise DcConflict(f"{obj.hostname} 에 케이블 {cabled}개가 연결돼 있어 삭제할 수 없습니다. 케이블을 먼저 지우세요.",
                         code="has_children")


def _prep_interface(db, data, existing, ctx):
    device_id = _merged(data, existing, "device_id")
    if existing is None:
        _need(db, DcDevice, device_id, "장비", "device")
    elif "device_id" in data and data["device_id"] != existing.device_id:
        raise DcInvalid("인터페이스를 다른 장비로 옮길 수 없습니다", code="immutable", column="device")
    for col, label in (("paired_interface_id", "짝 포트"), ("parent_interface_id", "부모 인터페이스")):
        if data.get(col) is None:
            continue
        other = _need(db, DcInterface, data[col], label, col)
        if other.device_id != device_id:
            raise DcInvalid(f"{label}는 같은 장비의 인터페이스여야 합니다", code="other_device", column=col)
        if existing is not None and other.id == existing.id:
            raise DcInvalid(f"{label}로 자기 자신을 지정할 수 없습니다", code="self_reference", column=col)


def _after_interface(db, obj, created, opts, ctx):
    """짝 포트는 양방향으로 맞춘다 (A→B 를 걸면 B→A 도 건다, 예전 짝은 푼다)."""
    stale = db.query(DcInterface).filter(
        DcInterface.paired_interface_id == obj.id, DcInterface.id != (obj.paired_interface_id or obj.id)
    ).all()
    for other in stale:
        if other.id != obj.id:
            other.paired_interface_id = None
    if obj.paired_interface_id is not None:
        peer = db.get(DcInterface, obj.paired_interface_id)
        if peer is not None and peer.paired_interface_id != obj.id:
            peer.paired_interface_id = obj.id
    db.flush()


def _guard_interface(db, obj):
    cable = validation.cable_for_interface(db, obj.id)
    if cable is not None:
        raise DcConflict(f"{obj.name} 에 케이블 {cable.label or ''} 이(가) 연결돼 있어 삭제할 수 없습니다",
                         code="has_children")


def _prep_cable(db, data, existing, ctx):
    a_id = _merged(data, existing, "a_interface_id")
    b_id = _merged(data, existing, "b_interface_id")
    if existing is None or "a_interface_id" in data or "b_interface_id" in data:
        ctx.warnings.extend(validation.check_cable_ends(
            db, cable_id=existing.id if existing is not None else None, a_id=a_id, b_id=b_id))


def _prep_prefix(db, data, existing, ctx):
    vrf_id = _merged(data, existing, "vrf_id")
    _need(db, DcVrf, vrf_id, "VRF", "vrf")
    if data.get("rack_id") is not None:
        _need(db, DcRack, data["rack_id"], "랙", "rack")
    if existing is None or any(k in data for k in ("cidr", "gateway", "vrf_id")):
        cidr, gw = validation.check_prefix(
            db, prefix_id=existing.id if existing is not None else None, vrf_id=vrf_id,
            cidr=_merged(data, existing, "cidr"), gateway=_merged(data, existing, "gateway"))
        if existing is None or "cidr" in data:
            data["cidr"] = cidr
        if "gateway" in data:
            data["gateway"] = gw


def _prep_ip(db, data, existing, ctx):
    prefix = _need(db, DcPrefix, _merged(data, existing, "prefix_id"), "Prefix", "prefix")
    if data.get("interface_id") is not None:
        _need(db, DcInterface, data["interface_id"], "인터페이스", "interface")
    if existing is None or "address" in data or "prefix_id" in data:
        addr = validation.check_ip(db, ip_id=existing.id if existing is not None else None, prefix=prefix,
                                   address=_merged(data, existing, "address"))
        data["address"] = addr
    data["vrf_id"] = prefix.vrf_id


def _prep_asn(db, data, existing, ctx):
    merged = {k: _merged(data, existing, k) for k in ("target_type", "rack_id", "cluster_id", "fabric_tier")}
    validation.check_asn_target(merged)
    if data.get("rack_id") is not None:
        _need(db, DcRack, data["rack_id"], "랙", "rack")
    if data.get("cluster_id") is not None:
        _need(db, Cluster, data["cluster_id"], "클러스터", "cluster")


RESOURCES: dict[str, Resource] = {r.key: r for r in (
    Resource("sites", DcSite, "site", "사이트", unique=(("name",),),
             children=((DcHall, "site_id", "홀"),), search=("name",), after=_after_location),
    Resource("halls", DcHall, "hall", "홀", unique=(("site_id", "name"),),
             children=((DcRackRow, "hall_id", "랙 열"),), filters=("site_id",), search=("name",),
             prepare=_prep_hall, after=_after_location),
    Resource("rack-rows", DcRackRow, "rack_row", "랙 열", unique=(("hall_id", "name"),),
             children=((DcRack, "row_id", "랙"),), filters=("hall_id",), search=("name",),
             order=("sort_order", "name"), prepare=_prep_row),
    Resource("racks", DcRack, "rack", "랙", unique=(("name",), ("rack_no",)),
             children=((DcDevice, "rack_id", "장비"),), filters=("row_id", "status"), search=("name",),
             order=("position_in_row", "name"), prepare=_prep_rack, after=_after_rack),
    Resource("device-types", DcDeviceType, "device_type", "장비 종류", repr_field="model",
             unique=(("model",),), children=((DcDevice, "device_type_id", "장비"),),
             search=("model", "vendor"), order=("model",)),
    Resource("devices", DcDevice, "device", "장비", repr_field="hostname",
             unique=(("hostname",), ("serial",)),
             filters=("rack_id", "role", "status", "cluster_id", "device_type_id"),
             search=("hostname", "serial", "asset_tag"), order=("hostname",),
             prepare=_prep_device, after=_after_device, guard_delete=_guard_device,
             options=("create_interfaces_from_template",)),
    Resource("interfaces", DcInterface, "interface", "인터페이스", unique=(("device_id", "name"),),
             filters=("device_id", "purpose"), search=("name",), order=("device_id", "name"),
             prepare=_prep_interface, after=_after_interface, guard_delete=_guard_interface),
    Resource("cables", DcCable, "cable", "케이블", repr_field="label", unique=(("label",),),
             filters=("status", "cable_type"), search=("label",), order=("label",), prepare=_prep_cable),
    Resource("vrfs", DcVrf, "vrf", "VRF", unique=(("name",),),
             children=((DcPrefix, "vrf_id", "Prefix"),), search=("name",)),
    Resource("prefixes", DcPrefix, "prefix", "Prefix", repr_field="cidr", unique=(("vrf_id", "cidr"),),
             children=((DcIpAddress, "prefix_id", "IP 주소"),), filters=("vrf_id", "rack_id", "purpose"),
             order=("cidr",), prepare=_prep_prefix),
    Resource("ip-addresses", DcIpAddress, "ip_address", "IP 주소", repr_field="address",
             filters=("vrf_id", "prefix_id", "interface_id", "role"), search=("dns_name",),
             order=("address",), prepare=_prep_ip),
    Resource("asns", DcAsn, "asn", "ASN", repr_field="number", unique=(("number",),),
             filters=("target_type", "rack_id", "cluster_id"), order=("number",), prepare=_prep_asn),
)}

_UNIQUE_LABELS = {
    "name": "이름", "hostname": "호스트명", "serial": "시리얼", "model": "모델명", "label": "라벨",
    "rack_no": "랙 번호", "number": "ASN 번호", "cidr": "CIDR",
}


def resource(key: str) -> Resource:
    try:
        return RESOURCES[key]
    except KeyError as e:
        raise DcNotFound(f"알 수 없는 리소스: {key}") from e


def _repr(res: Resource, obj: Any) -> str:
    v = getattr(obj, res.repr_field, None)
    return str(v) if v not in (None, "") else str(obj.id)[:8]


def _check_unique(db: Session, res: Resource, data: dict[str, Any], existing: Any) -> None:
    for cols in res.unique:
        if existing is not None and not any(c in data for c in cols):
            continue
        values = {c: _merged(data, existing, c) for c in cols}
        if any(v is None or v == "" for v in values.values()):
            continue
        q = db.query(res.model)
        for c, v in values.items():
            q = q.filter(getattr(res.model, c) == v)
        if existing is not None:
            q = q.filter(res.model.id != existing.id)
        other = q.first()
        if other is not None:
            col = cols[-1]
            raise DcConflict(
                f"{_UNIQUE_LABELS.get(col, col)} '{values[col]}' 은(는) 이미 있는 {res.label}입니다",
                code="duplicate", column=col, conflict={"id": str(other.id)},
            )


def _columns(res: Resource) -> set[str]:
    return {c.key for c in res.model.__table__.columns} - {"id", "version", "created_at", "updated_at"}


def _flush(db: Session, res: Resource) -> None:
    try:
        db.flush()
    except IntegrityError as e:  # 검증을 통과했는데 DB 제약에 걸림 — 동시 요청 경합 등
        msg = str(getattr(e, "orig", e)).split("\n")[0]
        code = "u_overlap" if "dc_devices_no_u_overlap" in msg else "constraint"
        raise DcConflict(f"{res.label} 저장이 DB 제약에 막혔습니다: {msg}", code=code) from e


def get(db: Session, key: str, id_: UUID) -> Any:
    res = resource(key)
    obj = db.get(res.model, id_)
    if obj is None:
        raise DcNotFound(f"{res.label}을(를) 찾을 수 없습니다")
    return obj


def create(db: Session, key: str, data: dict[str, Any], ctx: Ctx) -> Any:
    res = resource(key)
    data = dict(data)
    opts = {k: data.pop(k) for k in res.options if k in data}
    data = {k: v for k, v in data.items() if k in _columns(res)}
    _check_unique(db, res, data, None)
    if res.prepare:
        res.prepare(db, data, None, ctx)
    obj = res.model(**data)
    db.add(obj)
    _flush(db, res)
    changelog.record(db, object_type=res.object_type, obj=obj, repr_=_repr(res, obj), action="create",
                     before=None, ctx=ctx)
    if res.after:
        res.after(db, obj, True, opts, ctx)
    return obj


def update(db: Session, key: str, id_: UUID, data: dict[str, Any], ctx: Ctx, *,
           version: int | None = None) -> Any:
    """``data`` 에 있는 키만 바꾼다. ``version`` 을 주면 낙관적 잠금을 확인한다."""
    res = resource(key)
    obj = get(db, key, id_)
    if version is not None and obj.version != version:
        raise DcConflict("다른 사용자가 먼저 수정했습니다. 새로 고친 뒤 다시 시도하세요.",
                         code="version_conflict", conflict={"current_version": obj.version})
    data = {k: v for k, v in data.items() if k in _columns(res)}
    data = {k: v for k, v in data.items() if getattr(obj, k) != v}
    if not data:
        return obj
    before = changelog.snapshot(obj)
    _check_unique(db, res, data, obj)
    if res.prepare:
        res.prepare(db, data, obj, ctx)
    for k, v in data.items():
        setattr(obj, k, v)
    obj.version = (obj.version or 1) + 1
    _flush(db, res)
    changelog.record(db, object_type=res.object_type, obj=obj, repr_=_repr(res, obj), action="update",
                     before=before, ctx=ctx)
    # 이번에 바뀐 컬럼 — device_registry 미러가 "이번에 비운 값"을 구분하는 데 쓴다.
    obj._dc_changed = set(data)
    if res.after:
        res.after(db, obj, False, {}, ctx)
    return obj


def delete(db: Session, key: str, id_: UUID, ctx: Ctx) -> None:
    res = resource(key)
    obj = get(db, key, id_)
    for model, fk, label in res.children:
        n = db.query(func.count(model.id)).filter(getattr(model, fk) == obj.id).scalar()
        if n:
            raise DcConflict(f"{label} {n}개가 남아 있어 {res.label} '{_repr(res, obj)}' 을(를) 삭제할 수 없습니다",
                             code="has_children")
    if res.guard_delete:
        res.guard_delete(db, obj)
    before = changelog.snapshot(obj)
    changelog.record(db, object_type=res.object_type, obj=obj, repr_=_repr(res, obj), action="delete",
                     before=before, ctx=ctx)
    if key == "devices":
        from app.services.dc_inventory import device_registry
        device_registry.unlink_device(db, obj)
    db.delete(obj)
    _flush(db, res)


def list_(db: Session, key: str, *, filters: dict[str, Any] | None = None, q: str | None = None,
          limit: int = 200, offset: int = 0, extra: Iterable[Any] = ()) -> tuple[list[Any], int]:
    res = resource(key)
    query = db.query(res.model)
    for cond in extra:
        query = query.filter(cond)
    for name, value in (filters or {}).items():
        if value in (None, "") or name not in res.filters:
            continue
        query = query.filter(getattr(res.model, name) == value)
    if q and res.search:
        like = f"%{q.strip()}%"
        query = query.filter(or_(*[getattr(res.model, c).ilike(like) for c in res.search]))
    total = query.count()
    items = query.order_by(*[getattr(res.model, c) for c in res.order]).offset(offset).limit(limit).all()
    return items, total


# ── 직렬화 ───────────────────────────────────────────────────────────────────

class Names:
    """목록 직렬화용 이름 조회 캐시 — 행마다 쿼리하지 않도록 id 를 모아 한 번에 읽는다."""

    def __init__(self, db: Session):
        self.db = db
        self._cache: dict[tuple[type, Any], Any] = {}

    def preload(self, model: type, ids: Iterable[Any]) -> None:
        want = {i for i in ids if i is not None and (model, i) not in self._cache}
        if not want:
            return
        for obj in self.db.query(model).filter(model.id.in_(want)).all():
            self._cache[(model, obj.id)] = obj
        for i in want:
            self._cache.setdefault((model, i), None)

    def get(self, model: type, id_: Any) -> Any:
        if id_ is None:
            return None
        if (model, id_) not in self._cache:
            self._cache[(model, id_)] = self.db.get(model, id_)
        return self._cache[(model, id_)]

    def attr(self, model: type, id_: Any, name: str) -> Any:
        obj = self.get(model, id_)
        return getattr(obj, name, None) if obj is not None else None


def _base(obj: Any) -> dict[str, Any]:
    out = changelog.snapshot(obj)
    out["version"] = obj.version
    out["updated_at"] = obj.updated_at.isoformat() if obj.updated_at else None
    return out


def serialize_many(db: Session, key: str, objs: list[Any], names: Names | None = None) -> list[dict[str, Any]]:
    """행 목록 → 응답 dict. 화면이 바로 쓰도록 참조 이름을 붙인다."""
    n = names or Names(db)
    if key == "halls":
        n.preload(DcSite, [o.site_id for o in objs])
    elif key == "rack-rows":
        n.preload(DcHall, [o.hall_id for o in objs])
    elif key == "racks":
        n.preload(DcRackRow, [o.row_id for o in objs])
    elif key == "devices":
        n.preload(DcRack, [o.rack_id for o in objs])
        n.preload(DcDeviceType, [o.device_type_id for o in objs])
        n.preload(Cluster, [o.cluster_id for o in objs])
    elif key == "interfaces":
        n.preload(DcDevice, [o.device_id for o in objs])
        n.preload(DcInterface, [o.paired_interface_id for o in objs] + [o.parent_interface_id for o in objs])
    elif key == "cables":
        n.preload(DcInterface, [o.a_interface_id for o in objs] + [o.b_interface_id for o in objs])
        ifaces = [n.get(DcInterface, i) for o in objs for i in (o.a_interface_id, o.b_interface_id)]
        n.preload(DcDevice, [i.device_id for i in ifaces if i is not None])
    elif key == "prefixes":
        n.preload(DcVrf, [o.vrf_id for o in objs])
        n.preload(DcRack, [o.rack_id for o in objs])
    elif key == "ip-addresses":
        n.preload(DcVrf, [o.vrf_id for o in objs])
        n.preload(DcPrefix, [o.prefix_id for o in objs])
        n.preload(DcInterface, [o.interface_id for o in objs])
        n.preload(DcDevice, [i.device_id for i in (n.get(DcInterface, o.interface_id) for o in objs) if i is not None])
    elif key == "asns":
        n.preload(DcRack, [o.rack_id for o in objs])
        n.preload(Cluster, [o.cluster_id for o in objs])

    used_by_prefix: dict[Any, int] = {}
    if key == "prefixes" and objs:
        used_by_prefix = dict(
            db.query(DcIpAddress.prefix_id, func.count(DcIpAddress.id))
            .filter(DcIpAddress.prefix_id.in_([o.id for o in objs]))
            .group_by(DcIpAddress.prefix_id).all()
        )

    out: list[dict[str, Any]] = []
    for o in objs:
        d = _base(o)
        if key == "halls":
            d["site_name"] = n.attr(DcSite, o.site_id, "name")
        elif key == "rack-rows":
            d["hall_name"] = n.attr(DcHall, o.hall_id, "name")
        elif key == "racks":
            d["row_name"] = n.attr(DcRackRow, o.row_id, "name")
        elif key == "devices":
            d["rack_name"] = n.attr(DcRack, o.rack_id, "name")
            d["device_type_model"] = n.attr(DcDeviceType, o.device_type_id, "model")
            d["cluster_name"] = n.attr(Cluster, o.cluster_id, "name")
            d["u_range"] = validation.u_range_label(o.position_u, o.u_height)
        elif key == "interfaces":
            d["device_hostname"] = n.attr(DcDevice, o.device_id, "hostname")
            d["speed"] = validation.format_speed(o.speed_mbps)
            d["paired_interface_name"] = n.attr(DcInterface, o.paired_interface_id, "name")
            d["parent_interface_name"] = n.attr(DcInterface, o.parent_interface_id, "name")
        elif key == "cables":
            speeds = []
            for side, iid in (("a", o.a_interface_id), ("b", o.b_interface_id)):
                iface = n.get(DcInterface, iid)
                d[f"{side}_interface_name"] = iface.name if iface else None
                d[f"{side}_device_id"] = str(iface.device_id) if iface else None
                d[f"{side}_device_hostname"] = n.attr(DcDevice, iface.device_id, "hostname") if iface else None
                d[f"{side}_speed"] = validation.format_speed(iface.speed_mbps) if iface else None
                speeds.append(iface.speed_mbps if iface else None)
            d["speed_mismatch"] = bool(speeds[0] and speeds[1] and speeds[0] != speeds[1])
        elif key == "prefixes":
            d["cidr"] = str(o.cidr)
            d["gateway"] = str(o.gateway) if o.gateway is not None else None
            d["vrf_name"] = n.attr(DcVrf, o.vrf_id, "name")
            d["rack_name"] = n.attr(DcRack, o.rack_id, "name")
            d["used"] = int(used_by_prefix.get(o.id, 0))
        elif key == "ip-addresses":
            d["address"] = str(o.address)
            d["vrf_name"] = n.attr(DcVrf, o.vrf_id, "name")
            pfx = n.get(DcPrefix, o.prefix_id)
            d["prefix_cidr"] = str(pfx.cidr) if pfx else None
            iface = n.get(DcInterface, o.interface_id)
            d["interface_name"] = iface.name if iface else None
            d["device_id"] = str(iface.device_id) if iface else None
            d["device_hostname"] = n.attr(DcDevice, iface.device_id, "hostname") if iface else None
        elif key == "asns":
            d["rack_name"] = n.attr(DcRack, o.rack_id, "name")
            d["cluster_name"] = n.attr(Cluster, o.cluster_id, "name")
        out.append(d)
    return out


def serialize(db: Session, key: str, obj: Any) -> dict[str, Any]:
    return serialize_many(db, key, [obj])[0]
