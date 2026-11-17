"""서버 일괄 등록 — 현업 엑셀(한 줄 = 서버 1대)을 그대로 받아 DC 인벤토리에 넣는다.

열(한글 헤더, 흔한 변형·오타 허용 — ``HEADER_ALIASES``):
    서버구성 · 서버환경 · 호스트명 · 서버용도 · OS버전 · NW설정 · 이중화 · DC 위치 · RACK 열 · 랙 No. · 하단 위치 (+ 선택: 높이(U))

입력은 Excel/CSV 파일 또는 엑셀에서 복사해 붙여넣은 표(행 목록)다. 둘 다 ``rows: list[list]`` 로 바꾼 뒤
``to_parsed`` 가 일괄 등록 엔진(``importer.run_parsed``)의 ``racks``·``devices`` 시트 형식으로 옮긴다 —
검증·미리보기·전체 롤백·변경 이력·실시간 로그가 전체 양식 일괄 등록과 같은 코드로 돈다.

위치 규칙:
- DC 위치 = "DC 이름 + 구간" (예: ``DC1 2층 A구역``) — 첫 단어가 DC, 나머지가 구간. 한 단어면 구간은 ``기본 구간``.
- 랙 이름 = ``{RACK 열}-{랙 No.}`` (열이 비면 랙 No. 그대로). 랙 이름은 DC 전체에서 유일하다.
- 없는 DC·구간·열·랙은 만들고, 이미 있는 랙의 위치는 바꾸지 않는다(다르면 경고만).
- 하단 위치는 ``U21`` · ``21`` · ``21U`` · ``U21-U22`` 를 모두 21 로 읽는다.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from sqlalchemy.orm import Session

from app.models.dc_inventory import DcHall, DcRack, DcRackRow, DcSite
from app.services.dc_inventory.device_registry import parse_rack_unit
from app.services.dc_inventory.importer import MAX_FILE_BYTES, FileError

MAX_ROWS = 5000
DEFAULT_ZONE = "기본 구간"

# 표준 키 → (화면 표기, 허용 헤더 목록). 비교는 공백·점·괄호·대소문자를 지운 값으로 한다.
COLUMNS: list[tuple[str, str, tuple[str, ...]]] = [
    ("server_config", "서버구성", ("서버구성", "서버 구성", "구성", "serverconfig", "hw", "하드웨어")),
    ("environment", "서버환경", ("서버환경", "서버 환경", "환경", "env", "environment")),
    ("hostname", "호스트명", ("호스트명", "호스트 명", "호스트", "hostname", "host", "서버명")),
    ("purpose", "서버용도", ("서버용도", "서버 용도", "용도", "purpose", "usage")),
    ("os_version", "OS버전", ("os버전", "os 버전", "os", "osversion", "운영체제")),
    ("network_config", "NW설정", ("nw설정", "nw 설정", "네트워크설정", "네트워크", "network", "nw")),
    ("redundancy", "이중화", ("이중화", "이증화", "redundancy", "ha")),
    ("dc_location", "DC 위치", ("dc위치", "dc 위치", "dc", "위치", "location")),
    ("rack_row", "RACK 열", ("rack열", "rack 열", "랙열", "랙 열", "열", "row")),
    ("rack_no", "랙 No.", ("랙no", "랙 no.", "랙no.", "랙번호", "랙 번호", "rackno", "rack no", "rack", "랙")),
    ("position", "하단 위치", ("하단위치", "하단 위치", "하단", "시작u", "u", "position")),
    ("u_height", "높이(U)", ("높이(u)", "높이", "u높이", "height", "uheight")),
]
LABEL = {key: label for key, label, _ in COLUMNS}
REQUIRED = ("hostname",)
TEXT_FIELDS = ("server_config", "environment", "purpose", "os_version", "network_config", "redundancy")


def _norm(text: Any) -> str:
    return re.sub(r"[\s.()\[\]_\-/]", "", str(text or "")).lower()


_ALIASES: dict[str, str] = {}
for _key, _label, _names in COLUMNS:
    for _n in (_label, *_names):
        _ALIASES[_norm(_n)] = _key


def _cell(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s or None


# ── 입력 읽기 ────────────────────────────────────────────────────────────────

def rows_from_file(content: bytes, filename: str) -> list[list[Any]]:
    """Excel(첫 시트 — 헤더에 '호스트명' 이 있는 시트 우선) 또는 CSV → 행 목록."""
    if len(content) > MAX_FILE_BYTES:
        raise FileError(f"파일이 너무 큽니다 (최대 {MAX_FILE_BYTES // 1024 // 1024}MB)", 413)
    lower = (filename or "").lower()
    if lower.endswith(".csv") or lower.endswith(".tsv") or lower.endswith(".txt"):
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("cp949", errors="replace")
        # 머리글 위에 제목 줄이 있을 수 있어 앞쪽 10줄에서 탭을 찾는다.
        delim = "\t" if any("\t" in line for line in text.splitlines()[:10]) else ","
        return [list(r) for r in csv.reader(io.StringIO(text), delimiter=delim)]
    if lower.endswith(".xlsx") or lower.endswith(".xlsm"):
        try:
            wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        except Exception as e:  # noqa: BLE001 — 손상된 파일
            raise FileError(f"Excel 파일을 열 수 없습니다: {str(e)[:160]}") from e
        try:
            sheets = [[list(r) for r in ws.iter_rows(values_only=True)] for ws in wb.worksheets]
        finally:
            wb.close()
        for rows in sheets:
            if _find_header(rows) is not None:
                return rows
        return sheets[0] if sheets else []
    raise FileError("지원하는 형식은 .xlsx · .csv 입니다 (엑셀에서 복사해 붙여넣어도 됩니다)")


def _find_header(rows: list[list[Any]]) -> int | None:
    """위에서 10줄 안에 '호스트명' 열이 있는 줄을 헤더로 본다(제목 줄이 위에 있는 엑셀 대비)."""
    for i, line in enumerate(rows[:10]):
        if any(_ALIASES.get(_norm(c)) == "hostname" for c in line if c is not None):
            return i
    return None


def interpret(rows: list[list[Any]]) -> dict[str, Any]:
    """행 목록 → 헤더 매핑 + 서버 행. 화면에 "어느 열을 무엇으로 읽었는지" 그대로 보여 주기 위한 결과."""
    rows = [list(r) for r in rows if r is not None]
    h = _find_header(rows)
    if h is None:
        raise FileError("헤더 줄을 찾지 못했습니다 — 첫 줄에 '호스트명' 열이 있어야 합니다 (양식 받기 참고)")
    header = rows[h]
    mapping: list[dict[str, Any]] = []
    index: dict[str, int] = {}
    for i, raw in enumerate(header):
        name = _cell(raw)
        if name is None:
            continue
        key = _ALIASES.get(_norm(name))
        if key and key not in index:
            index[key] = i
        mapping.append({"column": name, "field": key if key and index.get(key) == i else None,
                        "label": LABEL.get(key or "", None) if key and index.get(key) == i else None})
    servers: list[dict[str, Any]] = []
    for offset, line in enumerate(rows[h + 1:], start=h + 2):
        values = {k: _cell(line[i]) if i < len(line) else None for k, i in index.items()}
        if all(v is None for v in values.values()):
            continue
        servers.append({"row": offset, **values})
    if len(servers) > MAX_ROWS:
        raise FileError(f"한 번에 {MAX_ROWS:,}대까지 등록할 수 있습니다", 413)
    return {"header_row": h + 1, "columns": mapping, "missing": [LABEL[k] for k in REQUIRED if k not in index],
            "present": sorted(index, key=lambda k: index[k]), "servers": servers}


def fingerprint(rows: list[list[Any]]) -> str:
    """미리보기와 확정이 같은 입력인지 확인하는 값 — 셀 값 기준(서식 무시)."""
    canon = [[_cell(c) for c in r] for r in rows]
    return hashlib.sha256(json.dumps(canon, ensure_ascii=False).encode("utf-8")).hexdigest()


# ── 일괄 등록 엔진 형식으로 ──────────────────────────────────────────────────

def split_location(text: str | None) -> tuple[str | None, str | None]:
    """``DC1 2층 A구역`` → (``DC1``, ``2층 A구역``). 한 단어면 구간은 기본 구간."""
    if not text:
        return None, None
    parts = text.split()
    return parts[0], (" ".join(parts[1:]) or DEFAULT_ZONE)


def rack_name(row: str | None, no: str | None) -> str | None:
    if not no:
        return None
    no = no.strip()
    return f"{row.strip()}-{no}" if row and row.strip() else no


def to_parsed(db: Session, info: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str], list[str]]:
    """서버 행 → ``importer.run_parsed`` 입력(``racks``·``devices`` 시트). (parsed, 새로 만들 위치, 경고) 를 돌려준다."""
    present = set(info["present"])
    existing_racks = {r.name: r for r in db.query(DcRack).all()}
    rows_by_id = {r.id: r for r in db.query(DcRackRow).all()}
    halls = {h.id: h for h in db.query(DcHall).all()}
    sites = {s.id: s for s in db.query(DcSite).all()}

    def location_of(rack: DcRack) -> tuple[str | None, str | None, str | None]:
        row = rows_by_id.get(rack.row_id)
        hall = halls.get(row.hall_id) if row else None
        site = sites.get(hall.site_id) if hall else None
        return (site.name if site else None, hall.name if hall else None, row.name if row else None)

    rack_rows: list[tuple[int, dict[str, Any]]] = []
    rack_seen: dict[str, tuple[int, tuple]] = {}
    device_rows: list[tuple[int, dict[str, Any]]] = []
    created: list[str] = []
    warnings: list[str] = []
    for s in info["servers"]:
        rownum = s["row"]
        dev: dict[str, Any] = {"hostname": s.get("hostname")}
        for f in TEXT_FIELDS:
            if f in present:
                dev[f] = s.get(f)
        if "u_height" in present and s.get("u_height"):
            dev["u_height"] = s.get("u_height")
        error: tuple[str, str] | None = None
        site, zone = split_location(s.get("dc_location"))
        name = rack_name(s.get("rack_row"), s.get("rack_no"))
        if "position" in present:
            raw_u = s.get("position")
            u = parse_rack_unit(raw_u)
            if raw_u and u is None:
                error = ("position", f"하단 위치 '{raw_u}' 를 U 번호로 읽을 수 없습니다 (예: 21, U21)")
            dev["position_u"] = u
        if name:
            dev["rack"] = name
            loc = (site, zone, (s.get("rack_row") or "").strip() or None)
            if name in existing_racks:
                have = location_of(existing_racks[name])
                if site and have[0] and (have[0], have[1]) != (site, zone):
                    warnings.append(f"{rownum}행 {s.get('hostname')}: 랙 {name} 은 이미 {have[0]} {have[1]} 에 있습니다 "
                                    f"— 입력한 위치({site} {zone})로 옮기지 않았습니다")
            elif name in rack_seen:
                first_row, first_loc = rack_seen[name]
                if site and first_loc[0] and first_loc != loc:
                    error = ("dc_location", f"랙 {name} 의 위치가 {first_row}행({' '.join(x for x in first_loc if x)})과 다릅니다 "
                                            "— 랙 이름은 DC 전체에서 유일해야 합니다")
            else:
                if not site:
                    error = ("dc_location", f"새 랙 {name} 을 만들려면 DC 위치가 필요합니다")
                else:
                    rack_seen[name] = (rownum, loc)
                    rack_rows.append((rownum, {
                        "name": name, "site": site, "hall": zone, "row": loc[2] or "A",
                        "u_height": 42, "status": "active",
                    }))
                    created.append(f"랙 {name} ({site} · {zone} · {loc[2] or 'A'}열)")
        elif s.get("position"):
            error = ("rack_no", "하단 위치를 쓰려면 랙 No. 가 필요합니다")
        elif "rack_no" in present:
            dev["rack"] = None
        if not dev.get("hostname"):
            error = ("hostname", "호스트명이 비어 있습니다")
        if error:
            dev["__error"] = error
        device_rows.append((rownum, dev))

    def sheet(rows: list[tuple[int, dict[str, Any]]]) -> dict[str, Any]:
        header: list[str] = []
        for _, cells in rows:
            for k in cells:
                if k != "__error" and k not in header:
                    header.append(k)
        return {"header": header, "unknown": [], "rows": rows}

    parsed: dict[str, dict[str, Any]] = {}
    if rack_rows:
        parsed["racks"] = sheet(rack_rows)
    # 역할 열은 보내지 않는다 — 새 장비는 기본값(server)으로 만들고, 기존 장비의 역할은 건드리지 않는다.
    parsed["devices"] = sheet(device_rows)
    return parsed, created, warnings


# ── 양식 ─────────────────────────────────────────────────────────────────────

GUIDE = (
    ("호스트명", "필수. 이미 있으면 그 장비를 수정하고, 없으면 새 서버로 추가한다. 파일에 없는 서버는 지우지 않는다"),
    ("서버구성 · 서버환경 · 서버용도 · OS버전 · NW설정 · 이중화", "자유 텍스트 — 적은 그대로 저장한다. 빈 칸은 그 값을 지운다"),
    ("서버용도 · OS버전", "노드 서버스펙 화면의 '현재 용도' · 'OS' 와 같은 값이다(한쪽을 고치면 다른 쪽도 바뀐다)"),
    ("DC 위치", "'DC 이름 + 구간' — 예: 'DC1 2층 A구역'. 첫 단어가 DC, 나머지가 구간. 없으면 새로 만든다"),
    ("RACK 열 · 랙 No.", "랙 이름은 '열-번호'(예: A-07)로 만든다. 같은 이름의 랙은 DC 전체에 하나뿐이다"),
    ("하단 위치", "서버가 차지하는 가장 아래 U — 21, U21, 21U 모두 된다. 같은 랙에서 U 가 겹치면 오류"),
    ("높이(U)", "선택. 비우면 1U"),
)
EXAMPLE = [
    ["Dell R750 / 2CPU / 512G", "운영", "node-a-0101", "K8S 워커", "Rocky Linux 9.4", "bond0 25G x2 (LACP)",
     "Active-Active", "DC1 2층 A구역", "A", "07", "U21", 2],
    ["Dell R750 / 2CPU / 512G", "운영", "node-a-0102", "K8S 워커", "Rocky Linux 9.4", "bond0 25G x2 (LACP)",
     "Active-Active", "DC1 2층 A구역", "A", "07", "U23", 2],
]


def template_xlsx() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "서버"
    ws.append([label for _, label, _ in COLUMNS])
    for row in EXAMPLE:
        ws.append(row)
    bold = Font(bold=True)
    for i, cell in enumerate(ws[1], start=1):
        cell.font = bold
        ws.column_dimensions[cell.column_letter].width = 26 if i in (1, 6) else 14
    ws.freeze_panes = "A2"
    guide = wb.create_sheet("설명")
    guide.append(["열", "설명"])
    for c in guide[1]:
        c.font = bold
    for line in GUIDE:
        guide.append(list(line))
    guide.append(["예시 줄", "'서버' 시트의 2·3행은 예시다 — 지우고 쓰거나 그대로 올려 미리보기로 확인해 보세요"])
    guide.column_dimensions["A"].width = 44
    guide.column_dimensions["B"].width = 100
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
