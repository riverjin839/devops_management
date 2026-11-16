"""Excel/CSV 일괄 등록 — 미리보기와 확정이 같은 코드로 돈다.

방식: 파일의 행을 시트 순서대로 **실제 쓰기 경로**(``crud``)에 태워 한 트랜잭션 안에서 적용한다.
행마다 SAVEPOINT 를 써서 오류 행은 되돌리고 계속 진행하므로 오류를 한 번에 전부 모을 수 있고,
앞 행이 만든 장비·랙을 뒤 행이 참조할 수 있다(파일 내부 검증 + 기존 DB 검증이 한 번에 된다).

- 미리보기: 끝나면 항상 ``rollback`` — DB 는 바뀌지 않는다.
- 확정: 오류가 0 이면 ``commit``, 하나라도 있으면 ``rollback``(전부 되돌림).
- upsert: 키 열로 기존 행을 찾아 있으면 바뀐 열만 수정, 없으면 추가. 파일에 없는 행은 지우지 않는다.
- 비교는 ``exporter.row_repr`` · ``exporter.normalize`` 로 하므로 내보낸 파일을 다시 올리면 전부 "변경 없음" 이다.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import uuid
from typing import Any, Callable

from openpyxl import load_workbook
from pydantic import ValidationError
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
from app.schemas.dc_inventory import CREATE, UPDATE
from app.services.dc_inventory import crud, exporter, validation
from app.services.dc_inventory.changelog import Ctx
from app.services.dc_inventory.errors import DcError, DcInvalid
from app.services.dc_inventory.exporter import SHEET_BY_NAME, SHEETS, Sheet, normalize

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ROWS_PER_SHEET = 20_000
MAX_ROWS_IN_RESPONSE = 300   # 시트·판정별로 응답에 싣는 행 수 상한(건수는 항상 전체)

Emit = Callable[[str, str], None]


class FileError(Exception):
    """파일 자체를 읽을 수 없다 (413/422)."""

    def __init__(self, detail: str, status_code: int = 422):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def sha256_of(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


# ── 파일 읽기 ────────────────────────────────────────────────────────────────

def _clean_header(value: Any) -> str:
    return str(value).strip().lower() if value is not None else ""


def parse_file(content: bytes, filename: str, sheet_hint: str | None = None) -> dict[str, dict[str, Any]]:
    """파일 → ``{시트: {"header": [...], "rows": [(엑셀 행 번호, {열: 원시값})], "unknown": [...]}}``."""
    if len(content) > MAX_FILE_BYTES:
        raise FileError(f"파일이 너무 큽니다 (최대 {MAX_FILE_BYTES // 1024 // 1024}MB)", 413)
    lower = (filename or "").lower()
    raw: dict[str, list[list[Any]]] = {}
    if lower.endswith(".csv"):
        name = (sheet_hint or lower.rsplit("/", 1)[-1][:-4]).strip().lower()
        if name not in SHEET_BY_NAME:
            raise FileError(
                "CSV 는 시트 하나만 담는다 — 파일 이름을 시트 이름으로 하거나(예: devices.csv) 시트를 지정하세요. "
                f"시트: {', '.join(SHEET_BY_NAME)}")
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("cp949", errors="replace")
        raw[name] = [list(r) for r in csv.reader(io.StringIO(text))]
    elif lower.endswith(".xlsx") or lower.endswith(".xlsm"):
        try:
            wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        except Exception as e:  # noqa: BLE001 — 손상된 파일
            raise FileError(f"Excel 파일을 열 수 없습니다: {str(e)[:160]}") from e
        for ws in wb.worksheets:
            name = ws.title.strip().lower()
            if name in SHEET_BY_NAME:
                raw[name] = [list(r) for r in ws.iter_rows(values_only=True)]
        wb.close()
        if not raw:
            raise FileError(f"알아볼 수 있는 시트가 없습니다. 시트 이름: {', '.join(SHEET_BY_NAME)}")
    else:
        raise FileError("지원하는 형식은 .xlsx 와 .csv 입니다")

    out: dict[str, dict[str, Any]] = {}
    for name, lines in raw.items():
        sheet = SHEET_BY_NAME[name]
        if not lines:
            continue
        header = [_clean_header(h) for h in lines[0]]
        missing = [k for k in sheet.key if k not in header]
        if missing:
            raise FileError(f"{name} 시트에 키 열이 없습니다: {', '.join(missing)}")
        known = set(sheet.column_names)
        rows: list[tuple[int, dict[str, Any]]] = []
        for idx, line in enumerate(lines[1:], start=2):
            cells = {h: (line[i] if i < len(line) else None) for i, h in enumerate(header) if h in known}
            if all(v is None or (isinstance(v, str) and v.strip() == "") for v in cells.values()):
                continue
            rows.append((idx, cells))
        if len(rows) > MAX_ROWS_PER_SHEET:
            raise FileError(f"{name} 시트가 {MAX_ROWS_PER_SHEET:,}행을 넘습니다", 413)
        out[name] = {
            "header": [h for h in header if h in known],
            "unknown": [h for h in header if h and h not in known],
            "rows": rows,
        }
    return out


# ── 실행 맥락 ────────────────────────────────────────────────────────────────

class _Cx:
    """일괄 등록 1회의 캐시 — 이름으로 참조를 풀고, 방금 만든 행도 뒤 행이 찾을 수 있게 한다."""

    def __init__(self, db: Session, ctx: Ctx):
        self.db = db
        self.ctx = ctx
        self.names = exporter.load_names(db)
        self.sites = {o.name: o for o in db.query(DcSite).all()}
        self.halls = {(o.site_id, o.name): o for o in db.query(DcHall).all()}
        self.rows = {(o.hall_id, o.name): o for o in db.query(DcRackRow).all()}
        self.racks = {o.name: o for o in db.query(DcRack).all()}
        self.types = {o.model: o for o in db.query(DcDeviceType).all()}
        self.devices = {o.hostname: o for o in db.query(DcDevice).all()}
        self.ifaces = {(o.device_id, o.name): o for o in db.query(DcInterface).all()}
        self.cables = {o.label: o for o in db.query(DcCable).all() if o.label}
        self.vrfs = {o.name: o for o in db.query(DcVrf).all()}
        self.prefixes = {(o.vrf_id, exporter.normalize("cidr", str(o.cidr))): o for o in db.query(DcPrefix).all()}
        self.ips = {(o.vrf_id, exporter.normalize("ip", str(o.address))): o for o in db.query(DcIpAddress).all()}
        self.asns = {int(o.number): o for o in db.query(DcAsn).all()}
        self.clusters = {o.name: o for o in db.query(Cluster).all()}
        self.devices_with_interface_rows: set[str] = set()
        self.implicit: list[str] = []
        self.pending: list[Callable[[], None]] = []   # 행 성공 뒤에만 반영할 캐시 갱신

    def remember(self, obj: Any) -> None:
        self.names._cache[(type(obj), obj.id)] = obj

    # 이름 → 행 (없으면 사유를 담아 거부)
    def rack(self, name: Any) -> DcRack | None:
        if name is None:
            return None
        obj = self.racks.get(name)
        if obj is None:
            raise DcInvalid(f"랙 {name} 이(가) 없습니다 (racks 시트에도 없음)", code="reference_not_found",
                            column="rack")
        return obj

    def device(self, hostname: Any, column: str = "device") -> DcDevice:
        obj = self.devices.get(hostname)
        if obj is None:
            raise DcInvalid(f"장비 {hostname} 이(가) 없습니다 (devices 시트에도 없음)",
                            code="reference_not_found", column=column)
        return obj

    def iface(self, hostname: Any, name: Any, column: str) -> DcInterface:
        dev = self.device(hostname, column.replace("interface", "device"))
        obj = self.ifaces.get((dev.id, name))
        if obj is None:
            raise DcInvalid(f"{hostname} 에 {name} 인터페이스가 없습니다", code="reference_not_found",
                            column=column)
        return obj

    def cluster(self, name: Any) -> Cluster | None:
        if name is None:
            return None
        obj = self.clusters.get(name)
        if obj is None:
            raise DcInvalid(f"클러스터 {name} 이(가) 등록돼 있지 않습니다", code="reference_not_found",
                            column="cluster")
        return obj

    def dtype(self, model: Any) -> DcDeviceType | None:
        if model is None:
            return None
        obj = self.types.get(model)
        if obj is None:
            raise DcInvalid(f"장비 종류 {model} 이(가) 없습니다 (device_types 시트에도 없음)",
                            code="reference_not_found", column="device_type")
        return obj

    def vrf(self, name: Any) -> DcVrf:
        if name is None:
            raise DcInvalid("vrf 는 필수입니다", code="missing", column="vrf")
        obj = self.vrfs.get(name)
        if obj is None:
            obj = crud.create(self.db, "vrfs", {"name": name}, self.ctx)
            self._later(lambda: (self.vrfs.__setitem__(name, obj), self.remember(obj),
                                 self.implicit.append(f"VRF {name}")))
            self.vrfs[name] = obj  # 같은 행 안에서도 다시 찾을 수 있게
        return obj

    def rack_row(self, site: Any, hall: Any, row: Any) -> DcRackRow:
        if row is None:
            raise DcInvalid("row(랙 열)는 필수입니다", code="missing", column="row")
        site = site or "DC"
        hall = hall or "Hall-1"
        s = self.sites.get(site)
        if s is None:
            s = crud.create(self.db, "sites", {"name": site}, self.ctx)
            self.sites[site] = s
            self._later(lambda: (self.remember(s), self.implicit.append(f"사이트 {site}")))
        h = self.halls.get((s.id, hall))
        if h is None:
            h = crud.create(self.db, "halls", {"site_id": s.id, "name": hall}, self.ctx)
            self.halls[(s.id, hall)] = h
            self._later(lambda: (self.remember(h), self.implicit.append(f"홀 {hall}")))
        r = self.rows.get((h.id, row))
        if r is None:
            r = crud.create(self.db, "rack-rows", {"hall_id": h.id, "name": row}, self.ctx)
            self.rows[(h.id, row)] = r
            self._later(lambda: (self.remember(r), self.implicit.append(f"랙 열 {row}")))
        return r

    def _later(self, fn: Callable[[], None]) -> None:
        self.pending.append(fn)


def _purge_stale(cx: _Cx) -> None:
    """행이 실패해 SAVEPOINT 가 되돌려졌을 때, 그 행이 캐시에 넣어 둔 미완성 객체를 치운다."""
    from sqlalchemy import inspect as sa_inspect

    for cache in (cx.sites, cx.halls, cx.rows, cx.vrfs):
        for k in [k for k, v in cache.items() if sa_inspect(v).transient or sa_inspect(v).detached]:
            del cache[k]


# ── 열 → 필드 ────────────────────────────────────────────────────────────────

def _fields(cx: _Cx, sheet: Sheet, row: dict[str, Any], changed: set[str], existing: Any) -> dict[str, Any]:
    """바뀐 열(``changed``)을 리소스 필드로 옮긴다. 새 행이면 ``changed`` 는 파일에 있는 열 전부."""
    f: dict[str, Any] = {}
    name = sheet.name

    def has(*cols: str) -> bool:
        return any(c in changed for c in cols)

    def copy(*cols: str) -> None:
        for c in cols:
            if c in changed:
                f[c] = row.get(c)

    if name == "racks":
        copy("name", "rack_no", "position_in_row", "u_height", "power_note", "status", "description")
        if existing is None or has("site", "hall", "row"):
            f["row_id"] = cx.rack_row(row.get("site"), row.get("hall"), row.get("row")).id
    elif name == "device_types":
        copy("model", "vendor", "u_height", "is_full_depth", "default_role")
        if "interface_templates" in changed:
            raw = row.get("interface_templates")
            f["interface_templates"] = json.loads(raw) if raw else None
    elif name == "devices":
        copy("hostname", "role", "position_u", "face", "status", "serial", "asset_tag", "k8s_node_name",
             "description")
        if "device_type" in changed:
            dt = cx.dtype(row.get("device_type"))
            f["device_type_id"] = dt.id if dt else None
        if "rack" in changed:
            rack = cx.rack(row.get("rack"))
            f["rack_id"] = rack.id if rack else None
        if "cluster" in changed:
            cl = cx.cluster(row.get("cluster"))
            f["cluster_id"] = cl.id if cl else None
        if existing is None:
            f["create_interfaces_from_template"] = row.get("hostname") not in cx.devices_with_interface_rows
    elif name == "interfaces":
        copy("name", "purpose", "mac", "enabled", "description")
        if existing is None:
            f["device_id"] = cx.device(row.get("device")).id
        if "speed" in changed:
            f["speed_mbps"] = validation.parse_speed(row.get("speed"))
        # paired_with / parent 는 같은 시트의 뒤 행을 가리킬 수 있어 시트가 끝난 뒤 따로 건다.
    elif name == "cables":
        copy("label", "status", "cable_type", "length_m", "description")
        if existing is None or has("a_device", "a_interface"):
            f["a_interface_id"] = cx.iface(row.get("a_device"), row.get("a_interface"), "a_interface").id
        if existing is None or has("b_device", "b_interface"):
            f["b_interface_id"] = cx.iface(row.get("b_device"), row.get("b_interface"), "b_interface").id
    elif name == "prefixes":
        copy("cidr", "purpose", "gateway", "description")
        if existing is None:
            f["vrf_id"] = cx.vrf(row.get("vrf")).id
        if "rack" in changed:
            rack = cx.rack(row.get("rack"))
            f["rack_id"] = rack.id if rack else None
    elif name == "ip_addresses":
        copy("address", "role", "dns_name", "description")
        if existing is None:
            vrf = cx.vrf(row.get("vrf"))
            prefix = validation.find_prefix_for(cx.db, vrf.id, row.get("address"))
            if prefix is None:
                raise DcInvalid(f"{row.get('address')} 는 VRF {vrf.name} 의 어느 Prefix 에도 속하지 않습니다",
                                code="ip_out_of_prefix", column="address")
            f["prefix_id"] = prefix.id
        if existing is None or has("device", "interface"):
            if row.get("device") or row.get("interface"):
                f["interface_id"] = cx.iface(row.get("device"), row.get("interface"), "interface").id
            else:
                f["interface_id"] = None
    elif name == "asns":
        copy("number", "target_type", "fabric_tier", "description")
        if "rack" in changed:
            rack = cx.rack(row.get("rack"))
            f["rack_id"] = rack.id if rack else None
        if "cluster" in changed:
            cl = cx.cluster(row.get("cluster"))
            f["cluster_id"] = cl.id if cl else None
    return f


def _existing(cx: _Cx, sheet: Sheet, row: dict[str, Any]) -> Any:
    name = sheet.name
    if name == "racks":
        return cx.racks.get(row.get("name"))
    if name == "device_types":
        return cx.types.get(row.get("model"))
    if name == "devices":
        return cx.devices.get(row.get("hostname"))
    if name == "interfaces":
        dev = cx.devices.get(row.get("device"))
        return cx.ifaces.get((dev.id, row.get("name"))) if dev is not None else None
    if name == "cables":
        return cx.cables.get(row.get("label"))
    if name == "prefixes":
        vrf = cx.vrfs.get(row.get("vrf"))
        return cx.prefixes.get((vrf.id, row.get("cidr"))) if vrf is not None else None
    if name == "ip_addresses":
        vrf = cx.vrfs.get(row.get("vrf"))
        return cx.ips.get((vrf.id, row.get("address"))) if vrf is not None else None
    if name == "asns":
        return cx.asns.get(row.get("number"))
    return None


def _remember_new(cx: _Cx, sheet: Sheet, row: dict[str, Any], obj: Any) -> None:
    name = sheet.name
    cx.remember(obj)
    if name == "racks":
        cx.racks[obj.name] = obj
    elif name == "device_types":
        cx.types[obj.model] = obj
    elif name == "devices":
        cx.devices[obj.hostname] = obj
        for iface in cx.db.query(DcInterface).filter(DcInterface.device_id == obj.id).all():
            cx.ifaces[(obj.id, iface.name)] = iface
            cx.remember(iface)
    elif name == "interfaces":
        cx.ifaces[(obj.device_id, obj.name)] = obj
    elif name == "cables":
        if obj.label:
            cx.cables[obj.label] = obj
    elif name == "prefixes":
        cx.prefixes[(obj.vrf_id, normalize("cidr", str(obj.cidr)))] = obj
    elif name == "ip_addresses":
        cx.ips[(obj.vrf_id, normalize("ip", str(obj.address)))] = obj
    elif name == "asns":
        cx.asns[int(obj.number)] = obj


_PYDANTIC_KO = {
    "missing": "필수 값입니다",
    "int_parsing": "정수여야 합니다",
    "float_parsing": "숫자여야 합니다",
    "bool_parsing": "true/false 여야 합니다",
    "string_too_long": "값이 너무 깁니다",
    "string_too_short": "값이 비어 있습니다",
    "uuid_parsing": "참조를 찾을 수 없습니다",
}
_FIELD_TO_COLUMN = {
    "device_type_id": "device_type", "rack_id": "rack", "cluster_id": "cluster", "row_id": "row",
    "speed_mbps": "speed", "vrf_id": "vrf", "prefix_id": "address", "interface_id": "interface",
    "a_interface_id": "a_interface", "b_interface_id": "b_interface", "device_id": "device",
}


def _pydantic_errors(e: ValidationError) -> list[dict[str, Any]]:
    out = []
    for err in e.errors():
        field = str(err["loc"][0]) if err.get("loc") else ""
        kind = err.get("type", "")
        if kind == "literal_error":
            expected = (err.get("ctx") or {}).get("expected", "")
            msg = f"허용값이 아닙니다 — {expected.replace(' or ', ', ')}"
        else:
            msg = _PYDANTIC_KO.get(kind) or err.get("msg", "값이 올바르지 않습니다")
        out.append({"column": _FIELD_TO_COLUMN.get(field, field), "code": kind or "invalid", "message": msg})
    return out


def _summary(sheet: Sheet, row: dict[str, Any]) -> str:
    parts = [str(row[c]) for c in sheet.column_names if c not in sheet.key and row.get(c) is not None]
    return " · ".join(parts)[:200]


# ── 실행 ─────────────────────────────────────────────────────────────────────

def _process_row(cx: _Cx, sheet: Sheet, header: list[str], raw: dict[str, Any]) -> dict[str, Any]:
    """한 행을 적용한다 — 호출자가 SAVEPOINT 로 감싼다. 반환은 판정 dict(행 번호·키는 호출자가 붙인다)."""
    row = {c: normalize(sheet.type_of(c), raw.get(c), column=c) for c in header}
    for k in sheet.key:
        if row.get(k) is None:
            raise DcInvalid(f"{k} 는 필수입니다(키 열)", code="missing", column=k)
    existing = _existing(cx, sheet, row)
    non_key = [c for c in header if c not in sheet.key]
    deferred = [c for c in ("paired_with", "parent") if sheet.name == "interfaces" and c in header]

    if existing is None:
        fields = _fields(cx, sheet, row, set(header), None)
        payload = CREATE[sheet.resource].model_validate(fields).model_dump()
        local = Ctx(actor=cx.ctx.actor, source="import", batch_id=cx.ctx.batch_id)
        obj = crud.create(cx.db, sheet.resource, payload, local)
        cx.pending.append(lambda: _remember_new(cx, sheet, row, obj))
        return {"action": "insert", "summary": _summary(sheet, row), "warnings": local.warnings,
                "_obj": obj, "_deferred": {c: row.get(c) for c in deferred if row.get(c) is not None}}

    current = exporter.row_repr(cx.names, sheet.name, existing)
    changed = {c for c in non_key if c not in deferred and current.get(c) != row.get(c)}
    deferred_changed = {c: row.get(c) for c in deferred if current.get(c) != row.get(c)}
    if not changed and not deferred_changed:
        return {"action": "skip"}
    # 목록 형태 — 프론트 axios 가 응답 키를 camelCase 로 바꾸므로 열 이름을 키로 쓰면 깨진다.
    changes = [{"column": c, "old": current.get(c), "new": row.get(c)}
               for c in sorted(changed | set(deferred_changed))]
    local = Ctx(actor=cx.ctx.actor, source="import", batch_id=cx.ctx.batch_id)
    if changed:
        fields = _fields(cx, sheet, row, changed, existing)
        payload = UPDATE[sheet.resource].model_validate(fields).model_dump(exclude_unset=True)
        payload.pop("version", None)
        crud.update(cx.db, sheet.resource, existing.id, payload, local)
    return {"action": "update", "changes": changes, "warnings": local.warnings,
            "_obj": existing, "_deferred": deferred_changed}


def _apply_deferred(cx: _Cx, links: list[tuple[int, str, Any, dict[str, Any]]], result_rows: dict[int, dict]) -> int:
    """interfaces 시트의 paired_with / parent — 대상 포트가 모두 만들어진 뒤에 건다."""
    errors = 0
    for rownum, key, obj, wanted in links:
        try:
            with cx.db.begin_nested():
                data: dict[str, Any] = {}
                for col, field in (("paired_with", "paired_interface_id"), ("parent", "parent_interface_id")):
                    if col not in wanted:
                        continue
                    target_name = wanted[col]
                    if target_name is None:
                        data[field] = None
                        continue
                    target = cx.ifaces.get((obj.device_id, target_name))
                    if target is None:
                        raise DcInvalid(f"같은 장비에 {target_name} 포트가 없습니다", code="reference_not_found",
                                        column=col)
                    data[field] = target.id
                if data:
                    crud.update(cx.db, "interfaces", obj.id, data,
                                Ctx(actor=cx.ctx.actor, source="import", batch_id=cx.ctx.batch_id))
        except DcError as e:
            errors += 1
            entry = result_rows.setdefault(rownum, {"row": rownum, "key": key})
            entry["action"] = "error"
            entry["errors"] = [{"column": e.column or "", "code": e.code, "message": e.detail}]
    return errors


def run(db: Session, content: bytes, filename: str, *, actor: Any, apply: bool,
        sheet_hint: str | None = None, only_sheets: list[str] | None = None,
        emit: Emit | None = None) -> dict[str, Any]:
    """파일을 적용해 본다. ``apply`` 가 False 면 항상 되돌린다. 커밋·롤백까지 여기서 끝낸다."""
    def say(level: str, message: str) -> None:
        if emit is not None:
            emit(level, message)

    parsed = parse_file(content, filename, sheet_hint)
    wanted = [s for s in SHEETS if s.name in parsed and (not only_sheets or s.name in only_sheets)]
    total_rows = sum(len(parsed[s.name]["rows"]) for s in wanted)
    say("info", f"파일 읽기  {filename} — 시트 {len(wanted)}개, {total_rows:,}행")

    batch_id = str(uuid.uuid4())
    ctx = Ctx(actor=actor, source="import", batch_id=batch_id)
    summary = {"insert": 0, "update": 0, "skip": 0, "error": 0}
    sheets_out: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        cx = _Cx(db, ctx)
        if "interfaces" in parsed:
            for _, cells in parsed["interfaces"]["rows"]:
                dev = cells.get("device")
                if dev not in (None, ""):
                    cx.devices_with_interface_rows.add(str(dev).strip())
        for sheet in wanted:
            data = parsed[sheet.name]
            header: list[str] = data["header"]
            counts = {"insert": 0, "update": 0, "skip": 0, "error": 0}
            rows_out: dict[int, dict[str, Any]] = {}
            seen: dict[tuple, int] = {}
            links: list[tuple[int, str, Any, dict[str, Any]]] = []
            if data["unknown"]:
                warnings.append(f"{sheet.name}: 알 수 없는 열을 건너뜀 — {', '.join(data['unknown'])}")
            for rownum, raw in data["rows"]:
                key_text = " / ".join(str(raw.get(k) if raw.get(k) is not None else "") for k in sheet.key).strip()
                cx.pending = []
                try:
                    key_tuple = tuple(normalize(sheet.type_of(k), raw.get(k), column=k) for k in sheet.key)
                    if key_tuple in seen:
                        raise DcInvalid(f"같은 파일 {seen[key_tuple]}행과 키가 같습니다", code="duplicate_in_file",
                                        column=sheet.key[-1])
                    with db.begin_nested():
                        res = _process_row(cx, sheet, header, raw)
                    seen[key_tuple] = rownum
                    for fn in cx.pending:
                        fn()
                except ValidationError as e:
                    res = {"action": "error", "errors": _pydantic_errors(e)}
                    _purge_stale(cx)
                except DcError as e:
                    res = {"action": "error",
                           "errors": [{"column": e.column or "", "code": e.code, "message": e.detail}]}
                    _purge_stale(cx)
                except (ValueError, TypeError) as e:
                    res = {"action": "error", "errors": [{"column": "", "code": "invalid", "message": str(e)[:200]}]}
                    _purge_stale(cx)
                obj = res.pop("_obj", None)
                deferred = res.pop("_deferred", None)
                if deferred and obj is not None:
                    links.append((rownum, key_text, obj, deferred))
                if res["action"] != "skip":
                    rows_out[rownum] = {"row": rownum, "key": key_text, **res}
                else:
                    counts["skip"] += 1
            if links:
                _apply_deferred(cx, links, rows_out)
            for entry in rows_out.values():
                counts[entry["action"]] += 1
                if entry["action"] == "error":
                    for err in entry["errors"]:
                        say("error", f"  {sheet.name} {entry['row']}행 {entry['key']}: {err['message']}")
                for w in entry.get("warnings") or []:
                    warnings.append(f"{sheet.name} {entry['row']}행: {w}")
            ordered = sorted(rows_out.values(), key=lambda r: ({"error": 0, "update": 1, "insert": 2}[r["action"]], r["row"]))
            shown: list[dict[str, Any]] = []
            per_action: dict[str, int] = {}
            for entry in ordered:
                per_action[entry["action"]] = per_action.get(entry["action"], 0) + 1
                if per_action[entry["action"]] <= MAX_ROWS_IN_RESPONSE:
                    shown.append(entry)
            for k, v in counts.items():
                summary[k] += v
            sheets_out.append({
                "name": sheet.name, "total": len(data["rows"]), **counts,
                "rows": shown, "truncated": len(shown) < len(ordered),
            })
            say("error" if counts["error"] else "info",
                f"{sheet.name:<13} {len(data['rows']):,}행 · 추가 {counts['insert']:,} · 변경 {counts['update']:,} · "
                f"변경 없음 {counts['skip']:,} · 오류 {counts['error']:,}")

        ok = summary["error"] == 0
        applied = False
        if apply and ok:
            db.commit()
            applied = True
            say("info", f"확정 — 추가 {summary['insert']:,} · 변경 {summary['update']:,} 을(를) 반영했다.")
        else:
            db.rollback()
            if apply:
                say("error", f"오류 {summary['error']:,}건 — 아무것도 반영하지 않고 전부 되돌렸다.")
            else:
                say("info" if ok else "error",
                    f"검증 끝 — 오류 {summary['error']:,}건. DB 는 바뀌지 않았다.")
        return {
            "sha256": sha256_of(content), "filename": filename, "ok": ok, "applied": applied,
            "batch_id": batch_id if applied else None, "summary": summary, "sheets": sheets_out,
            "implicit_created": cx.implicit, "warnings": warnings[:200],
        }
    except Exception:
        db.rollback()
        raise
