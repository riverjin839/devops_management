#!/usr/bin/env python3
"""DC 인벤토리 일괄 등록 검증 — 원본 Excel 과 PEP 가 내보낸 Excel 을 행 단위로 비교한다.

원본의 모든 행이 내보낸 파일에 같은 값으로 있어야 통과한다(원본에 있는 열만 비교). 내보낸 파일에만
있는 행은 기본적으로 허용하고(일괄 등록은 upsert — 기존 행을 지우지 않는다), ``--strict`` 면 그것도 실패다.

    # 1) 원본을 /dc-inventory ▸ 일괄 등록으로 반영한 뒤
    # 2) 내보낸 파일과 비교
    python3 scripts/dc_inventory/verify_import.py --original seed.xlsx --exported export.xlsx

    # 또는 API 에서 바로 받아 비교 (토큰은 환경변수로)
    PEP_TOKEN=... python3 scripts/dc_inventory/verify_import.py --original seed.xlsx \\
        --api http://localhost:8000/api/v1

종료 코드: 0 = 일치, 1 = 불일치, 2 = 사용법·파일 오류.
"""
from __future__ import annotations

import argparse
import io
import ipaddress
import json
import os
import re
import sys
import urllib.request

# 시트 → 키 열. backend/app/services/dc_inventory/exporter.py 의 SHEETS 와 같아야 한다.
KEYS: dict[str, tuple[str, ...]] = {
    "racks": ("name",), "device_types": ("model",), "devices": ("hostname",), "interfaces": ("device", "name"),
    "cables": ("label",), "prefixes": ("vrf", "cidr"), "ip_addresses": ("vrf", "address"), "asns": ("number",),
}
_SPEED = re.compile(r"^(\d+(?:\.\d+)?)\s*([GgMm])$")


def _norm(column: str, value):
    """표기 차이(25g/25G, 21.0/21, true/TRUE)를 없앤 비교용 값."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    if text == "":
        return None
    if column == "speed":
        m = _SPEED.match(text)
        if m:
            mbps = float(m.group(1)) * (1000 if m.group(2).upper() == "G" else 1)
            return f"{int(mbps) // 1000}G" if mbps % 1000 == 0 else f"{int(mbps)}M"
    if column == "cidr":
        try:
            return str(ipaddress.ip_network(text, strict=False))
        except ValueError:
            return text
    if column in ("address", "gateway"):
        try:
            return str(ipaddress.ip_interface(text).ip)
        except ValueError:
            return text
    if column == "interface_templates":
        try:
            return json.dumps(json.loads(text), sort_keys=True, ensure_ascii=False)
        except ValueError:
            return text
    if column == "length_m":
        try:
            return str(float(text))
        except ValueError:
            return text
    if text.lower() in ("true", "false"):
        return text.lower()
    return text


def load(content: bytes) -> dict[str, dict[tuple, dict]]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    out: dict[str, dict[tuple, dict]] = {}
    for ws in wb.worksheets:
        name = ws.title.strip().lower()
        if name not in KEYS:
            continue
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        header = [str(h).strip().lower() if h is not None else "" for h in rows[0]]
        table: dict[tuple, dict] = {}
        for line in rows[1:]:
            row = {h: _norm(h, line[i] if i < len(line) else None) for i, h in enumerate(header) if h}
            if all(v is None for v in row.values()):
                continue
            table[tuple(row.get(k) for k in KEYS[name])] = row
        out[name] = table
    wb.close()
    return out


def compare(original: dict, exported: dict, *, strict: bool = False, limit: int = 20) -> tuple[bool, list[str]]:
    lines: list[str] = []
    ok = True
    for sheet, rows in original.items():
        theirs = exported.get(sheet, {})
        missing = [k for k in rows if k not in theirs]
        diffs: list[str] = []
        for key, row in rows.items():
            other = theirs.get(key)
            if other is None:
                continue
            for column, value in row.items():
                if other.get(column) != value:
                    diffs.append(f"    {' / '.join(map(str, key))} · {column}: 원본 {value!r} ≠ 내보냄 {other.get(column)!r}")
        extra = [k for k in theirs if k not in rows]
        bad = bool(missing or diffs or (strict and extra))
        ok = ok and not bad
        lines.append(f"{'불일치' if bad else '일치  '} {sheet:<13} 원본 {len(rows):>5,}행 · 누락 {len(missing)} · "
                     f"값 다름 {len(diffs)} · 내보낸 쪽에만 {len(extra)}")
        for key in missing[:limit]:
            lines.append(f"    누락: {' / '.join(map(str, key))}")
        lines.extend(diffs[:limit])
        if strict:
            for key in extra[:limit]:
                lines.append(f"    내보낸 쪽에만: {' / '.join(map(str, key))}")
    return ok, lines


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--original", required=True, help="일괄 등록에 올린 원본 .xlsx")
    ap.add_argument("--exported", help="PEP 가 내보낸 .xlsx (GET /dc/export.xlsx)")
    ap.add_argument("--api", help="내보내기를 직접 받을 API 주소 (예: http://localhost:8000/api/v1). 토큰은 PEP_TOKEN")
    ap.add_argument("--strict", action="store_true", help="내보낸 쪽에만 있는 행도 불일치로 본다")
    args = ap.parse_args()
    try:
        with open(args.original, "rb") as f:
            original = load(f.read())
        if args.exported:
            with open(args.exported, "rb") as f:
                exported = load(f.read())
        elif args.api:
            req = urllib.request.Request(args.api.rstrip("/") + "/dc/export.xlsx")
            token = os.environ.get("PEP_TOKEN")
            if token:
                req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 — 운영자가 지정한 내부 주소
                exported = load(resp.read())
        else:
            ap.error("--exported 또는 --api 중 하나가 필요하다")
    except OSError as e:
        print(f"파일·API 를 읽지 못했다: {e}", file=sys.stderr)
        return 2
    ok, lines = compare(original, exported, strict=args.strict)
    print("\n".join(lines))
    print("결과: 원본과 행 단위로 일치" if ok else "결과: 불일치")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
